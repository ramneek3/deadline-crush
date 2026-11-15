import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, setup, teardown, resetAll, openWindow, newTeam, newOrganizer, uploadFile, createVersion, waitStatus, withWorker } from "./helpers";
import { tinyPdf } from "./fixtures";

beforeAll(setup);
afterAll(teardown);
beforeEach(async () => {
  await resetAll();
  await openWindow();
});

describe("authentication", () => {
  it("registers a team and returns a token", async () => {
    const r = await api().post("/auth/register").send({ email: "a@example.com", password: "password123", name: "A", teamName: "Alpha" });
    expect(r.status).toBe(201);
    expect(r.body.token).toBeTruthy();
    expect(r.body.team.name).toBe("Alpha");
  });

  it("rejects a duplicate email and a duplicate team name", async () => {
    await api().post("/auth/register").send({ email: "a@example.com", password: "password123", name: "A", teamName: "Alpha" });
    const dupEmail = await api().post("/auth/register").send({ email: "A@example.com", password: "password123", name: "B", teamName: "Beta" });
    expect(dupEmail.status).toBe(409);
    const dupTeam = await api().post("/auth/register").send({ email: "b@example.com", password: "password123", name: "B", teamName: "Alpha" });
    expect(dupTeam.status).toBe(409);
  });

  it("validates registration input", async () => {
    const r = await api().post("/auth/register").send({ email: "not-an-email", password: "short", name: "", teamName: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation_failed");
    expect(r.body.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("logs in with the right password and gives the same error for unknown user and wrong password", async () => {
    await api().post("/auth/register").send({ email: "a@example.com", password: "password123", name: "A", teamName: "Alpha" });
    expect((await api().post("/auth/login").send({ email: "a@example.com", password: "password123" })).status).toBe(200);
    const wrong = await api().post("/auth/login").send({ email: "a@example.com", password: "wrong-password" });
    const unknown = await api().post("/auth/login").send({ email: "nobody@example.com", password: "password123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("requires a valid token", async () => {
    expect((await api().get("/versions")).status).toBe(401);
    expect((await api().get("/versions").set({ Authorization: "Bearer garbage" })).status).toBe(401);
  });

  it("keeps organizer endpoints away from team accounts", async () => {
    const t = await newTeam();
    expect((await api().get("/organizer/stats").set(auth(t.token))).status).toBe(403);
    expect((await api().get("/organizer/export.csv").set(auth(t.token))).status).toBe(403);
    expect((await api().put("/organizer/settings").set(auth(t.token)).send({ deadlineAt: new Date(), graceSeconds: 0 })).status).toBe(403);
    const org = await newOrganizer();
    expect((await api().get("/organizer/stats").set(auth(org))).status).toBe(200);
  });
});

describe("only team members can see or change a team's submission", () => {
  it("team B cannot read, download or touch team A's version or upload", async () => {
    const a = await newTeam("a");
    const b = await newTeam("b");
    const up = await uploadFile(a.token, tinyPdf(), { complete: false });
    const id = up.versionId!;

    // Team A sees it; team B gets "not found" for every route, indistinguishable from a missing id.
    expect((await api().get(`/versions/${id}`).set(auth(a.token))).status).toBe(200);
    expect((await api().get(`/versions/${id}`).set(auth(b.token))).status).toBe(404);
    expect((await api().get(`/versions/${id}/download`).set(auth(b.token))).status).toBe(404);
    expect((await api().get(`/versions/${id}/upload`).set(auth(b.token))).status).toBe(404);
    expect((await api().post(`/versions/${id}/upload/parts`).set(auth(b.token)).send({ parts: [1] })).status).toBe(404);
    expect((await api().put(`/versions/${id}/upload/parts/1`).set(auth(b.token)).send({ etag: "x", size: 1 })).status).toBe(404);
    expect((await api().post(`/versions/${id}/upload/complete`).set(auth(b.token)).send({})).status).toBe(404);
    expect((await api().delete(`/versions/${id}/upload`).set(auth(b.token))).status).toBe(404);

    const list = await api().get("/versions").set(auth(b.token));
    expect(list.body.versions).toEqual([]);
  });

  it("rejects malformed ids without leaking errors", async () => {
    const t = await newTeam();
    expect((await api().get("/versions/not-an-id").set(auth(t.token))).status).toBe(404);
  });

  it("only issues a download URL to the owning team", async () => {
    const a = await newTeam("a");
    await withWorker(async () => {
      const r = await uploadFile(a.token, tinyPdf());
      await waitStatus(r.versionId!, "accepted"); // the worker assembles the object, then checks it
    });
    const list = await api().get("/versions").set(auth(a.token));
    const dl = await api().get(`/versions/${list.body.versions[0].id}/download`).set(auth(a.token));
    expect(dl.status).toBe(200);
    expect(dl.body.url).toMatch(/X-Amz-Expires=/);
    const get = await fetch(dl.body.url);
    expect(get.status).toBe(200);
  });
});
