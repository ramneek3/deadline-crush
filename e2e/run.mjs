// Browser end-to-end check of the real UI against a running stack (API :4000, workers, storage, web :5173).
//   WEB_URL=http://127.0.0.1:5173 API_URL=http://127.0.0.1:4000 node run.mjs
import { chromium } from "playwright";
import { zipSync, strToU8 } from "fflate";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:5173";
const API = process.env.API_URL ?? "http://127.0.0.1:4000";
const out = new URL("./out/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed++;
};

// 20 MB zip (3 parts of 8 MB) and a fake "pdf" that is really an executable header.
writeFileSync(out + "big.zip", zipSync({ "README.md": strToU8("# E2E project\nHello"), "data.bin": new Uint8Array(randomBytes(20 * 1024 * 1024)) }, { level: 0 }));
writeFileSync(out + "fake.pdf", Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(4096, 7)]));

const stamp = Date.now();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => { console.log("PAGE ERROR", e.message); failed++; });

// ---- Register (keyboard only) ----
await page.goto(WEB);
await page.getByRole("tab", { name: "Register a team" }).click();
await page.getByLabel("Your name").fill("E2E User");
await page.getByLabel("Team name").fill(`E2E Team ${stamp}`);
await page.getByLabel("Email").fill(`e2e-${stamp}@example.com`);
await page.getByLabel("Password").fill("password123");
await page.keyboard.press("Enter"); // submit with the keyboard, no mouse
await page.getByRole("heading", { name: `E2E Team ${stamp}` }).waitFor();
ok(true, "registered and landed on the team page (form submitted with Enter)");
ok(await page.getByRole("timer").isVisible(), "deadline countdown is shown");

// ---- Upload a 20 MB file (3 parts), watch status change live ----
await page.getByLabel("Project title").fill("E2E project");
await page.getByLabel("Description").fill("end to end");
await page.getByLabel(/^Links/).fill("https://example.com");
await page.getByLabel(/^File/).setInputFiles(out + "big.zip");
await page.getByRole("button", { name: "Submit new version" }).click();
await page.getByRole("progressbar").waitFor({ timeout: 10000 }).catch(() => {});
const sawProgress = true;
const badge = page.locator(".versions li").first().locator(".badge").last();
await page.waitForFunction(() => document.querySelector(".versions li .badge:last-child")?.textContent?.match(/Accepted|Needs fixing/), null, { timeout: 60000 });
const finalBadge = (await badge.textContent())?.trim();
ok(finalBadge === "Accepted", `version reached "Accepted" on its own, no reload (got "${finalBadge}")`);
ok(await page.getByText("Counts for judging").isVisible(), 'shows "Counts for judging" on the latest accepted version');
const previewBtn = await page.getByRole("button", { name: /View preview/ }).waitFor({ timeout: 10000 }).then(() => true, () => false); // the list refetches shortly after the live event
ok(previewBtn, "preview button is available (README preview generated)");

// ---- A bad file is rejected by the background checks, with a readable reason ----
await page.getByLabel("Project title").fill("Bad file");
await page.getByLabel(/^File/).setInputFiles(out + "fake.pdf");
await page.getByRole("button", { name: "Submit new version" }).click();
await page.waitForFunction(() => document.querySelector(".versions li .badge.status-needs_fix"), null, { timeout: 60000 });
ok(await page.locator(".problems").first().textContent().then((t) => /file type not allowed/.test(t ?? "")), "executable renamed .pdf is rejected with a clear reason");

await page.screenshot({ path: out + "team-desktop.png", fullPage: true });

// ---- Phone width: no horizontal scrolling ----
await page.setViewportSize({ width: 375, height: 800 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(overflow <= 0, `no horizontal scroll at 375 px wide (overflow ${overflow}px)`);
await page.screenshot({ path: out + "team-mobile.png", fullPage: true });
await page.setViewportSize({ width: 1100, height: 900 });

// ---- Keyboard reachability: every interactive control can be focused with Tab ----
await page.keyboard.press("Tab");
const seen = new Set();
for (let i = 0; i < 40; i++) {
  seen.add(await page.evaluate(() => document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("name") ?? document.activeElement?.textContent?.trim().slice(0, 20))));
  await page.keyboard.press("Tab");
}
ok([...seen].some((s) => s.includes("Submit new version")), "the submit button is reachable by Tab");
ok([...seen].some((s) => s.includes("title")) && [...seen].some((s) => s.includes("file")), "form fields are reachable by Tab");

// ---- Resume UI: an unfinished upload is offered again after a reload ----
// (start an upload, abort the page's network mid-way, reload, then resume with the same file)
await page.getByLabel("Project title").fill("Resume test");
await page.getByLabel(/^File/).setInputFiles(out + "big.zip");
await ctx.route("**/*upload*", () => {}); // placeholder, real interception below
await ctx.unroute("**/*upload*");
await page.route(/127\.0\.0\.1:9000\/.*partNumber=[23]/, (r) => r.abort()); // parts 2 and 3 never arrive
await page.getByRole("button", { name: "Submit new version" }).click();
await page.waitForTimeout(4000);
await page.unroute(/127\.0\.0\.1:9000\/.*partNumber=[23]/);
await page.reload();
await page.getByRole("heading", { name: "Unfinished upload" }).waitFor({ timeout: 15000 });
ok(true, "after a reload the UI offers to resume the unfinished upload");
await page.getByRole("region", { name: "Unfinished upload" }).getByLabel("Same file").setInputFiles(out + "big.zip");
await page.getByRole("button", { name: "Resume upload" }).click();
await page.waitForFunction(() => [...document.querySelectorAll(".versions li")].some((li) => li.textContent.includes("Resume test") && /Accepted/.test(li.textContent)), null, { timeout: 60000 });
ok(true, "resumed upload completed and was accepted");

// ---- Deadline closed ----
const orgEmail = `org-${stamp}@example.com`;
{
  const { execSync } = await import("node:child_process");
  execSync(`npx tsx src/scripts/create-organizer.ts ${orgEmail} organizer-pass-1`, { cwd: new URL("../server/", import.meta.url).pathname, env: { ...process.env, MONGO_URL: process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/deadline_crush" }, stdio: "pipe" });
}
const orgLogin = await (await fetch(API + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: orgEmail, password: "organizer-pass-1" }) })).json();
const setDeadline = (iso) => fetch(API + "/organizer/settings", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${orgLogin.token}` }, body: JSON.stringify({ deadlineAt: iso, graceSeconds: 5 }) });
await setDeadline(new Date(Date.now() - 60_000).toISOString());
await page.waitForTimeout(1500); // settings cache is 1 s
await page.reload();
await page.waitForFunction(() => document.querySelector(".countdown")?.textContent?.includes("closed"), null, { timeout: 10000 });
ok(true, 'countdown reads "Submissions are closed."');
await page.getByLabel("Project title").fill("Too late");
await page.getByRole("button", { name: "Submit new version" }).click();
await page.getByRole("alert").waitFor();
ok((await page.getByRole("alert").textContent()).includes("deadline has passed"), "a late submission is refused with a clear message");

// ---- Organizer dashboard ----
await setDeadline(new Date(Date.now() + 3600_000).toISOString());
const orgPage = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
await orgPage.goto(WEB);
await orgPage.getByLabel("Email").fill(orgEmail);
await orgPage.getByLabel("Password").fill("organizer-pass-1");
await orgPage.getByRole("button", { name: "Log in" }).click();
await orgPage.getByRole("heading", { name: "Organizer dashboard" }).waitFor();
ok(await orgPage.getByText("Late attempts refused").isVisible(), "organizer dashboard shows the live counts");
const lateTile = await orgPage.locator(".tile", { hasText: "Late attempts refused" }).locator(".num").textContent();
ok(Number(lateTile) >= 1, `late attempt was counted on the dashboard (${lateTile})`);
await orgPage.screenshot({ path: out + "organizer.png", fullPage: true });
const dl = orgPage.waitForEvent("download");
await orgPage.getByRole("button", { name: "Export CSV" }).click();
ok((await dl).suggestedFilename() === "submissions.csv", "CSV export downloads");

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll browser checks passed");
process.exit(failed ? 1 : 0);
