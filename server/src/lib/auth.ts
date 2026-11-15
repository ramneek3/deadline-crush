import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { User } from "./models";

export interface AuthUser {
  id: string;
  role: "team" | "organizer";
  teamId: string | null;
}
declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

export const hashPassword = (p: string) => bcrypt.hash(p, 8);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

export const signToken = (u: AuthUser) =>
  jwt.sign({ sub: u.id, role: u.role, teamId: u.teamId }, config.jwtSecret, {
    expiresIn: config.jwtTtlSeconds,
  });

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  // EventSource cannot set headers, so SSE endpoints accept ?token= as well.
  const raw = h?.startsWith("Bearer ") ? h.slice(7) : (req.query.token as string | undefined);
  if (!raw) return res.status(401).json({ error: "unauthenticated" });
  try {
    const p = jwt.verify(raw, config.jwtSecret) as jwt.JwtPayload;
    req.user = { id: String(p.sub), role: p.role, teamId: p.teamId ?? null };
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

export function requireOrganizer(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "organizer") return res.status(403).json({ error: "organizer_only" });
  next();
}

/** Team routes: the caller must belong to a team. Membership is re-read from the DB, not the token. */
export async function requireTeamMember(req: Request, res: Response, next: NextFunction) {
  const user = await User.findById(req.user!.id).select("teamId role").lean();
  if (!user?.teamId || user.role !== "team") return res.status(403).json({ error: "no_team" });
  req.user!.teamId = String(user.teamId);
  next();
}
