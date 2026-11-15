import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import { Redis } from "ioredis";
import { createApp } from "../src/api/app";
import { connectDb } from "../src/lib/db";
import { ensureBucket, ensureCors } from "../src/lib/s3";
import { closeQueue, getQueue } from "../src/lib/queue";
import { closeEvents } from "../src/lib/events";
import { User, Version, CheckResult, Attempt, Upload, Team, Settings } from "../src/lib/models";
import { hashPassword } from "../src/lib/auth";
import { setClock } from "../src/lib/clock";
import { setDeadlineSettings, invalidateSettingsCache } from "../src/lib/policy";
import { startWorker } from "../src/worker/main";

export const app = createApp();
export const api = () => request(app);

export async function setup() {
  await connectDb();
  await ensureBucket();
  await ensureCors();
}

export async function resetAll() {
  setClock(null);
  await Promise.all([
    User.deleteMany({}), Version.deleteMany({}), CheckResult.deleteMany({}), Attempt.deleteMany({}),
    Upload.deleteMany({}), Team.deleteMany({}), Settings.deleteMany({}),
  ]);
  invalidateSettingsCache();
  await getQueue().obliterate({ force: true }).catch(() => undefined);
  const r = new Redis(process.env.REDIS_URL!);
  await r.flushdb();
  await r.quit();
}

export async function teardown() {
  await closeQueue();
  await closeEvents();
  await mongoose.disconnect();
}

export const futureDeadline = (ms = 3600_000) => new Date(Date.now() + ms);
export const openWindow = () => setDeadlineSettings(futureDeadline(), 300);

let n = 0;
export async function newTeam(label = "t") {
  n++;
  const email = `${label}${n}-${Date.now()}@example.com`;
  const res = await api().post("/auth/register").send({ email, password: "password123", name: `User ${n}`, teamName: `Team ${label}${n}-${Date.now()}` });
  if (res.status !== 201) throw new Error("register failed " + JSON.stringify(res.body));
  return { token: res.body.token as string, teamId: res.body.team.id as string, email };
}

export async function newOrganizer() {
  const email = `org-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await User.create({ email, name: "Organizer", role: "organizer", passwordHash: await hashPassword("password123") });
  const res = await api().post("/auth/login").send({ email, password: "password123" });
  return res.body.token as string;
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

export async function createVersion(token: string, body: Record<string, unknown>) {
  return api().post("/versions").set(auth(token)).send({ title: "My project", description: "d", links: [], ...body });
}

export interface UploadOpts {
  /** upload only these part numbers (to simulate an interrupted upload) */
  only?: number[];
  declaredSize?: number;
  title?: string;
  links?: string[];
  fileName?: string;
}

/** Run the real client flow: create version -> presign -> PUT bytes to storage -> ack -> (optionally) complete. */
export async function uploadFile(token: string, bytes: Buffer, opts: UploadOpts & { complete?: boolean } = {}) {
  const create = await createVersion(token, {
    title: opts.title ?? "Project",
    links: opts.links ?? [],
    file: { name: opts.fileName ?? "project.pdf", size: opts.declaredSize ?? bytes.length, contentType: "application/octet-stream" },
  });
  if (create.status !== 201) return { create, versionId: null as string | null };
  const versionId = create.body.version.id as string;
  const { partSize, partCount } = create.body.upload;
  const want = opts.only ?? Array.from({ length: partCount }, (_, i) => i + 1);
  await putParts(token, versionId, bytes, partSize, want);
  let complete;
  if (opts.complete !== false) complete = await api().post(`/versions/${versionId}/upload/complete`).set(auth(token)).send({});
  return { create, versionId, complete, partSize, partCount };
}

export async function putParts(token: string, versionId: string, bytes: Buffer, partSize: number, parts: number[]) {
  const ps = await api().post(`/versions/${versionId}/upload/parts`).set(auth(token)).send({ parts });
  if (ps.status !== 200) throw new Error("presign failed " + JSON.stringify(ps.body));
  for (const p of ps.body.parts as { n: number; url: string }[]) {
    const slice = bytes.subarray((p.n - 1) * partSize, Math.min(bytes.length, p.n * partSize));
    const r = await fetch(p.url, { method: "PUT", body: new Uint8Array(slice) });
    if (!r.ok) throw new Error(`PUT part ${p.n} failed: ${r.status}`);
    const etag = r.headers.get("etag") ?? "";
    await api().put(`/versions/${versionId}/upload/parts/${p.n}`).set(auth(token)).send({ etag, size: slice.length }).expect(200);
  }
}

export async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, ms = 20_000, every = 100): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, every));
  }
}

export const waitStatus = (versionId: string, ...statuses: string[]) =>
  waitFor(async () => {
    const v = await Version.findById(versionId).lean();
    return v && statuses.includes(v.status) ? v : null;
  });

export async function withWorker<T>(fn: () => Promise<T>): Promise<T> {
  const { close } = await startWorker();
  try {
    return await fn();
  } finally {
    await close();
  }
}

/** A throwaway http server to act as a "submitted link" target. */
export async function linkServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") return res.writeHead(200).end("ok");
    if (req.url === "/redirect") return res.writeHead(302, { Location: "/ok" }).end();
    res.writeHead(404).end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
