import { Redis } from "ioredis";
import { config } from "../config";

export interface StatusEvent {
  teamId: string;
  versionId: string;
  versionNo?: number;
  status: string;
  problems?: string[];
  at: string;
}

const CHANNEL = "submission-events";
let pub: Redis | null = null;
const getPub = () => (pub ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null }));

export const publishEvent = (e: StatusEvent) => getPub().publish(CHANNEL, JSON.stringify(e)).then(() => undefined);

type Listener = (e: StatusEvent) => void;
const listeners = new Set<Listener>();
let sub: Redis | null = null;

/** One Redis subscriber per API process; fan-out to SSE clients happens in memory. */
export function subscribeEvents(fn: Listener): () => void {
  if (!sub) {
    sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    sub.subscribe(CHANNEL).catch(() => undefined);
    sub.on("message", (_c, msg) => {
      let e: StatusEvent;
      try {
        e = JSON.parse(msg);
      } catch {
        return;
      }
      for (const l of listeners) l(e);
    });
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function closeEvents() {
  await Promise.all([pub?.quit(), sub?.quit()].filter(Boolean) as Promise<unknown>[]).catch(() => undefined);
  pub = sub = null;
  listeners.clear();
}
