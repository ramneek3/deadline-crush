import { createApp } from "./app";
import { config } from "../config";
import { connectDb } from "../lib/db";
import { ensureBucket, ensureCors } from "../lib/s3";

async function main() {
  await connectDb();
  await ensureBucket().catch((e) => console.warn("ensureBucket:", e.message));
  await ensureCors((process.env.S3_CORS_ORIGINS ?? "*").split(",")).catch((e) => console.warn("ensureCors:", e.message));
  const server = createApp().listen(config.port, () => console.log(`api listening on :${config.port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
