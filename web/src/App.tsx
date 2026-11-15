import { useCallback, useEffect, useState } from "react";
import { api, setToken, type Me } from "./api";
import { Auth } from "./Auth";
import { TeamPage } from "./TeamPage";
import { OrganizerPage } from "./OrganizerPage";

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/me"));
    } catch {
      setToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (loading) return <p className="center">Loading…</p>;
  if (!me) return <Auth onDone={() => void load()} />;
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <nav className="top" aria-label="Account">
        <span>{me.user.name} · {me.user.role}</span>
        <button onClick={() => (setToken(null), setMe(null))}>Log out</button>
      </nav>
      <div id="main">{me.user.role === "organizer" ? <OrganizerPage /> : <TeamPage me={me} />}</div>
    </>
  );
}
