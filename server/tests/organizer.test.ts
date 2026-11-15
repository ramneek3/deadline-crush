import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import { app, api, auth, setup, teardown, resetAll, openWindow, newTeam, newOrganizer, uploadFile, createVersion, waitStatus, withWorker } from "./helpers";
import { zipOf, tinyPdf, fakePdfExe } from "./fixtures";
import { setClock } from "../src/lib/clock";
import { setDeadlineSettings } from "../src/lib/policy";

beforeAll(setup);
afterAll(teardown);
beforeEach(async () => {
  await resetAll();
  await openWindow();
});

describe("organizer dashboard", () => {
  it("counts submissions, late attempts and failed checks", async () => {
    const org = await newOrganizer();
    const [a, b, c] = [await newTeam("a"), await newTeam("b"), await newTeam("c")];
    await withWorker(async () => {
      const ok = await uploadFile(a.token, zipOf({ "README.md": "x" }), { fileName: "a.zip" });
      const bad = await uploadFile(b.token, fakePdfExe(), { fileName: "b.pdf" });
      await waitStatus(ok.versionId!, "accepted");
      await waitStatus(bad.versionId!, "needs_fix");
    });
    // Team c tries to submit after the deadline.
    const D = new Date("2030-01-01T00:00:00Z");
    await setDeadlineSettings(D, 60);
    setClock(() => D.getTime() + 5000);
    expect((await createVersion(c.token, {})).status).toBe(403);
    expect((await createVersion(c.token, {})).status).toBe(403);
    setClock(null);

    const s = (await api().get("/organizer/stats").set(auth(org))).body;
    expect(s.teams).toBe(3);
    expect(s.teamsWithSubmission).toBe(2);
    expect(s.countedByStatus).toMatchObject({ accepted: 1, needs_fix: 1 });
    expect(s.failedChecks).toBe(1);
    expect(s.lateAttempts).toBe(2);
    expect(s.lateAttemptsByReason).toEqual({ deadline_passed: 2 });
  });

  it("exports one row per team (the version that counts) as CSV", async () => {
    const org = await newOrganizer();
    const a = await newTeam("a");
    await withWorker(async () => {
      const v1 = await uploadFile(a.token, zipOf({ "README.md": "1" }), { title: "first", fileName: "a.zip" });
      await waitStatus(v1.versionId!, "accepted");
      const edit = await createVersion(a.token, { title: "second" });
      await waitStatus(edit.body.version.id, "accepted");
    });
    const res = await api().get("/organizer/export.csv").set(auth(org));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.trim().split("\n");
    expect(lines).toHaveLength(2); // header + one team
    expect(lines[0]).toContain("team,version_no,title");
    expect(lines[1]).toContain('"2","second"'); // latest version, not the first
  });

  it("neutralises spreadsheet formula injection in the CSV", async () => {
    const org = await newOrganizer();
    const a = await newTeam("a");
    await withWorker(async () => {
      const r = await uploadFile(a.token, zipOf({ "README.md": "x" }), { title: "=HYPERLINK(\"http://evil\")", fileName: "a.zip" });
      await waitStatus(r.versionId!, "accepted");
    });
    const res = await api().get("/organizer/export.csv").set(auth(org));
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it("lets the organizer change the deadline and grace window", async () => {
    const org = await newOrganizer();
    const when = new Date(Date.now() + 7200_000).toISOString();
    expect((await api().put("/organizer/settings").set(auth(org)).send({ deadlineAt: when, graceSeconds: 90 })).status).toBe(200);
    const s = (await api().get("/organizer/stats").set(auth(org))).body;
    expect(s.graceSeconds).toBe(90);
    expect(new Date(s.deadlineAt).toISOString()).toBe(when);
    expect((await api().put("/organizer/settings").set(auth(org)).send({ deadlineAt: "nonsense", graceSeconds: 90 })).status).toBe(400);
  });
});

describe("live status without refreshing (SSE)", () => {
  async function openStream(path: string, token: string) {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${path}?token=${token}`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events: { event: string; data: any }[] = [];
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /event: (.*)/.exec(block)?.[1];
            const data = /data: (.*)/.exec(block)?.[1];
            if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return { res, events, close: () => { ctl.abort(); server.close(); } };
  }

  const until = async (fn: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("pushes status changes to the team as they happen", async () => {
    const t = await newTeam();
    const s = await openStream("/events", t.token);
    try {
      expect(s.res.headers.get("content-type")).toContain("text/event-stream");
      await until(() => s.events.some((e) => e.event === "ready"));
      await withWorker(async () => {
        await uploadFile(t.token, zipOf({ "README.md": "x" }), { fileName: "a.zip" });
        await until(() => s.events.some((e) => e.data.status === "accepted"));
      });
      expect(s.events.filter((e) => e.event === "status").map((e) => e.data.status)).toEqual(["uploading", "queued", "checking", "accepted"]);
    } finally {
      s.close();
    }
  });

  it("does not leak one team's events to another team", async () => {
    const a = await newTeam("a");
    const b = await newTeam("b");
    const sb = await openStream("/events", b.token);
    try {
      await until(() => sb.events.some((e) => e.event === "ready"));
      await uploadFile(a.token, tinyPdf(), { complete: false });
      await new Promise((r) => setTimeout(r, 600));
      expect(sb.events.filter((e) => e.event === "status")).toEqual([]);
    } finally {
      sb.close();
    }
  });

  it("requires authentication, and organizer feed is organizer-only", async () => {
    const t = await newTeam();
    expect((await api().get("/events")).status).toBe(401);
    expect((await api().get("/organizer/events").set(auth(t.token))).status).toBe(403);
  });

  it("organizer feed ticks when anything changes", async () => {
    const org = await newOrganizer();
    const t = await newTeam();
    const s = await openStream("/organizer/events", org);
    try {
      await until(() => s.events.some((e) => e.event === "ready"));
      await uploadFile(t.token, tinyPdf(), { complete: false });
      await until(() => s.events.some((e) => e.event === "status"));
    } finally {
      s.close();
    }
  });
});
