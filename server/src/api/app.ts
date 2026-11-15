import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "../config";
import { errorHandler } from "../lib/http";
import { authRouter } from "./routes/auth";
import { versionsRouter } from "./routes/versions";
import { uploadsRouter } from "./routes/uploads";
import { organizerRouter } from "./routes/organizer";
import { eventsRouter } from "./routes/events";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","), allowedHeaders: ["Authorization", "Content-Type"] }));
  app.use(express.json({ limit: "100kb" })); // JSON only; file bytes never come through here

  const limiting = process.env.RATE_LIMIT !== "off";
  if (limiting) {
    app.use("/auth", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
    app.use(
      ["/versions"],
      rateLimit({
        windowMs: 60_000,
        limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 600),
        standardHeaders: true,
        legacyHeaders: false,
        // Per user when we can tell, otherwise per IP.
        keyGenerator: (req) => (req.headers.authorization ? `a:${req.headers.authorization.slice(-40)}` : "ip:" + (req.ip ?? "?")),
        validate: { keyGeneratorIpFallback: false },
      }),
    );
  }

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(authRouter);
  app.use(eventsRouter);
  app.use(organizerRouter);
  app.use(versionsRouter);
  app.use(uploadsRouter);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(errorHandler);
  return app;
}
