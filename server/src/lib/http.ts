import type { Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { Attempt } from "./models";
import { now } from "./clock";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "validation_failed", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...err.extra });
  if ((err as { code?: number })?.code === 11000) return res.status(409).json({ error: "conflict" });
  const e = err as { type?: string; status?: number; name?: string };
  if (e?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
  if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
  if (e?.name === "CastError") return res.status(400).json({ error: "bad_id" });
  console.error(err);
  res.status(500).json({ error: "internal_error" });
}

export async function logAttempt(a: {
  teamId?: string | null;
  userId?: string;
  type: string;
  accepted: boolean;
  reason?: string;
  late?: boolean;
}) {
  await Attempt.create({ ...a, late: a.late ?? false, ts: now() }).catch(() => undefined);
}

export const isObjectId = (s: string) => /^[a-f\d]{24}$/i.test(s);
