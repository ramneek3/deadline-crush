import { useEffect, useState } from "react";

/** Counts down to the server's deadline. The offset corrects for the browser clock being wrong. */
export function useServerNow(serverTime: string) {
  const [offset] = useState(() => new Date(serverTime).getTime() - Date.now());
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 500);
    return () => clearInterval(t);
  }, [offset]);
  return now;
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? d + "d " : ""}${h || d ? h + "h " : ""}${m}m ${s % 60}s`;
};

export function Countdown({ deadlineAt, graceSeconds, serverTime }: { deadlineAt: string; graceSeconds: number; serverTime: string }) {
  const now = useServerNow(serverTime);
  const left = new Date(deadlineAt).getTime() - now;
  const graceLeft = left + graceSeconds * 1000;
  let text: string, tone: "ok" | "warn" | "closed";
  if (left > 0) {
    text = `${fmt(left)} until the deadline`;
    tone = left < 10 * 60_000 ? "warn" : "ok";
  } else if (graceLeft > 0) {
    text = `Deadline passed. Uploads already started may finish for ${fmt(graceLeft)}.`;
    tone = "closed";
  } else {
    text = "Submissions are closed.";
    tone = "closed";
  }
  return (
    <p className={`countdown ${tone}`} role="timer" aria-live="off">
      {text}
      <small> · deadline {new Date(deadlineAt).toLocaleString()} (server time)</small>
    </p>
  );
}
