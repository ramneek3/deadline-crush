import { useState, type FormEvent } from "react";
import { api, setToken, explain } from "./api";

export function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const body =
        mode === "login"
          ? { email: f.get("email"), password: f.get("password") }
          : { email: f.get("email"), password: f.get("password"), name: f.get("name"), teamName: f.get("teamName") };
      const res = await api.post(`/auth/${mode}`, body);
      setToken(res.token);
      onDone();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="card narrow">
      <h1>Deadline Crush</h1>
      <p className="muted">Submit your hackathon project. Every version is kept; the last one before the deadline counts.</p>
      <div role="tablist" className="tabs" aria-label="Account">
        <button role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>Log in</button>
        <button role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>Register a team</button>
      </div>
      <form onSubmit={submit}>
        {mode === "register" && (
          <>
            <label>Your name<input name="name" required maxLength={100} autoComplete="name" /></label>
            <label>Team name<input name="teamName" required minLength={2} maxLength={80} /></label>
          </>
        )}
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Password<input name="password" type="password" required minLength={mode === "register" ? 8 : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Log in" : "Create team"}</button>
      </form>
    </main>
  );
}
