import { Router } from "express";
import { z } from "zod";
import { Upload, Version } from "../../lib/models";
import { requireAuth, requireTeamMember } from "../../lib/auth";
import { HttpError, parse, logAttempt } from "../../lib/http";
import { canContinueUpload, getDeadlineSettings, urlTtlSeconds } from "../../lib/policy";
import { now } from "../../lib/clock";
import { presignPart, completeMultipart, headObject, abortMultipart } from "../../lib/s3";
import { enqueueCheck } from "../../lib/queue";
import { publishEvent } from "../../lib/events";
import { loadOwnedVersion, shape } from "./versions";

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth, requireTeamMember);

const STALE_COMPLETING_MS = 30_000;

async function loadUpload(versionId: string, teamId: string) {
  const v = await loadOwnedVersion(versionId, teamId);
  const u = await Upload.findOne({ versionId: v._id, teamId }).lean();
  if (!u) throw new HttpError(404, "no_upload");
  return { v, u };
}

/** Gate every upload action through the deadline/grace policy and record refusals. */
async function gate(v: { createdAt: Date }, req: { user?: { id: string; teamId: string | null } }, type: string) {
  const settings = await getDeadlineSettings();
  const at = now();
  const d = canContinueUpload(v.createdAt, at, settings);
  if (!d.ok) {
    await logAttempt({ teamId: req.user!.teamId, userId: req.user!.id, type, accepted: false, reason: d.reason, late: d.late });
    throw new HttpError(403, d.reason, { deadlineAt: settings.deadlineAt, graceSeconds: settings.graceSeconds });
  }
  return { settings, at };
}

/** Resume state: what has been uploaded, what is missing. */
uploadsRouter.get("/versions/:id/upload", async (req, res) => {
  const { v, u } = await loadUpload(req.params.id, req.user!.teamId!);
  const settings = await getDeadlineSettings();
  const can = canContinueUpload(v.createdAt, now(), settings);
  const have = new Set(u.parts.map((p) => p.n as number));
  res.json({
    status: u.status,
    versionStatus: v.status,
    partSize: u.partSize,
    partCount: u.partCount,
    fileSize: u.fileSize,
    uploaded: [...have].sort((a: number, b: number) => a - b),
    missing: Array.from({ length: u.partCount }, (_, i) => i + 1).filter((n) => !have.has(n)),
    canContinue: can.ok && u.status !== "completed",
  });
});

/** Presigned PUT URLs, one per requested part. The API never sees file bytes. */
uploadsRouter.post("/versions/:id/upload/parts", async (req, res) => {
  const b = parse(z.object({ parts: z.array(z.number().int().min(1)).min(1).max(20) }), req.body);
  const { v, u } = await loadUpload(req.params.id, req.user!.teamId!);
  if (u.status !== "open") throw new HttpError(409, "upload_not_open");
  const { settings, at } = await gate(v, req, "presign");
  const ttl = urlTtlSeconds(at, settings);
  const out = [];
  for (const n of [...new Set(b.parts)]) {
    if (n > u.partCount) throw new HttpError(400, "part_out_of_range");
    const size = n === u.partCount ? u.fileSize - u.partSize * (u.partCount - 1) : u.partSize;
    out.push({ n, size, url: await presignPart(u.key, u.s3UploadId, n, ttl) });
  }
  res.json({ expiresInSeconds: ttl, parts: out });
});

/** The client reports each part's ETag after the PUT; this is the resume source of truth. */
uploadsRouter.put("/versions/:id/upload/parts/:n", async (req, res) => {
  const b = parse(z.object({ etag: z.string().min(1).max(200), size: z.number().int().min(1) }), req.body);
  const n = Number(req.params.n);
  const { v, u } = await loadUpload(req.params.id, req.user!.teamId!);
  if (!Number.isInteger(n) || n < 1 || n > u.partCount) throw new HttpError(400, "part_out_of_range");
  if (u.status !== "open") throw new HttpError(409, "upload_not_open");
  await gate(v, req, "ack_part");
  const part = { n, etag: b.etag, size: b.size };
  const r = await Upload.updateOne({ _id: u._id, "parts.n": n }, { $set: { "parts.$": part } });
  if (r.matchedCount === 0) {
    await Upload.updateOne({ _id: u._id, "parts.n": { $ne: n } }, { $push: { parts: part } });
  }
  res.json({ ok: true });
});

/**
 * Finish the upload. Safe to retry: only one request can win the open -> completing claim,
 * and a request that arrives after completion simply returns the current state.
 */
uploadsRouter.post("/versions/:id/upload/complete", async (req, res) => {
  const teamId = req.user!.teamId!;
  const { v, u } = await loadUpload(req.params.id, teamId);

  if (u.status === "completed") return res.json({ version: shape(v), alreadyCompleted: true });

  const { at } = await gate(v, req, "complete_upload");

  const have = new Map(u.parts.map((p) => [p.n as number, p]));
  const missing = Array.from({ length: u.partCount }, (_, i) => i + 1).filter((n) => !have.has(n));
  if (missing.length) throw new HttpError(409, "parts_missing", { missing });

  // Claim: open -> completing (or take over a claim whose owner crashed).
  const claimed = await Upload.findOneAndUpdate(
    {
      _id: u._id,
      $or: [
        { status: "open" },
        { status: "completing", completingAt: { $lt: new Date(at.getTime() - STALE_COMPLETING_MS) } },
      ],
    },
    { $set: { status: "completing", completingAt: at } },
    { returnDocument: "after" },
  ).lean();
  if (!claimed) {
    const fresh = await Version.findById(v._id).lean();
    return res.status(fresh && fresh.status !== "uploading" ? 200 : 409).json(
      fresh && fresh.status !== "uploading" ? { version: shape(fresh), alreadyCompleted: true } : { error: "completion_in_progress" },
    );
  }

  try {
    await completeMultipart(u.key, u.s3UploadId, u.parts.map((p) => ({ n: p.n as number, etag: p.etag! })));
  } catch (e) {
    await Upload.updateOne({ _id: u._id }, { $set: { status: "open", completingAt: null } });
    console.error("complete multipart failed", e);
    throw new HttpError(502, "storage_error");
  }

  const head = await headObject(u.key);
  if (!head || head.size !== u.fileSize) {
    await Upload.updateOne({ _id: u._id }, { $set: { status: "completed" } });
    await Version.updateOne(
      { _id: v._id },
      { $set: { status: "needs_fix", completedAt: at, problems: ["size_mismatch: uploaded file size differs from the declared size"] } },
    );
    await publishEvent({ teamId, versionId: String(v._id), versionNo: v.versionNo, status: "needs_fix", at: at.toISOString() });
    return res.status(422).json({ error: "size_mismatch" });
  }

  const updated = await Version.findOneAndUpdate(
    { _id: v._id, status: "uploading" },
    {
      $set: {
        status: "queued",
        completedAt: at,
        file: { key: u.key, name: u.fileName, size: u.fileSize, contentType: head.contentType },
      },
    },
    { returnDocument: "after" },
  ).lean();
  await Upload.updateOne({ _id: u._id }, { $set: { status: "completed" } });
  // jobId == versionId makes this idempotent; the worker-side sweeper covers a Redis outage here.
  await enqueueCheck(String(v._id)).catch((e) => console.error("enqueue failed; sweeper will retry", e));
  await publishEvent({ teamId, versionId: String(v._id), versionNo: v.versionNo, status: "queued", at: at.toISOString() }).catch(() => undefined);
  await logAttempt({ teamId, userId: req.user!.id, type: "complete_upload", accepted: true });
  res.json({ version: shape(updated ?? v) });
});

uploadsRouter.delete("/versions/:id/upload", async (req, res) => {
  const { v, u } = await loadUpload(req.params.id, req.user!.teamId!);
  if (u.status !== "open" || v.status !== "uploading") throw new HttpError(409, "upload_not_open");
  await abortMultipart(u.key, u.s3UploadId);
  await Upload.updateOne({ _id: u._id }, { $set: { status: "aborted" } });
  res.json({ ok: true });
});
