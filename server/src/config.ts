const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  mongoUrl: env.MONGO_URL ?? "mongodb://127.0.0.1:27017/deadline_crush",
  redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
  jwtSecret: env.JWT_SECRET ?? "dev-secret-change-me",
  jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 60 * 60 * 24),
  corsOrigin: env.CORS_ORIGIN ?? "*",
  s3: {
    endpoint: env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    // Endpoint embedded in presigned URLs (must be reachable from the browser).
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: env.S3_REGION ?? "auto",
    bucket: env.S3_BUCKET ?? "submissions",
    accessKeyId: env.S3_ACCESS_KEY ?? "S3RVER",
    secretAccessKey: env.S3_SECRET_KEY ?? "S3RVER",
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  },
  upload: {
    maxFileBytes: Number(env.MAX_FILE_BYTES ?? 100 * 1024 * 1024),
    partSizeBytes: Number(env.PART_SIZE_BYTES ?? 8 * 1024 * 1024),
    maxUrlTtlSeconds: Number(env.MAX_URL_TTL_SECONDS ?? 15 * 60),
  },
  deadline: {
    // Used only to seed the settings document the first time.
    defaultDeadlineAt: env.DEADLINE_AT ?? "2099-01-01T00:00:00.000Z",
    defaultGraceSeconds: Number(env.GRACE_SECONDS ?? 300),
  },
  worker: {
    concurrency: Number(env.WORKER_CONCURRENCY ?? 4),
    lockDurationMs: Number(env.WORKER_LOCK_MS ?? 30_000),
    maxEntries: Number(env.ZIP_MAX_ENTRIES ?? 10_000),
    maxUncompressedBytes: Number(env.ZIP_MAX_UNCOMPRESSED ?? 1024 * 1024 * 1024),
    maxRatio: Number(env.ZIP_MAX_RATIO ?? 100),
    linkTimeoutMs: Number(env.LINK_TIMEOUT_MS ?? 5000),
    // Test hook: artificial delay inside the job so a worker can be killed mid-job.
    testDelayMs: Number(env.WORKER_TEST_DELAY_MS ?? 0),
    allowPrivateLinks: (env.ALLOW_PRIVATE_LINKS ?? "false") === "true",
  },
} as const;
