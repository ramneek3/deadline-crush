// Local S3-compatible server for development and CI (stands in for MinIO/R2 when Docker is unavailable).
import S3rver from "s3rver";
import { mkdirSync } from "node:fs";
const dir = process.env.S3_DIR ?? "/tmp/s3data";
mkdirSync(dir, { recursive: true });
const port = Number(process.env.S3_PORT ?? 9000);
const s3 = new S3rver({
  port,
  address: "127.0.0.1",
  silent: true,
  directory: dir,
  configureBuckets: [{ name: process.env.S3_BUCKET ?? "submissions", configs: [] }],
  allowMismatchedSignatures: false,
  cors: `<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>`,
} as ConstructorParameters<typeof S3rver>[0]);
await s3.run();
console.log(`dev s3 on :${port}`);
