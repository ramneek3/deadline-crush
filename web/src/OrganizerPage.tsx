import { useCallback, useEffect, useState } from "react";
import { API_URL, api, explain, getToken, type Stats } from "./api";
import { Countdown } from "./Countdown";
import { useEvents } from "./useEvents";

const Tile = ({ label, value, tone }: { label: string; value: number | string; tone?: string }) => (
  <div className={`tile ${tone ?? ""}`}>
    <div className="num">{value}</div>
    <div className="lbl">{label}</div>
  </div>
);

export function OrganizerPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api.get<Stats>("/organizer/stats").then(setS).catch((e) => setError(explain(e))), []);
  useEffect(() => void load(), [load]);
  useEvents("/organizer/events", () => void load(), () => void load());

  async function download() {
    const res = await fetch(`${API_URL}/organizer/export.csv`, { headers: { Authorization: `Bearer ${getToken()}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: "submissions.csv" });
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!s) return <main>{error ? <p role="alert" className="error">{error}</p> : <p>Loading…</p>}</main>;
  const by = s.countedByStatus;
  return (
    <main>
      <header className="bar">
        <div>
          <h1>Organizer dashboard</h1>
          <Countdown deadlineAt={s.deadlineAt} graceSeconds={s.graceSeconds} serverTime={s.serverTime} />
        </div>
        <button className="primary" onClick={() => void download()}>Export CSV</button>
      </header>
      <section className="tiles" aria-label="Live counts">
        <Tile label="Teams registered" value={s.teams} />
        <Tile label="Teams with a submission" value={s.teamsWithSubmission} />
        <Tile label="Total versions saved" value={s.totalVersions} />
        <Tile label="Late attempts refused" value={s.lateAttempts} tone={s.lateAttempts ? "warn" : ""} />
        <Tile label="Failed checks (counted version)" value={s.failedChecks} tone={s.failedChecks ? "bad" : ""} />
      </section>
      <section className="card">
        <h2>Counted submissions by status</h2>
        <table>
          <thead><tr><th>Status</th><th>Teams</th></tr></thead>
          <tbody>
            {["accepted", "checking", "queued", "needs_fix", "failed"].map((k) => (
              <tr key={k}><td>{k.replace("_", " ")}</td><td>{by[k] ?? 0}</td></tr>
            ))}
          </tbody>
        </table>
        {Object.keys(s.lateAttemptsByReason).length > 0 && (
          <p className="muted">Late attempts: {Object.entries(s.lateAttemptsByReason).map(([k, n]) => `${k.replace(/_/g, " ")} ×${n}`).join(", ")}</p>
        )}
      </section>
    </main>
  );
}
