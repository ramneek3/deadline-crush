import { Settings } from "./models";
import { config } from "../config";
import { now } from "./clock";

export interface DeadlineSettings {
  deadlineAt: Date;
  graceSeconds: number;
}

/**
 * DEADLINE + GRACE POLICY (single source of truth, enforced on the server clock):
 *
 *  1. A new version (an edit, or the first submission) may be created only while now < deadline.
 *  2. A version created before the deadline may finish its upload (request part URLs, report
 *     parts, complete) until deadline + grace. Grace never allows *starting* anything new.
 *  3. The version that counts is the latest version whose upload completed. Every version is
 *     kept; an unfinished upload never overwrites an earlier good one.
 */
export type PolicyDecision = { ok: true } | { ok: false; reason: string; late: boolean };

export function canCreateVersion(at: Date, s: DeadlineSettings): PolicyDecision {
  if (at.getTime() < s.deadlineAt.getTime()) return { ok: true };
  return { ok: false, reason: "deadline_passed", late: true };
}

export function canContinueUpload(
  versionCreatedAt: Date,
  at: Date,
  s: DeadlineSettings,
): PolicyDecision {
  if (versionCreatedAt.getTime() >= s.deadlineAt.getTime()) {
    return { ok: false, reason: "upload_started_after_deadline", late: true };
  }
  const hardStop = s.deadlineAt.getTime() + s.graceSeconds * 1000;
  if (at.getTime() >= hardStop) return { ok: false, reason: "grace_period_over", late: true };
  return { ok: true };
}

/** Signed URLs must never outlive the policy window. */
export function urlTtlSeconds(at: Date, s: DeadlineSettings): number {
  const hardStop = s.deadlineAt.getTime() + s.graceSeconds * 1000;
  const remaining = Math.floor((hardStop - at.getTime()) / 1000);
  return Math.max(1, Math.min(config.upload.maxUrlTtlSeconds, remaining));
}

let cache: { at: number; value: DeadlineSettings } | null = null;
export function invalidateSettingsCache() {
  cache = null;
}

export async function getDeadlineSettings(): Promise<DeadlineSettings> {
  const t = Date.now();
  if (cache && t - cache.at < 1000) return cache.value;
  let doc = await Settings.findOne({ key: "hackathon" }).lean();
  if (!doc) {
    try {
      doc = (
        await Settings.create({
          key: "hackathon",
          deadlineAt: new Date(config.deadline.defaultDeadlineAt),
          graceSeconds: config.deadline.defaultGraceSeconds,
        })
      ).toObject();
    } catch {
      doc = await Settings.findOne({ key: "hackathon" }).lean(); // lost the creation race
    }
  }
  const value = { deadlineAt: doc!.deadlineAt, graceSeconds: doc!.graceSeconds };
  cache = { at: t, value };
  return value;
}

export async function setDeadlineSettings(deadlineAt: Date, graceSeconds: number) {
  await Settings.updateOne({ key: "hackathon" }, { $set: { deadlineAt, graceSeconds } }, { upsert: true });
  invalidateSettingsCache();
}

export { now };
