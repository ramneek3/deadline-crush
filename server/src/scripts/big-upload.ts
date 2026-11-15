/**
 * Upload one ~99 MB zip through a running stack and report what the API process did meanwhile.
 *   API_URL=http://127.0.0.1:4000 API_PID=<pid> npx tsx src/scripts/big-upload.ts
 * Proves: 100 MB-class files go to storage in parts, resume works, and the API never buffers file bytes.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";

const API = process.env.API_URL ?? "http://127.0.0.1:4000";
const pid = process.env.API_PID;
const rssMb = () => (pid ? Math.round(Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)![1]) / 1024) : NaN);

async function call(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}

const stamp = Date.now();
const reg = await call("POST", "/auth/register", undefined, { email: `big-${stamp}@example.com`, password: "password123", name: "Big Upload", teamName: `Big ${stamp}` });
const token = reg.token as string;

const bytes = Buffer.from(zipSync({ "README.md": strToU8("# 99 MB submission\n"), "data.bin": new Uint8Array(randomBytes(99 * 1024 * 1024)) }, { level: 0 }));
console.log(`file: ${(bytes.length / 1048576).toFixed(1)} MB`);

const rssBefore = rssMb();
let rssPeak = rssBefore;
const t0 = Date.now();
const created = await call("POST", "/versions", token, { title: "99 MB test", description: "", links: [], file: { name: "big.zip", size: bytes.length, contentType: "application/zip" } });
const id = created.version.id as string;
const { partSize, partCount } = created.upload;
console.log(`parts: ${partCount} x ${(partSize / 1048576).toFixed(0)} MB`);

const send = async (nums: number[]) => {
  for (let i = 0; i < nums.length; i += 6) {
    const { parts } = await call("POST", `/versions/${id}/upload/parts`, token, { parts: nums.slice(i, i + 6) });
    await Promise.all(
      parts.map(async (p: { n: number; url: string }) => {
        const slice = bytes.subarray((p.n - 1) * partSize, Math.min(bytes.length, p.n * partSize));
        const r = await fetch(p.url, { method: "PUT", body: new Uint8Array(slice) });
        if (!r.ok) throw new Error(`PUT part ${p.n}: ${r.status}`);
        await call("PUT", `/versions/${id}/upload/parts/${p.n}`, token, { etag: r.headers.get("etag"), size: slice.length });
        rssPeak = Math.max(rssPeak, rssMb());
      }),
    );
  }
};

// Interrupt after 5 parts, then resume from what the server says is missing.
await send([1, 2, 3, 4, 5]);
const state = await call("GET", `/versions/${id}/upload`, token);
console.log(`after simulated interruption: ${state.uploaded.length} stored, ${state.missing.length} missing`);
await send(state.missing);
const tUpload = Date.now() - t0;
await call("POST", `/versions/${id}/upload/complete`, token, {});
const tComplete = Date.now() - t0 - tUpload;

let status = "queued";
for (let i = 0; i < 120 && !["accepted", "needs_fix", "failed"].includes(status); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = (await call("GET", `/versions/${id}`, token)).version.status;
}
console.log(JSON.stringify({ finalStatus: status, uploadSeconds: +(tUpload / 1000).toFixed(1), completeCallMs: tComplete, apiRssMbBefore: rssBefore, apiRssMbPeakDuringUpload: rssPeak, apiRssMbAfter: rssMb() }, null, 2));
process.exit(status === "accepted" ? 0 : 1);
