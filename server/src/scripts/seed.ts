/**
 * Seed N teams (one user each) and write their JWTs for the k6 load test.
 *   npx tsx src/scripts/seed.ts --teams 2000 --out ../loadtest
 * Also writes loadtest/fixture.zip (the file every simulated team uploads) and an organizer account.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { Types } from "mongoose";
import { connectDb, disconnectDb } from "../lib/db";
import { User, Team, Version, Upload, CheckResult, Attempt } from "../lib/models";
import { signToken, hashPassword } from "../lib/auth";
import { setDeadlineSettings } from "../lib/policy";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};

async function main() {
  const teams = Number(arg("teams", "2000"));
  const out = arg("out", "../loadtest");
  const fileKb = Number(arg("file-kb", "1500"));
  const deadlineMin = Number(arg("deadline-min", "120"));
  mkdirSync(out, { recursive: true });
  await connectDb();

  if (arg("reset", "true") === "true") {
    await Promise.all([User, Team, Version, Upload, CheckResult, Attempt].map((m) => (m as any).deleteMany({})));
  }

  const pwHash = await hashPassword("loadtest-not-used");
  const teamDocs = Array.from({ length: teams }, (_, i) => ({ _id: new Types.ObjectId(), name: `Load Team ${i + 1}`, memberIds: [] as Types.ObjectId[], versionSeq: 0 }));
  const userDocs = teamDocs.map((t, i) => {
    const u = { _id: new Types.ObjectId(), email: `load-${i + 1}@example.com`, name: `Load User ${i + 1}`, passwordHash: pwHash, role: "team", teamId: t._id };
    t.memberIds.push(u._id);
    return u;
  });
  for (let i = 0; i < teamDocs.length; i += 500) {
    await Team.insertMany(teamDocs.slice(i, i + 500));
    await User.insertMany(userDocs.slice(i, i + 500));
  }
  const org = await User.create({ email: "organizer@example.com", name: "Organizer", role: "organizer", passwordHash: await hashPassword("organizer-password") });

  const tokens = userDocs.map((u) => ({ token: signToken({ id: String(u._id), role: "team", teamId: String(u.teamId) }), teamId: String(u.teamId) }));
  writeFileSync(join(out, "tokens.json"), JSON.stringify(tokens));
  writeFileSync(join(out, "organizer-token.txt"), signToken({ id: String(org._id), role: "organizer", teamId: null }));

  // Incompressible payload so the stored object really is ~fileKb.
  const payload = new Uint8Array(randomBytes(fileKb * 1024));
  writeFileSync(join(out, "fixture.zip"), zipSync({ "README.md": strToU8("# Load test submission\n"), "data.bin": payload }, { level: 0 }));

  await setDeadlineSettings(new Date(Date.now() + deadlineMin * 60_000), 300);
  console.log(`seeded ${teams} teams; tokens -> ${join(out, "tokens.json")}; deadline in ${deadlineMin} min`);
  await disconnectDb();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
