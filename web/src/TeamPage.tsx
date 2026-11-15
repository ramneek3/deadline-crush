import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, explain, type Me, type VersionView } from "./api";
import { Countdown } from "./Countdown";
import { useEvents } from "./useEvents";
import { uploadVersionFile, savePending, clearPending, loadPending, type UploadProgress } from "./uploader";

const STATUS_LABEL: Record<string, string> = {
  uploading: "Uploading",
  queued: "Waiting for checks",
  checking: "Checking",
  accepted: "Accepted",
  needs_fix: "Needs fixing",
  failed: "Checks failed to run",
};
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

export function TeamPage({ me }: { me: Me }) {
  const [versions, setVersions] = useState<VersionView[]>([]);
  const [counted, setCounted] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(loadPending());
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const r = await api.get("/versions");
    setVersions(r.versions);
    setCounted(r.counted);
  }, []);
  useEffect(() => void refresh().catch((e) => setError(explain(e))), [refresh]);

  // Live status: no refreshing. The event updates the badge instantly; a refetch (coalesced) then
  // picks up the "counts" badge and previews. Reconnects refetch too, so nothing is missed offline.
  const refreshSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvents(
    "/events",
    (e) => {
      setVersions((vs) => vs.map((v) => (v.id === e.versionId ? { ...v, status: e.status, problems: e.problems ?? v.problems } : v)));
      if (refreshSoon.current) clearTimeout(refreshSoon.current);
      refreshSoon.current = setTimeout(() => void refresh().catch(() => undefined), 400);
    },
    () => void refresh().catch(() => undefined),
  );

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = (f.get("file") as File) || null;
    setError("");
    setBusy(true);
    try {
      const links = String(f.get("links") ?? "").split(/\s+/).filter(Boolean);
      const created = await api.post("/versions", {
        title: f.get("title"),
        description: f.get("description"),
        links,
        ...(file && file.size > 0 ? { file: { name: file.name, size: file.size, contentType: file.type || "application/octet-stream" } } : {}),
      });
      await refresh();
      if (file && file.size > 0) {
        savePending({ versionId: created.version.id, fileName: file.name, size: file.size, lastModified: file.lastModified });
        setPending(loadPending());
        await run(created.version.id, file);
      }
      form.reset();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function run(versionId: string, file: File) {
    abort.current = new AbortController();
    try {
      await uploadVersionFile(versionId, file, setProgress, abort.current.signal);
      clearPending();
      setPending(null);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(explain(err));
    } finally {
      setProgress(null);
      await refresh().catch(() => undefined);
    }
  }

  async function resume(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = new FormData(e.currentTarget).get("file") as File;
    if (!file || !pending) return;
    setBusy(true);
    setError("");
    try {
      await run(pending.versionId, file);
    } finally {
      setBusy(false);
    }
  }

  const pct = progress ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100) : 0;
  const openVersion = (id: string) => api.get(`/versions/${id}/download`).then((r) => window.open(r.previewUrl ?? r.url, "_blank", "noopener"));

  return (
    <main>
      <header className="bar">
        <div>
          <h1>{me.team?.name}</h1>
          <Countdown {...me.deadline} />
        </div>
      </header>

      {error && <p role="alert" className="error">{error}</p>}

      {pending && !progress && (
        <section className="card notice" aria-labelledby="resume-h">
          <h2 id="resume-h">Unfinished upload</h2>
          <p>
            An upload of <strong>{pending.fileName}</strong> ({mb(pending.size)}) did not finish. Select the same file and it continues from where it stopped; parts already stored are not sent again.
          </p>
          <form onSubmit={resume} className="row">
            <label className="grow">Same file<input type="file" name="file" required /></label>
            <button className="primary" disabled={busy}>Resume upload</button>
            <button type="button" onClick={() => (clearPending(), setPending(null))}>Dismiss</button>
          </form>
        </section>
      )}

      <section className="card" aria-labelledby="new-h">
        <h2 id="new-h">New version</h2>
        <p className="muted">Each save creates a new version. Leave the file empty to keep the previous file and only change the details.</p>
        <form onSubmit={start}>
          <label>Project title<input name="title" required maxLength={120} /></label>
          <label>Description<textarea name="description" rows={3} maxLength={2000} /></label>
          <label>Links <small>(demo, repo, one per line)</small><textarea name="links" rows={2} placeholder="https://github.com/…" /></label>
          <label>File <small>(PDF or ZIP, up to 100 MB)</small><input type="file" name="file" accept=".pdf,.zip" /></label>
          <button className="primary" disabled={busy}>{busy ? "Working…" : "Submit new version"}</button>
        </form>
        {progress && (
          <div className="progress" role="status" aria-live="polite">
            <progress max={100} value={pct} aria-label="Upload progress" />
            <span>
              {progress.phase === "waiting-offline" ? "You are offline. The upload will continue when you reconnect." : progress.phase === "finishing" ? "Finishing…" : `${pct}% · part ${progress.partsDone}/${progress.partCount}`}
            </span>
            <button type="button" onClick={() => abort.current?.abort()}>Pause</button>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="versions-h">
        <h2 id="versions-h">Your versions</h2>
        {versions.length === 0 ? (
          <p className="muted">Nothing submitted yet.</p>
        ) : (
          <ul className="versions">
            {versions.map((v) => (
              <li key={v.id}>
                <div className="vhead">
                  <strong>v{v.versionNo} · {v.title}</strong>
                  {v.id === counted && <span className="badge counts">Counts for judging</span>}
                  <span className={`badge status-${v.expired ? "failed" : v.status}`} aria-live="polite">{v.expired ? "Expired (not finished in time)" : STATUS_LABEL[v.status]}</span>
                </div>
                <p className="muted">
                  {v.file ? `${v.file.name} · ${mb(v.file.size)}` : "No file"} · {new Date(v.createdAt).toLocaleString()}
                </p>
                {v.problems.length > 0 && (
                  <ul className="problems">{v.problems.map((p) => <li key={p}>{p.replace(/_/g, " ")}</li>)}</ul>
                )}
                {v.file && (v.status === "accepted" || v.status === "needs_fix") && <button onClick={() => void openVersion(v.id)}>{v.hasPreview ? "View preview" : "Download"}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
