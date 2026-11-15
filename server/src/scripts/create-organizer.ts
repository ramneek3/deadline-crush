// Usage: npx tsx src/scripts/create-organizer.ts <email> <password>
import { connectDb, disconnectDb } from "../lib/db";
import { User } from "../lib/models";
import { hashPassword } from "../lib/auth";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error("usage: create-organizer <email> <password (8+ chars)>");
  process.exit(1);
}
await connectDb();
await User.updateOne(
  { email: email.toLowerCase() },
  { $set: { name: "Organizer", role: "organizer", passwordHash: await hashPassword(password), teamId: null } },
  { upsert: true },
);
console.log(`organizer ready: ${email}`);
await disconnectDb();
