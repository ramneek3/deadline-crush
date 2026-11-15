import { Router } from "express";
import { z } from "zod";
import { User, Team } from "../../lib/models";
import { hashPassword, checkPassword, signToken, requireAuth } from "../../lib/auth";
import { HttpError, parse } from "../../lib/http";
import { getDeadlineSettings } from "../../lib/policy";
import { now } from "../../lib/clock";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(100),
  teamName: z.string().trim().min(2).max(80),
});

authRouter.post("/auth/register", async (req, res) => {
  const b = parse(registerSchema, req.body);
  if (await User.exists({ email: b.email.toLowerCase() })) throw new HttpError(409, "email_taken");
  let team;
  try {
    team = await Team.create({ name: b.teamName, memberIds: [] });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, "team_name_taken");
    throw e;
  }
  try {
    const user = await User.create({
      email: b.email,
      name: b.name,
      passwordHash: await hashPassword(b.password),
      role: "team",
      teamId: team._id,
    });
    await Team.updateOne({ _id: team._id }, { $addToSet: { memberIds: user._id } });
    const token = signToken({ id: String(user._id), role: "team", teamId: String(team._id) });
    res.status(201).json({ token, user: { id: user._id, name: user.name, role: user.role }, team: { id: team._id, name: team.name } });
  } catch (e) {
    await Team.deleteOne({ _id: team._id }); // don't leave an orphan team behind
    if ((e as { code?: number }).code === 11000) throw new HttpError(409, "email_taken");
    throw e;
  }
});

authRouter.post("/auth/login", async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
  const user = await User.findOne({ email: b.email.toLowerCase() });
  // Same response for unknown email and wrong password.
  if (!user || !(await checkPassword(b.password, user.passwordHash))) throw new HttpError(401, "invalid_credentials");
  const token = signToken({ id: String(user._id), role: user.role, teamId: user.teamId ? String(user.teamId) : null });
  res.json({ token, user: { id: user._id, name: user.name, role: user.role } });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user!.id).select("name email role teamId").lean();
  if (!user) throw new HttpError(401, "invalid_token");
  const team = user.teamId ? await Team.findById(user.teamId).select("name memberIds").lean() : null;
  const s = await getDeadlineSettings();
  res.json({
    user: { id: user._id, name: user.name, email: user.email, role: user.role },
    team: team ? { id: team._id, name: team.name, members: team.memberIds.length } : null,
    deadline: { deadlineAt: s.deadlineAt, graceSeconds: s.graceSeconds, serverTime: now() },
  });
});
