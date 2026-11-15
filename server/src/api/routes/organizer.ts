import { Router } from "express";
import { z } from "zod";
import { Version, Team, Attempt } from "../../lib/models";
import { requireAuth, requireOrganizer } from "../../lib/auth";
import { parse } from "../../lib/http";
import { getDeadlineSettings, setDeadlineSettings } from "../../lib/policy";
import { now } from "../../lib/clock";

export const organizerRouter = Router();
organizerRouter.use("/organizer", requireAuth, requireOrganizer);

/** Latest completed version per team = the submission that counts. */
const countedPipeline = [
  { $match: { status: { $ne: "uploading" } } },
  { $sort: { teamId: 1, versionNo: -1 } },
  { $group: { _id: "$teamId", doc: { $first: "$$ROOT" } } },
] as const;

organizerRouter.get("/organizer/stats", async (_req, res) => {
  const [settings, teams, byStatus, counted, late, lateByReason, versions] = await Promise.all([
    getDeadlineSettings(),
    Team.estimatedDocumentCount(),
    Version.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Version.aggregate([...countedPipeline, { $group: { _id: "$doc.status", n: { $sum: 1 } } }]),
    Attempt.countDocuments({ late: true }),
    Attempt.aggregate([{ $match: { late: true } }, { $group: { _id: "$reason", n: { $sum: 1 } } }]),
    Version.estimatedDocumentCount(),
  ]);
  const toMap = (rows: { _id: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const countedByStatus = toMap(counted);
  const submittedTeams = Object.values(countedByStatus).reduce((a, b) => a + b, 0);
  res.json({
    serverTime: now(),
    deadlineAt: settings.deadlineAt,
    graceSeconds: settings.graceSeconds,
    teams,
    teamsWithSubmission: submittedTeams,
    totalVersions: versions,
    versionsByStatus: toMap(byStatus),
    countedByStatus,
    lateAttempts: late,
    lateAttemptsByReason: toMap(lateByReason),
    failedChecks: (countedByStatus.needs_fix ?? 0) + (countedByStatus.failed ?? 0),
  });
});

const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

organizerRouter.get("/organizer/export.csv", async (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="submissions.csv"');
  const head = ["team", "version_no", "title", "description", "links", "status", "file_name", "file_size", "sha256", "created_at", "completed_at", "problems"];
  res.write(head.join(",") + "\n");
  const cursor = Version.aggregate([
    ...countedPipeline,
    { $lookup: { from: "teams", localField: "_id", foreignField: "_id", as: "team" } },
    { $sort: { "team.name": 1 } },
  ]).cursor();
  for await (const row of cursor) {
    const d = row.doc;
    res.write(
      [
        row.team[0]?.name, d.versionNo, d.title, d.description, (d.links ?? []).join(" "), d.status,
        d.file?.name, d.file?.size, d.file?.sha256, d.createdAt?.toISOString?.(), d.completedAt?.toISOString?.(), (d.problems ?? []).join("; "),
      ].map(csvCell).join(",") + "\n",
    );
  }
  res.end();
});

organizerRouter.put("/organizer/settings", async (req, res) => {
  const b = parse(z.object({ deadlineAt: z.coerce.date(), graceSeconds: z.number().int().min(0).max(3600) }), req.body);
  await setDeadlineSettings(b.deadlineAt, b.graceSeconds);
  res.json({ ok: true, ...b });
});
