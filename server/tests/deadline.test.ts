import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, setup, teardown, resetAll, newTeam, uploadFile, putParts, createVersion } from "./helpers";
import { tinyPdf } from "./fixtures";
import { setClock } from "../src/lib/clock";
import { setDeadlineSettings, canCreateVersion, canContinueUpload, urlTtlSeconds } from "../src/lib/policy";
import { Attempt, Version } from "../src/lib/models";

const D = new Date("2030-06-01T12:00:00.000Z"); // the deadline
const at = (offsetSeconds: number) => setClock(() => D.getTime() + offsetSeconds * 1000);
const GRACE = 120;

beforeAll(setup);
afterAll(teardown);
beforeEach(async () => {
  await resetAll();
  await setDeadlineSettings(D, GRACE);
});

describe("deadline policy (pure)", () => {
  const s = { deadlineAt: D, graceSeconds: GRACE };
  it("allows creation strictly before the deadline and refuses at the exact instant", () => {
    expect(canCreateVersion(new Date(D.getTime() - 1), s).ok).toBe(true);
    expect(canCreateVersion(new Date(D.getTime()), s).ok).toBe(false);
    expect(canCreateVersion(new Date(D.getTime() + 1), s).ok).toBe(false);
  });
  it("lets an upload started before the deadline finish until deadline + grace, then stops", () => {
    const started = new Date(D.getTime() - 5000);
    expect(canContinueUpload(started, new Date(D.getTime() + GRACE * 1000 - 1), s).ok).toBe(true);
    const over = canContinueUpload(started, new Date(D.getTime() + GRACE * 1000), s);
    expect(over).toMatchObject({ ok: false, reason: "grace_period_over" });
  });
  it("never lets an upload that started after the deadline continue, grace or not", () => {
    const r = canContinueUpload(new Date(D.getTime() + 1000), new Date(D.getTime() + 2000), s);
    expect(r).toMatchObject({ ok: false, reason: "upload_started_after_deadline" });
  });
  it("caps signed-URL lifetime so no URL outlives deadline + grace", () => {
    expect(urlTtlSeconds(new Date(D.getTime() - 3600_000), s)).toBe(900); // plenty of time: default cap
    expect(urlTtlSeconds(new Date(D.getTime() + 100_000), s)).toBe(20); // 20 s of grace left
    expect(urlTtlSeconds(new Date(D.getTime() + 500_000), s)).toBe(1); // never zero or negative
  });
});

describe("deadline policy (API, server clock)", () => {
  it("accepts a new version before the deadline", async () => {
    const t = await newTeam();
    at(-60);
    expect((await createVersion(t.token, {})).status).toBe(201);
  });

  it("refuses a new version at and after the deadline, and records it as a late attempt", async () => {
    const t = await newTeam();
    at(0);
    const r = await createVersion(t.token, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("deadline_passed");
    at(30);
    expect((await createVersion(t.token, {})).status).toBe(403);
    expect(await Attempt.countDocuments({ late: true, reason: "deadline_passed" })).toBe(2);
    expect(await Version.countDocuments({})).toBe(0);
  });

  it("ignores any client-supplied time: only the server clock decides", async () => {
    const t = await newTeam();
    at(60);
    const r = await api().post("/versions").set(auth(t.token)).set("Date", new Date(D.getTime() - 1000).toUTCString()).send({ title: "sneaky", createdAt: new Date(D.getTime() - 1000), links: [] });
    expect(r.status).toBe(403);
  });

  it("lets an upload that started before the deadline finish inside the grace window", async () => {
    const t = await newTeam();
    at(-10);
    const up = await uploadFile(t.token, tinyPdf(), { complete: false });
    at(GRACE - 5); // deadline has passed, grace has not
    const done = await api().post(`/versions/${up.versionId}/upload/complete`).set(auth(t.token)).send({});
    expect(done.status).toBe(200);
    expect(done.body.version.status).toBe("queued");
  });

  it("refuses to complete, presign or ack once grace is over", async () => {
    const t = await newTeam();
    at(-10);
    const up = await uploadFile(t.token, tinyPdf(), { complete: false });
    at(GRACE + 1);
    const done = await api().post(`/versions/${up.versionId}/upload/complete`).set(auth(t.token)).send({});
    expect(done.status).toBe(403);
    expect(done.body.error).toBe("grace_period_over");
    expect((await api().post(`/versions/${up.versionId}/upload/parts`).set(auth(t.token)).send({ parts: [1] })).status).toBe(403);
    expect((await api().put(`/versions/${up.versionId}/upload/parts/1`).set(auth(t.token)).send({ etag: "e", size: 1 })).status).toBe(403);
    expect(await Attempt.countDocuments({ late: true, reason: "grace_period_over" })).toBe(3);
  });

  it("marks an upload nobody finished as expired and never counts it", async () => {
    const t = await newTeam();
    at(-10);
    await uploadFile(t.token, tinyPdf(), { complete: false });
    at(GRACE + 60);
    const list = await api().get("/versions").set(auth(t.token));
    expect(list.body.versions[0].expired).toBe(true);
    expect(list.body.counted).toBeNull();
  });

  it("presigned URLs handed out near the deadline expire with the grace window", async () => {
    const t = await newTeam();
    at(-10);
    const up = await uploadFile(t.token, tinyPdf(), { complete: false });
    at(GRACE - 30);
    const ps = await api().post(`/versions/${up.versionId}/upload/parts`).set(auth(t.token)).send({ parts: [1] });
    expect(ps.body.expiresInSeconds).toBeLessThanOrEqual(30);
  });
});
