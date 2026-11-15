import { Router } from "express";
import { z } from "zod";
import { Team, Version, Upload, CheckResult } from "../../lib/models";
import { requireAuth, requireTeamMember } from "../../lib/auth";
import { HttpError, parse, logAttempt, isObjectId } from "../../lib/http";
import { canCreateVersion, getDeadlineSettings } from "../../lib/policy";
import { now } from "../../lib/clock";
import { config } from "../../config";
import { createMultipart, presignGet } from "../../lib/s3";
import { enqueueCheck } from "../../lib/queue";
import { publishEvent } from "../../lib/events";

export const versionsRouter = Router();
versionsRouter.use(requireAuth, requireTeamMember);

const httpUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), "only http(s) links are allowed");

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  links: z.array(httpUrl).max(10).default([]),
  file: z
    .object({
      name: z.string().trim().min(1).max(200),
      size: z.number().int().min(1).max(config.upload.maxFileBytes),
      contentType: z.string().max(100).default("application/octet-stream"),
    })
    .optional(),
});

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, "_").slice(0, 100);

/**
 * Create a new version. Every edit is a new version; old ones are never modified.
 * With `file`: opens a multipart upload session. Without: carries the previous file forward.
 */
versionsRouter.post("/versions", async (req, res) => {
  const b = parse(createSchema, req.body);
  const teamId = req.user!.teamId!;
  const at = now();
  const settings = await getDeadlineSettings();

  const decision = canCreateVersion(at, settings);
  if (!decision.ok) {
    await logAttempt({ teamId, userId: req.user!.id, type: "create_version", accepted: false, reason: decision.reason, late: decision.late });
    throw new HttpError(403, decision.reason, { deadlineAt: settings.deadlineAt });
  }

  // Atomic per-team counter; the unique (teamId, versionNo) index backs it up.
  const team = await Team.findOneAndUpdate({ _id: teamId }, { $inc: { versionSeq: 1 } }, { returnDocument: "after" }).select("versionSeq").lean();
  if (!team) throw new HttpError(404, "team_not_found");
  const versionNo = team.versionSeq;

  const base = { teamId, versionNo, title: b.title, description: b.description, links: b.links, createdAt: at };

  if (b.file) {
    const key = `teams/${teamId}/v${versionNo}/${safeName(b.file.name)}`;
    const s3UploadId = await createMultipart(key, b.file.contentType);
    const partSize = config.upload.partSizeBytes;
    const partCount = Math.ceil(b.file.size / partSize);
    const version = await Version.create({ ...base, status: "uploading" });
    await Upload.create({
      versionId: version._id,
      teamId,
      s3UploadId,
      key,
      fileName: b.file.name,
      fileSize: b.file.size,
      partSize,
      partCount,
      startedAt: at,
    });
    void logAttempt({ teamId, userId: req.user!.id, type: "create_version", accepted: true }); // fire-and-forget: audit trail, not on the critical path
    await publishEvent({ teamId, versionId: String(version._id), versionNo, status: "uploading", at: at.toISOString() });
    return res.status(201).json({
      version: shape(version.toObject()),
      upload: { partSize, partCount, fileSize: b.file.size },
    });
  }

  // No new file: inherit the latest completed file, so a text-only edit does not lose it.
  const prev = await Version.findOne({ teamId, "file.key": { $exists: true }, status: { $ne: "uploading" } })
    .sort({ versionNo: -1 })
    .lean();
  const version = await Version.create({
    ...base,
    status: "queued",
    completedAt: at,
    ...(prev?.file ? { file: prev.file } : {}),
  });
  await enqueueCheck(String(version._id));
  void logAttempt({ teamId, userId: req.user!.id, type: "create_version", accepted: true }); // fire-and-forget: audit trail, not on the critical path
  await publishEvent({ teamId, versionId: String(version._id), versionNo, status: "queued", at: at.toISOString() });
  res.status(201).json({ version: shape(version.toObject()) });
});

export function shape(v: any) {
  return {
    id: String(v._id),
    versionNo: v.versionNo,
    title: v.title,
    description: v.description,
    links: v.links,
    status: v.status,
    file: v.file?.key ? { name: v.file.name, size: v.file.size, sha256: v.file.sha256 } : null,
    problems: v.problems ?? [],
    hasPreview: !!v.previewKey,
    createdAt: v.createdAt,
    completedAt: v.completedAt,
  };
}

/** The version that counts: the latest one whose upload completed. */
async function countedVersionId(teamId: string): Promise<string | null> {
  const v = await Version.findOne({ teamId, status: { $ne: "uploading" } }).sort({ versionNo: -1 }).select("_id").lean();
  return v ? String(v._id) : null;
}

versionsRouter.get("/versions", async (req, res) => {
  const teamId = req.user!.teamId!;
  const [versions, counted, settings] = await Promise.all([
    Version.find({ teamId }).sort({ versionNo: -1 }).limit(100).lean(),
    countedVersionId(teamId),
    getDeadlineSettings(),
  ]);
  const hardStop = settings.deadlineAt.getTime() + settings.graceSeconds * 1000;
  res.json({
    counted,
    versions: versions.map((v) => ({
      ...shape(v),
      // An upload nobody finished before the grace window closed can never count.
      expired: v.status === "uploading" && now().getTime() >= hardStop,
    })),
  });
});

versionsRouter.get("/versions/:id", async (req, res) => {
  const v = await loadOwnedVersion(req.params.id, req.user!.teamId!);
  const result = await CheckResult.findOne({ versionId: v._id }).lean();
  res.json({
    version: shape(v),
    counted: (await countedVersionId(req.user!.teamId!)) === String(v._id),
    checks: result ? { passed: result.passed, detectedType: result.detectedType, links: result.linkResults, problems: result.problems } : null,
  });
});

versionsRouter.get("/versions/:id/download", async (req, res) => {
  const v = await loadOwnedVersion(req.params.id, req.user!.teamId!);
  if (!v.file?.key) throw new HttpError(404, "no_file");
  res.json({ url: await presignGet(v.file.key, 300), previewUrl: v.previewKey ? await presignGet(v.previewKey, 300) : null });
});

export async function loadOwnedVersion(id: string, teamId: string) {
  if (!isObjectId(id)) throw new HttpError(404, "not_found");
  // Scoping the query by teamId means another team's version is indistinguishable from a missing one.
  const v = await Version.findOne({ _id: id, teamId }).lean();
  if (!v) throw new HttpError(404, "not_found");
  return v;
}
