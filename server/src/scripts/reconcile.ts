/**
 * Proves "nothing was lost" after a load test.
 *   npx tsx src/scripts/reconcile.ts ../loadtest/results/ledger.log
 *
 * The k6 run logs a LEDGER line for every submission the API acknowledged to a team.
 * Each of those must now exist in the database, have been checked exactly once, and the version
 * that counts for every team must be the newest acknowledged one.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { connectDb, disconnectDb } from "../lib/db";
import { Version, CheckResult } from "../lib/models";

interface Entry { teamId: string; versionId: string; versionNo: number }

async function main() {
  const file = process.argv[2] ?? "../loadtest/results/ledger.log";
  const reportPath = process.argv[3] ?? "../loadtest/results/reconcile.json";
  const ledger = new Map<string, Entry>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const i = line.indexOf("LEDGER ");
    if (i < 0) continue;
    try {
      const e = JSON.parse(line.slice(i + 7)) as Entry;
      ledger.set(e.versionId, e);
    } catch {
      /* partial line */
    }
  }
  await connectDb();
  const ids = [...ledger.keys()];

  // Wait for the workers to drain the queue.
  const deadline = Date.now() + Number(process.env.DRAIN_TIMEOUT_MS ?? 120_000);
  let pending = 0;
  for (;;) {
    pending = await Version.countDocuments({ status: { $in: ["queued", "checking"] } });
    if (pending === 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const versions = await Version.find({ _id: { $in: ids } }).select("teamId versionNo status").lean();
  const byId = new Map(versions.map((v) => [String(v._id), v]));
  const missing = ids.filter((id) => !byId.has(id));
  const notAccepted = versions.filter((v) => v.status !== "accepted").map((v) => ({ id: String(v._id), status: v.status }));

  const resultCounts = await CheckResult.aggregate([{ $match: { versionId: { $in: versions.map((v) => v._id) } } }, { $group: { _id: "$versionId", n: { $sum: 1 } } }]);
  const resultsById = new Map(resultCounts.map((r) => [String(r._id), r.n as number]));
  const noResult = versions.filter((v) => !resultsById.has(String(v._id))).length;
  const duplicateResults = resultCounts.filter((r) => r.n > 1).length;

  // The version that counts for each team = its newest acknowledged version.
  const newest = new Map<string, Entry>();
  for (const e of ledger.values()) if (!newest.has(e.teamId) || e.versionNo > newest.get(e.teamId)!.versionNo) newest.set(e.teamId, e);
  let wrongCounted = 0;
  const counted = await Version.aggregate([
    { $match: { status: { $ne: "uploading" } } },
    { $sort: { teamId: 1, versionNo: -1 } },
    { $group: { _id: "$teamId", versionId: { $first: "$_id" } } },
  ]);
  const countedByTeam = new Map(counted.map((c) => [String(c._id), String(c.versionId)]));
  for (const [teamId, e] of newest) if (countedByTeam.get(teamId) !== e.versionId) wrongCounted++;

  const storedNotAcknowledged = await Version.countDocuments({ completedAt: { $ne: null }, _id: { $nin: ids } });
  const report = {
    acknowledgedSubmissions: ids.length,
    teamsWithASubmission: newest.size,
    foundInDatabase: versions.length,
    missing: missing.length,
    notAccepted,
    stillPendingAfterDrain: pending,
    withoutCheckResult: noResult,
    duplicateCheckResults: duplicateResults,
    wrongVersionCounted: wrongCounted,
    storedButNotAcknowledgedToClient: storedNotAcknowledged,
    lost: missing.length + noResult + pending + notAccepted.length + duplicateResults + wrongCounted,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(report.lost === 0 ? "\nPASS: every acknowledged submission is stored, checked exactly once, and counted correctly." : "\nFAIL: see report above.");
  await disconnectDb();
  process.exit(report.lost === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
