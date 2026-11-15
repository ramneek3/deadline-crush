// k6 run loadtest/submit.js
//
// Simulates the final 10 minutes of a hackathon: 2,000 teams each submit a ~1.5 MB zip.
// Arrivals start slow and end in a burst, the way real deadlines behave. Each team:
//   create version -> get part URL -> PUT bytes straight to object storage -> ack part -> complete
//   -> poll status until the worker has checked it (the polling fallback of the live status feed)
// A quarter of teams then make a text-only edit (a second version).
// Every acknowledged completion is written to the console as a JSON "ledger" line; reconcile.ts
// compares that ledger with the database to prove nothing was lost.
import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";

const TEAMS = Number(__ENV.TEAMS || 2000);
const API = __ENV.API_URL || "http://127.0.0.1:4000";
const SCALE = Number(__ENV.SCALE || 1); // 1 = full 10 minutes; 0.2 = a 2-minute rehearsal

const tokens = new SharedArray("tokens", () => JSON.parse(open("./tokens.json")));
const fixture = open("./fixture.zip", "b");

const BURST_ONLY = __ENV.PROFILE === "burst"; // 60 s straight into the last-minute rate, for profiling
const min = (m) => `${Math.max(1, Math.round(m * 60 * SCALE))}s`;
export const options = {
  scenarios: {
    deadline_crush: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 600,
      maxVUs: 1500,
      stages: BURST_ONLY ? [{ target: 35, duration: "60s" }] : [
        { target: 1, duration: min(6) }, // slow trickle
        { target: 5, duration: min(3) }, // picking up
        { target: 35, duration: min(1) }, // the last-minute burst
      ],
    },
  },
  thresholds: {
    "http_req_duration{kind:api}": ["p(95)<300"],
    "http_req_failed{kind:api}": ["rate<0.001"],
    // Per-endpoint breakdown (loose limits; they exist so k6 reports each endpoint separately).
    "http_req_duration{name:create_version}": ["p(95)<2000"],
    "http_req_duration{name:presign}": ["p(95)<2000"],
    "http_req_duration{name:ack_part}": ["p(95)<2000"],
    "http_req_duration{name:complete}": ["p(95)<2000"],
    "http_req_duration{name:get_version}": ["p(95)<2000"],
    "http_req_duration{name:put_part}": ["p(95)<5000"],
    checks: ["rate>0.999"],
    dropped_iterations: ["count==0"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const api = (name) => ({ tags: { kind: "api", name } });

function headers(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export default function () {
  const i = exec.scenario.iterationInTest;
  if (i >= TEAMS) return; // exactly one submission per team
  const { token } = tokens[i];
  const H = headers(token);

  const created = http.post(
    `${API}/versions`,
    JSON.stringify({ title: `Project ${i}`, description: "load test", links: [], file: { name: "project.zip", size: fixture.byteLength, contentType: "application/zip" } }),
    { headers: H, ...api("create_version") },
  );
  if (!check(created, { "create 201": (r) => r.status === 201 })) return;
  const { version, upload } = created.json();

  const presigned = http.post(`${API}/versions/${version.id}/upload/parts`, JSON.stringify({ parts: [1] }), { headers: H, ...api("presign") });
  if (!check(presigned, { "presign 200": (r) => r.status === 200 })) return;

  // Bytes go straight to object storage, never through the API. Tracked separately.
  const part = presigned.json().parts[0];
  const put = http.put(part.url, fixture, { tags: { kind: "storage", name: "put_part" } });
  if (!check(put, { "storage PUT 200": (r) => r.status === 200 })) return;

  const ack = http.put(`${API}/versions/${version.id}/upload/parts/1`, JSON.stringify({ etag: put.headers["Etag"] || put.headers["ETag"], size: fixture.byteLength }), { headers: H, ...api("ack_part") });
  check(ack, { "ack 200": (r) => r.status === 200 });

  const done = http.post(`${API}/versions/${version.id}/upload/complete`, "{}", { headers: H, ...api("complete") });
  if (!check(done, { "complete 200": (r) => r.status === 200 })) return;
  // LEDGER: this submission was acknowledged to the team, so it must never be lost.
  console.log("LEDGER " + JSON.stringify({ teamId: tokens[i].teamId, versionId: version.id, versionNo: version.versionNo }));

  // Poll status like a browser without SSE would.
  let status = "queued";
  for (let n = 0; n < 40 && status !== "accepted" && status !== "needs_fix" && status !== "failed"; n++) {
    sleep(1.5);
    const rr = http.get(`${API}/versions/${version.id}`, { headers: H, ...api("get_version") });
    if (rr.status === 200) status = rr.json().version.status;
  }
  check(status, { "checked by a worker": (s) => s === "accepted" });

  if (i % 4 === 0) {
    const edit = http.post(`${API}/versions`, JSON.stringify({ title: `Project ${i} (edited)`, description: "final polish", links: [] }), { headers: H, ...api("create_version") });
    if (check(edit, { "edit 201": (r) => r.status === 201 })) {
      console.log("LEDGER " + JSON.stringify({ teamId: tokens[i].teamId, versionId: edit.json().version.id, versionNo: edit.json().version.versionNo }));
    }
  }
}
