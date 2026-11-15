import { useEffect, useRef } from "react";
import { API_URL, getToken } from "./api";

/**
 * Subscribe to a server-sent-events feed. EventSource reconnects by itself; on every (re)connect
 * `onOpen` fires so callers can refetch and never miss a change that happened while disconnected.
 */
export function useEvents(path: string, onStatus: (data: any) => void, onOpen: () => void, enabled = true) {
  const handler = useRef(onStatus);
  const opened = useRef(onOpen);
  handler.current = onStatus;
  opened.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`${API_URL}${path}?token=${encodeURIComponent(getToken() ?? "")}`);
    es.addEventListener("ready", () => opened.current());
    es.addEventListener("status", (e) => handler.current(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  }, [path, enabled]);
}
