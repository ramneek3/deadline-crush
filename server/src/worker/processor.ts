import type { Types } from "mongoose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckResult, Version, Upload } from "../lib/models";
import { completeMultipart, headObject } from "../lib/s3";
import { publishEvent } from "../lib/events";
import { now } from "../lib/clock";
import { config } from "../config";
import { ALLOWED_TYPES, checkLink, detectType, downloadToFile, inspectZip, type LinkResult } from "./checks";
import { pdfFirstPage, textPreview } from "./preview";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome = {
  passed: boolean;
  problems: string[];
  detectedType?: string;
  sha256?: string;
  previewKey?: string;
  linkResults: LinkResult[];
};

/**
 * EXACTLY-ONCE EFFECTS ON AT-LEAST-ONCE DELIVERY
 *
 * BullMQ may run this job more than once (worker killed, lock lost, retry). Re-running is safe
 * because every side effect is idempotent:
 *   - the result row is keyed by versionId behind a unique index and written with $setOnInsert,
 *     so the first writer wins and every retry reads that same row;
 *   - preview objects use deterministic keys (previews/<versionId>.*), so retries overwrite;
 *   - the status change is a compare-and-set from queued|checking, so it happens once;
 *   - the status event is published only by the run that performed that change.
 */
export async function processVersion(versionId: string): Promise<{ result: string }> {
  const v = await Version.findById(versionId).lean();
  if (!v) return { result: "version_missing" };

  // A previous run may have died after writing the result but before updating the version.
  const existing = await CheckResult.findOne({ versionId }).lean();
  if (existing) {
    await finalize(String(v._id), String(v.teamId), v.versionNo, existing);
    return { result: "reused_existing_result" };
  }
  if (v.status !== "queued" && v.status !== "checking") return { result: `skipped_${v.status}` };

  const moved = await Version.updateOne({ _id: v._id, status: "queued" }, { $set: { status: "checking" } });
  if (moved.modifiedCount > 0) {
    await publishEvent({ teamId: String(v.teamId), versionId, versionNo: v.versionNo, status: "checking", at: now().toISOString() });
  }

  const delay = Number(process.env.WORKER_TEST_DELAY_MS ?? 0);
  if (delay > 0) await sleep(delay); // lets tests kill us mid-job

  // Step 0: assemble the uploaded parts into the final object (moved out of the HTTP request).
  const uploadProblems = await finalizeUpload(v._id);
  const outcome = await runChecks(versionId, v.file?.key ?? undefined, v.file?.name ?? undefined, v.links ?? [], uploadProblems);

  try {
    await CheckResult.updateOne(
      { versionId },
      {
        $setOnInsert: {
          versionId,
          teamId: v.teamId,
          passed: outcome.passed,
          detectedType: outcome.detectedType,
          sha256: outcome.sha256,
          problems: outcome.problems,
          linkResults: outcome.linkResults,
          previewKey: outcome.previewKey,
          processedAt: now(),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e; // two runs raced; the other one won
  }
  const winner = await CheckResult.findOne({ versionId }).lean();
  await finalize(String(v._id), String(v.teamId), v.versionNo, winner!);
  return { result: winner!.passed ? "accepted" : "needs_fix" };
}

async function finalize(
  versionId: string,
  teamId: string,
  versionNo: number,
  r: { passed: boolean; problems: string[]; previewKey?: string | null; sha256?: string | null },
) {
  const status = r.passed ? "accepted" : "needs_fix";
  const set: Record<string, unknown> = { status, problems: r.problems, previewKey: r.previewKey ?? null };
  if (r.sha256) set["file.sha256"] = r.sha256;
  const res = await Version.updateOne({ _id: versionId, status: { $in: ["queued", "checking"] } }, { $set: set });
  if (res.modifiedCount > 0) {
    await publishEvent({ teamId, versionId, versionNo, status, problems: r.problems, at: now().toISOString() });
  }
}

const PERMANENT_S3 = new Set(["InvalidPart", "InvalidPartOrder", "EntityTooSmall", "MalformedXML", "NoSuchBucket"]);

/**
 * Turn the acknowledged parts into one stored object, then verify its size. Idempotent across
 * retries: if an earlier (killed) run already assembled the object, S3 answers NoSuchUpload and we
 * simply verify the object that is there.
 */
async function finalizeUpload(versionId: Types.ObjectId): Promise<string[]> {
  const u = await Upload.findOne({ versionId }).lean();
  if (!u || u.status !== "completing") return [];
  try {
    await completeMultipart(u.key, u.s3UploadId, u.parts.map((p) => ({ n: p.n as number, etag: p.etag! })));
  } catch (e) {
    const name = (e as { name?: string }).name ?? "";
    // Another worker (or an earlier, killed run) may have assembled it already, in which case storage
    // can answer NoSuchUpload or even an error for the concurrent call. If the object is there with the
    // right size, the work is done; otherwise decide between "permanent" and "retry".
    const existing = await headObject(u.key);
    const alreadyDone = existing && existing.size === u.fileSize;
    if (!alreadyDone && name !== "NoSuchUpload") {
      if (!PERMANENT_S3.has(name)) throw e; // transient: let BullMQ retry with backoff
      await Upload.updateOne({ _id: u._id }, { $set: { status: "completed" } });
      return ["upload_incomplete: storage could not assemble the uploaded parts; please re-upload"];
    }
  }
  const head = await headObject(u.key);
  await Upload.updateOne({ _id: u._id }, { $set: { status: "completed" } });
  if (!head) return ["upload_incomplete: the uploaded file is missing from storage; please re-upload"];
  if (head.size !== u.fileSize) return [`size_mismatch: stored ${head.size} bytes but ${u.fileSize} were declared`];
  return [];
}

async function runChecks(versionId: string, key: string | undefined, fileName: string | undefined, links: string[], uploadProblems: string[] = []): Promise<Outcome> {
  const problems: string[] = [...uploadProblems];
  const out: Outcome = { passed: false, problems, linkResults: [] };

  const linkPromise = Promise.all(links.slice(0, 10).map(checkLink));

  if (uploadProblems.length) {
    // The stored object is not what the team uploaded; checking its content would be meaningless.
  } else if (!key) {
    problems.push("no_file: this version has no file attached");
  } else {
    const dir = await mkdtemp(join(tmpdir(), "chk-"));
    const path = join(dir, "upload.bin");
    try {
      const dl = await downloadToFile(key, path, config.upload.maxFileBytes + 1024);
      out.sha256 = dl.sha256;
      const t = await detectType(path);
      out.detectedType = t.mime ?? "unknown";

      if (!t.mime || !ALLOWED_TYPES.has(t.mime)) {
        problems.push(`file_type_not_allowed: content is ${t.mime ?? "unrecognised"}${fileName ? ` (named "${fileName.slice(0, 60)}")` : ""}; only PDF and ZIP are accepted`);
      } else if (t.mime === "application/pdf") {
        out.previewKey = (await pdfFirstPage(path, versionId)) ?? undefined;
      } else {
        const rep = await inspectZip(path);
        problems.push(...rep.problems);
        if (rep.ok && rep.readme) out.previewKey = await textPreview(rep.readme.text, versionId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  out.linkResults = await linkPromise;
  for (const l of out.linkResults) if (!l.ok) problems.push(`link_unreachable: ${l.url} (${l.error ?? l.status})`);

  out.passed = problems.length === 0;
  return out;
}
