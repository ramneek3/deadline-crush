import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setup, teardown, resetAll, openWindow, newTeam, uploadFile, waitStatus, withWorker, linkServer } from "./helpers";
import { tinyPdf, zipOf, zipBomb, fakePdfExe } from "./fixtures";
import { CheckResult } from "../src/lib/models";
import { headObject } from "../src/lib/s3";
import { checkLink } from "../src/worker/checks";

beforeAll(setup);
afterAll(teardown);
beforeEach(async () => {
  await resetAll();
  await openWindow();
});

async function submit(bytes: Buffer, opts: { fileName: string; links?: string[] }) {
  const t = await newTeam();
  return withWorker(async () => {
    const r = await uploadFile(t.token, bytes, opts);
    const v = await waitStatus(r.versionId!, "accepted", "needs_fix", "failed");
    const res = await CheckResult.findOne({ versionId: r.versionId }).lean();
    return { v, res };
  });
}

describe("background checks: file content", () => {
  it("rejects an executable renamed to .pdf (type is read from the bytes, not the name)", async () => {
    const { v } = await submit(fakePdfExe(), { fileName: "report.pdf" });
    expect(v.status).toBe("needs_fix");
    expect(v.problems.join(" ")).toContain("file_type_not_allowed");
  });

  it("accepts a real PDF even if it is named .bin", async () => {
    const { v, res } = await submit(tinyPdf(), { fileName: "whatever.bin" });
    expect(v.status).toBe("accepted");
    expect(res!.detectedType).toBe("application/pdf");
  });

  it("rejects a zip bomb without extracting it", async () => {
    const { v } = await submit(zipBomb(), { fileName: "project.zip" });
    expect(v.status).toBe("needs_fix");
    expect(v.problems.join(" ")).toMatch(/zip_bomb/);
  });

  it("rejects archives with too many entries", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`f${i}.txt`] = "x"; // limit is 50 in the test env
    const { v } = await submit(zipOf(files), { fileName: "many.zip" });
    expect(v.status).toBe("needs_fix");
    expect(v.problems.join(" ")).toContain("too_many_entries");
  });

  it("rejects nested archives and path traversal", async () => {
    const nested = await submit(zipOf({ "inner.zip": zipOf({ "a.txt": "a" }) }), { fileName: "n.zip" });
    expect(nested.v.problems).toContain("nested_archive_not_allowed");
    const evil = await submit(zipOf({ "../../etc/evil.txt": "x" }), { fileName: "e.zip" });
    expect(evil.v.problems).toContain("unsafe_path_in_archive");
  });

  it("rejects a corrupt zip", async () => {
    const good = zipOf({ "README.md": "hello" });
    const broken = Buffer.concat([good.subarray(0, 4), Buffer.alloc(200, 1)]); // keeps the zip magic, loses the structure
    const { v } = await submit(broken, { fileName: "broken.zip" });
    expect(v.status).toBe("needs_fix");
    expect(v.problems).toContain("corrupt_archive");
  });
});

describe("background checks: previews", () => {
  it("generates a PNG preview of the first PDF page", async () => {
    const { v } = await submit(tinyPdf(), { fileName: "p.pdf" });
    expect(v.previewKey).toBe(`previews/${v._id}.png`);
    expect((await headObject(v.previewKey!))!.size).toBeGreaterThan(100);
  });

  it("generates a text preview from the zip README", async () => {
    const { v } = await submit(zipOf({ "docs/README.md": "# My project\nIt does things." }), { fileName: "p.zip" });
    expect(v.status).toBe("accepted");
    expect(v.previewKey).toBe(`previews/${v._id}.txt`);
  });
});

describe("background checks: links", () => {
  it("accepts working links (including redirects)", async () => {
    const srv = await linkServer();
    try {
      const { v, res } = await submit(zipOf({ "README.md": "x" }), { fileName: "a.zip", links: [`${srv.base}/ok`, `${srv.base}/redirect`] });
      expect(v.status).toBe("accepted");
      expect(res!.linkResults.every((l) => l.ok)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("flags a link that returns 404 and one that cannot be reached", async () => {
    const srv = await linkServer();
    try {
      const { v } = await submit(zipOf({ "README.md": "x" }), { fileName: "a.zip", links: [`${srv.base}/missing`, "http://127.0.0.1:1/nothing"] });
      expect(v.status).toBe("needs_fix");
      expect(v.problems.filter((p) => p.startsWith("link_unreachable")).length).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it("refuses to fetch internal addresses (SSRF guard)", async () => {
    const srv = await linkServer();
    process.env.ALLOW_PRIVATE_LINKS = "false";
    try {
      const r = await checkLink(`${srv.base}/ok`);
      expect(r).toMatchObject({ ok: false, error: "blocked_private_address" });
      expect(await checkLink("http://169.254.169.254/latest/meta-data/")).toMatchObject({ ok: false });
    } finally {
      process.env.ALLOW_PRIVATE_LINKS = "true";
      await srv.close();
    }
  });
});
