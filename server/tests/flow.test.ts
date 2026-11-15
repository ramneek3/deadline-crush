import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, setup, teardown, resetAll, openWindow, newTeam, uploadFile, putParts, waitStatus, withWorker, createVersion } from "./helpers";
import { tinyPdf, zipOf } from "./fixtures";
import { CheckResult, Version, Upload } from "../src/lib/models";
import { startWorker } from "../src/worker/main";

beforeAll(setup);
afterAll(teardown);
beforeEach(async () => {
  await resetAll();
  await openWindow();
});

// A ~2.5 MB PDF => 3 parts at 1 MiB each.
const bigPdf = () => Buffer.concat([tinyPdf(), Buffer.alloc(2.5 * 1024 * 1024, 0x20)]);

describe("upload flow (direct-to-storage, multipart)", () => {
  it("uploads via presigned URLs, then the worker accepts it", async () => {
    const t = await newTeam();
    await withWorker(async () => {
      const { versionId, complete, partCount } = await uploadFile(t.token, bigPdf());
      expect(partCount).toBe(3);
      expect(complete!.status).toBe(200);
      const v = await waitStatus(versionId!, "accepted", "needs_fix");
      expect(v.status).toBe("accepted");
      expect(v.file?.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("can resume an interrupted upload: only missing parts are re-sent", async () => {
    const t = await newTeam();
    const bytes = bigPdf();
    const first = await uploadFile(t.token, bytes, { only: [1], complete: false });
    // "Laptop went offline." A fresh client asks the server what is missing.
    const state = await api().get(`/versions/${first.versionId}/upload`).set(auth(t.token));
    expect(state.body.uploaded).toEqual([1]);
    expect(state.body.missing).toEqual([2, 3]);
    await putParts(t.token, first.versionId!, bytes, first.partSize!, state.body.missing);
    await withWorker(async () => {
      const done = await api().post(`/versions/${first.versionId}/upload/complete`).set(auth(t.token)).send({});
      expect(done.status).toBe(200);
      expect((await waitStatus(first.versionId!, "accepted", "needs_fix")).status).toBe("accepted");
    });
  });

  it("refuses to complete while parts are missing", async () => {
    const t = await newTeam();
    const r = await uploadFile(t.token, bigPdf(), { only: [1, 2] });
    expect(r.complete!.status).toBe(409);
    expect(r.complete!.body).toMatchObject({ error: "parts_missing", missing: [3] });
  });

  it("concurrent completes are safe: one wins, one result, one job", async () => {
    const t = await newTeam();
    const r = await uploadFile(t.token, bigPdf(), { complete: false });
    await putParts(t.token, r.versionId!, bigPdf(), r.partSize!, [1, 2, 3]);
    const calls = await Promise.all(
      Array.from({ length: 6 }, () => api().post(`/versions/${r.versionId}/upload/complete`).set(auth(t.token)).send({})),
    );
    expect(calls.every((c) => [200, 409].includes(c.status))).toBe(true);
    expect(calls.some((c) => c.status === 200)).toBe(true);
    await withWorker(async () => {
      await waitStatus(r.versionId!, "accepted", "needs_fix");
    });
    expect(await CheckResult.countDocuments({ versionId: r.versionId })).toBe(1);
  });

  it("flags a size mismatch (declared size differs from the bytes uploaded)", async () => {
    const t = await newTeam();
    const bytes = bigPdf();
    // Declare one byte more than we upload; part count stays 3 so the upload looks complete.
    const r = await uploadFile(t.token, bytes, { declaredSize: bytes.length + 1 });
    expect(r.complete!.status).toBe(422);
    const v = await Version.findById(r.versionId).lean();
    expect(v!.status).toBe("needs_fix");
  });

  it("rejects declared files over 100 MB and invalid links", async () => {
    const t = await newTeam();
    const big = await createVersion(t.token, { file: { name: "x.zip", size: 101 * 1024 * 1024 } });
    expect(big.status).toBe(400);
    const bad = await createVersion(t.token, { links: ["javascript:alert(1)"] });
    expect(bad.status).toBe(400);
    const noTitle = await api().post("/versions").set(auth(t.token)).send({ description: "x" });
    expect(noTitle.status).toBe(400);
  });

  it("the API only ever receives JSON: a large body is refused", async () => {
    const t = await newTeam();
    const r = await api().post("/versions").set(auth(t.token)).send({ title: "x", description: "y".repeat(200_000) });
    expect([400, 413]).toContain(r.status);
  });
});

describe("versions", () => {
  it("every edit is a new version and old versions are untouched", async () => {
    const t = await newTeam();
    await withWorker(async () => {
      const a = await uploadFile(t.token, zipOf({ "README.md": "# one" }), { title: "v1", fileName: "a.zip" });
      await waitStatus(a.versionId!, "accepted");
      const edit = await createVersion(t.token, { title: "v2 edited" }); // text-only edit
      expect(edit.status).toBe(201);
      await waitStatus(edit.body.version.id, "accepted");
      const list = await api().get("/versions").set(auth(t.token));
      expect(list.body.versions.map((v: any) => v.versionNo)).toEqual([2, 1]);
      const old = list.body.versions.find((v: any) => v.versionNo === 1);
      expect(old.title).toBe("v1");
      expect(list.body.counted).toBe(edit.body.version.id);
    });
  });

  it("a text-only edit carries the previous file forward", async () => {
    const t = await newTeam();
    await withWorker(async () => {
      const a = await uploadFile(t.token, zipOf({ "README.md": "hello" }), { fileName: "a.zip" });
      await waitStatus(a.versionId!, "accepted");
      const edit = await createVersion(t.token, { title: "new title" });
      expect(edit.body.version.file?.name).toBe("a.zip");
    });
  });

  it("an unfinished newer upload never replaces an earlier good submission", async () => {
    const t = await newTeam();
    await withWorker(async () => {
      const good = await uploadFile(t.token, zipOf({ "README.md": "ok" }), { fileName: "good.zip" });
      await waitStatus(good.versionId!, "accepted");
      const half = await uploadFile(t.token, bigPdf(), { only: [1], complete: false });
      const list = await api().get("/versions").set(auth(t.token));
      expect(list.body.counted).toBe(good.versionId);
      expect(list.body.versions.find((v: any) => v.id === half.versionId).status).toBe("uploading");
    });
  });
});

describe("worker lifecycle", () => {
  it("publishes live status events in order: queued -> checking -> accepted", async () => {
    const t = await newTeam();
    const { subscribeEvents } = await import("../src/lib/events");
    const seen: string[] = [];
    const off = subscribeEvents((e) => e.teamId === t.teamId && seen.push(e.status));
    await new Promise((r) => setTimeout(r, 200));
    await withWorker(async () => {
      const r = await uploadFile(t.token, zipOf({ "README.md": "x" }), { fileName: "x.zip" });
      await waitStatus(r.versionId!, "accepted");
    });
    await new Promise((r) => setTimeout(r, 200));
    off();
    expect(seen).toEqual(["uploading", "queued", "checking", "accepted"]);
  });
});
