import { createApp } from "./app";
import { config } from "../config";
import { connectDb } from "../lib/db";
import { ensureBucket, ensureCors } from "../lib/s3";

async function main() {
  await connectDb();
  await ensureBucket().catch((e) => console.warn("ensureBucket:", e.message));
  await ensureCors((process.env.S3_CORS_ORIGINS ?? "*").split(",")).catch((e) => console.warn("ensureCors:", e.message));
  const server = createApp().listen(config.port, () => console.log(`api listening on :${config.port}`));
  // Node closes idle keep-alive sockets after 5 s by default. A client or proxy that reuses a socket
  // at that instant gets a connection reset, so keep sockets open longer than typical proxy idle timeouts.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
