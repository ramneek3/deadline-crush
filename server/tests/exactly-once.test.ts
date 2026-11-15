import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { setup, teardown, resetAll, openWindow, newTeam, uploadFile, waitFor, waitStatus, withWorker } from "./helpers";
import { zipOf } from "./fixtures";
import { CheckResult, Version } from "../src/lib/models";
import { getQueue } from "../src/lib/queue";
import { subscribeEvents } from "../src/lib/events";
import { processVersion } from "../src/worker/processor";
import { headObject } from "../src/lib/s3";

beforeAll(setup);
afterAll(teardown);
beforeEach(async () => {
  await resetAll();
  await openWindow();
});

/** A real, separate OS process, so SIGKILL is a genuine crash (no cleanup handlers run). */
function spawnWorker(env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/worker/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}
const FAST_STALL = { WORKER_LOCK_MS: "1500", WORKER_STALLED_MS: "1500", WORKER_CONCURRENCY: "4" };

const readme = (n: number) => zipOf({ "README.md": `# project ${n}` });

describe("exactly-once processing", () => {
  it("a worker killed mid-job (SIGKILL) is retried by another worker, with no duplicate results", async () => {
    const t = await newTeam();
    const up = await uploadFile(t.token, readme(1), { fileName: "p.zip" });
    const id = up.versionId!;

    const accepted: string[] = [];
    const off = subscribeEvents((e) => e.versionId === id && e.status === "accepted" && accepted.push(e.status));
    await new Promise((r) => setTimeout(r, 200));

    // Worker A picks the job up and then sits inside it (artificial delay) until we kill it.
    const a = spawnWorker({ ...FAST_STALL, WORKER_TEST_DELAY_MS: "60000" });
    await waitFor(async () => (await Version.findById(id).lean())?.status === "checking");
    a.kill("SIGKILL"); // crash: no graceful shutdown, the job is left locked and half-done
    await new Promise((r) => a.once("exit", r));
    expect(await CheckResult.countDocuments({ versionId: id })).toBe(0);

    // Worker B has no delay. BullMQ notices A's lock expired, marks the job stalled and re-delivers it.
    const b = spawnWorker({ ...FAST_STALL });
    try {
      const v = await waitStatus(id, "accepted", "needs_fix", "failed");
      expect(v.status).toBe("accepted");
      await new Promise((r) => setTimeout(r, 500));
      expect(await CheckResult.countDocuments({ versionId: id })).toBe(1); // one result row
      expect(accepted).toHaveLength(1); // one "accepted" event, not two
      expect((await headObject(`previews/${id}.txt`))!.size).toBeGreaterThan(0); // one preview, deterministic key
    } finally {
      off();
      b.kill("SIGKILL");
    }
  });

  it("killing a worker during a burst loses nothing and duplicates nothing", async () => {
    const t = await newTeam();
    const N = 12;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push((await uploadFile(t.token, readme(i), { fileName: `p${i}.zip` })).versionId!);

    const a = spawnWorker({ ...FAST_STALL, WORKER_TEST_DELAY_MS: "2500" });
    await waitFor(async () => (await Version.countDocuments({ _id: { $in: ids }, status: "checking" })) >= 2);
    a.kill("SIGKILL");
    await new Promise((r) => a.once("exit", r));

    const b = spawnWorker({ ...FAST_STALL });
    try {
      await waitFor(async () => (await Version.countDocuments({ _id: { $in: ids }, status: "accepted" })) === N, 45_000, 300);
      expect(await CheckResult.countDocuments({ versionId: { $in: ids } })).toBe(N);
      const dup = await CheckResult.aggregate([{ $group: { _id: "$versionId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
      expect(dup).toEqual([]);
    } finally {
      b.kill("SIGKILL");
    }
  }, 90_000);

  it("running the processor twice for the same version changes nothing the second time", async () => {
    const t = await newTeam();
    const up = await uploadFile(t.token, readme(1), { fileName: "p.zip" });
    const id = up.versionId!;
    const seen: string[] = [];
    const off = subscribeEvents((e) => e.versionId === id && seen.push(e.status));
    await new Promise((r) => setTimeout(r, 200));
    const first = await processVersion(id);
    const second = await processVersion(id);
    await new Promise((r) => setTimeout(r, 300));
    off();
    expect(first.result).toBe("accepted");
    expect(second.result).toMatch(/^(reused_existing_result|skipped_accepted)$/);
    expect(await CheckResult.countDocuments({ versionId: id })).toBe(1);
    expect(seen.filter((s) => s === "accepted")).toHaveLength(1);
  });

  it("two workers racing on the same version still produce one result", async () => {
    const t = await newTeam();
    const up = await uploadFile(t.token, readme(1), { fileName: "p.zip" });
    await Promise.all(Array.from({ length: 5 }, () => processVersion(up.versionId!)));
    expect(await CheckResult.countDocuments({ versionId: up.versionId })).toBe(1);
    expect((await Version.findById(up.versionId).lean())!.status).toBe("accepted");
  });

  it("finishes a version whose result was written but whose status update was lost", async () => {
    const t = await newTeam();
    const up = await uploadFile(t.token, readme(1), { fileName: "p.zip" });
    const v = (await Version.findById(up.versionId).lean())!;
    await Version.updateOne({ _id: v._id }, { $set: { status: "checking" } });
    await CheckResult.create({ versionId: v._id, teamId: v.teamId, passed: true, problems: [], processedAt: new Date() });
    expect((await processVersion(String(v._id))).result).toBe("reused_existing_result");
    expect((await Version.findById(v._id).lean())!.status).toBe("accepted");
    expect(await CheckResult.countDocuments({ versionId: v._id })).toBe(1);
  });

  it("the sweeper recovers a completed upload whose job was lost (nothing is dropped)", async () => {
    const t = await newTeam();
    const up = await uploadFile(t.token, readme(1), { fileName: "p.zip" });
    await getQueue().obliterate({ force: true }); // simulate a Redis wipe: the job is gone
    expect(await getQueue().getJobCounts("waiting", "active", "delayed")).toMatchObject({ waiting: 0 });
    process.env.SWEEP_MS = "300";
    process.env.SWEEP_STALE_MS = "0";
    try {
      await withWorker(async () => {
        expect((await waitStatus(up.versionId!, "accepted")).status).toBe("accepted");
      });
    } finally {
      delete process.env.SWEEP_MS;
      delete process.env.SWEEP_STALE_MS;
    }
  });
});
