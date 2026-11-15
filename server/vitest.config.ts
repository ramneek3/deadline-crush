import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false, // tests share one Mongo db, one Redis db and one bucket
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts"],
    env: {
      MONGO_URL: process.env.TEST_MONGO_URL ?? "mongodb://127.0.0.1:27017/deadline_crush_test",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/1",
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
      S3_BUCKET: process.env.S3_BUCKET ?? "submissions",
      RATE_LIMIT: "off",
      JWT_SECRET: "test-secret",
      PART_SIZE_BYTES: String(1024 * 1024), // 1 MiB parts keep multipart tests fast
      ZIP_MAX_ENTRIES: "50",
      ALLOW_PRIVATE_LINKS: "true", // tests use a local http server for link checks
      LINK_TIMEOUT_MS: "1500",
      DEADLINE_AT: "2099-01-01T00:00:00.000Z",
      GRACE_SECONDS: "300",
    },
  },
});
