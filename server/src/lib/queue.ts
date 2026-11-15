import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config";

export const QUEUE_NAME = "submission-checks";
export const redisConnection = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

let queue: Queue | null = null;
let conn: Redis | null = null;
export function getQueue() {
  if (!queue) {
    conn = redisConnection();
    queue = new Queue(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: false,
      },
    });
  }
  return queue;
}

/** jobId == versionId, so enqueueing the same version twice is a no-op. */
export const enqueueCheck = (versionId: string) =>
  getQueue().add("check", { versionId }, { jobId: versionId });

export async function closeQueue() {
  await queue?.close();
  await conn?.quit().catch(() => undefined);
  queue = conn = null;
}
