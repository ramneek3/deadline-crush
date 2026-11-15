import { Worker, UnrecoverableError } from "bullmq";
import { config } from "../config";
import { connectDb } from "../lib/db";
import { QUEUE_NAME, redisConnection, enqueueCheck, closeQueue } from "../lib/queue";
import { Version } from "../lib/models";
import { publishEvent } from "../lib/events";
import { ensureBucket } from "../lib/s3";
import { processVersion } from "./processor";

export async function startWorker() {
  await connectDb();
  await ensureBucket().catch(() => undefined);

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { versionId } = job.data as { versionId?: string };
      if (!versionId) throw new UnrecoverableError("bad_job");
      return processVersion(versionId);
    },
    {
      connection: redisConnection(),
      concurrency: config.worker.concurrency,
      lockDuration: config.worker.lockDurationMs,
      stalledInterval: Number(process.env.WORKER_STALLED_MS ?? config.worker.lockDurationMs),
      maxStalledCount: 5, // a job whose worker died is retried, not dropped
    },
  );

  worker.on("failed", async (job, err) => {
    const final = job && (job.attemptsMade >= (job.opts.attempts ?? 1) || /stalled/i.test(err.message));
    console.error(`job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    if (!final || !job) return;
    const v = await Version.findOneAndUpdate(
      { _id: job.data.versionId, status: { $in: ["queued", "checking"] } },
      { $set: { status: "failed", problems: ["checks_could_not_run: please re-submit"] } },
      { returnDocument: "after" },
    ).lean();
    if (v) await publishEvent({ teamId: String(v.teamId), versionId: String(v._id), versionNo: v.versionNo, status: "failed", at: new Date().toISOString() });
  });

  // Safety net for "nothing may be lost": a version whose job vanished (Redis outage or flush,
  // enqueue failure after the upload completed) is re-enqueued. jobId == versionId makes it a no-op
  // when the job still exists, and the idempotent processor makes a duplicate run harmless.
  const sweepEvery = Number(process.env.SWEEP_MS ?? 30_000);
  const staleAfter = Number(process.env.SWEEP_STALE_MS ?? 60_000);
  const sweep = async () => {
    const cutoff = new Date(Date.now() - staleAfter);
    const stuck = await Version.find({ status: { $in: ["queued", "checking"] }, completedAt: { $lt: cutoff } }).select("_id").limit(500).lean();
    for (const s of stuck) await enqueueCheck(String(s._id)).catch(() => undefined);
    if (stuck.length) console.log(`sweeper re-enqueued ${stuck.length} version(s)`);
  };
  const timer = setInterval(() => sweep().catch((e) => console.error("sweep", e)), sweepEvery);

  const close = async () => {
    clearInterval(timer);
    await worker.close();
    await closeQueue();
  };
  return { worker, close };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("worker/main.ts")) {
  startWorker()
    .then(({ close }) => {
      console.log("worker started");
      const stop = () => close().then(() => process.exit(0));
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
