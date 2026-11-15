import { api } from "./api";

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partsDone: number;
  partCount: number;
  phase: "uploading" | "waiting-offline" | "finishing" | "done";
}

const PARALLEL = 3;
const PRESIGN_BATCH = 6;
const MAX_TRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitOnline(): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("online", () => resolve(), { once: true }));
}

/** PUT one part straight to object storage (XHR for upload progress). The API never sees these bytes. */
function putPart(url: string, blob: Blob, onBytes: (n: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(`storage responded ${xhr.status}${etag ? "" : " (no ETag: check bucket CORS)"}`));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * Upload (or resume) a file for a version. Asks the server which parts it already has, sends only
 * the missing ones, retries each part with backoff, waits while offline, then completes.
 * Safe to call again after a crash, refresh or lost connection: it picks up where it stopped.
 */
export async function uploadVersionFile(versionId: string, file: File, onProgress: (p: UploadProgress) => void, signal: AbortSignal) {
  const state = await api.get(`/versions/${versionId}/upload`);
  if (state.fileSize !== file.size) throw new Error("This is not the same file that was started. Select the original file to resume.");
  const { partSize, partCount } = state as { partSize: number; partCount: number };
  let missing: number[] = state.missing;

  const partBytes = (n: number) => (n === partCount ? file.size - partSize * (partCount - 1) : partSize);
  const done = new Set<number>(state.uploaded);
  const inFlight = new Map<number, number>();
  const emit = (phase: UploadProgress["phase"] = "uploading") => {
    let bytes = 0;
    for (const n of done) bytes += partBytes(n);
    for (const b of inFlight.values()) bytes += b;
    onProgress({ uploadedBytes: Math.min(bytes, file.size), totalBytes: file.size, partsDone: done.size, partCount, phase });
  };
  emit();

  async function sendOne(part: { n: number; url: string }) {
    const blob = file.slice((part.n - 1) * partSize, (part.n - 1) * partSize + partBytes(part.n));
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (!navigator.onLine) {
        emit("waiting-offline");
        await waitOnline();
      }
      try {
        inFlight.set(part.n, 0);
        const etag = await putPart(part.url, blob, (b) => (inFlight.set(part.n, b), emit()), signal);
        await api.put(`/versions/${versionId}/upload/parts/${part.n}`, { etag, size: blob.size });
        inFlight.delete(part.n);
        done.add(part.n);
        emit();
        return;
      } catch (e) {
        inFlight.delete(part.n);
        if ((e as Error).name === "AbortError") throw e;
        // Give up only if we are online and have retried enough; while offline we keep waiting.
        if (attempt >= MAX_TRIES && navigator.onLine) throw e;
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 300);
        // The signed URL may have expired during a long outage: ask for a fresh one.
        const fresh = await api.post(`/versions/${versionId}/upload/parts`, { parts: [part.n] });
        part = fresh.parts[0];
      }
    }
  }

  while (missing.length) {
    const batch = missing.slice(0, PRESIGN_BATCH);
    missing = missing.slice(PRESIGN_BATCH);
    const { parts } = await api.post(`/versions/${versionId}/upload/parts`, { parts: batch });
    const queue = [...parts] as { n: number; url: string }[];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
        for (let p = queue.shift(); p; p = queue.shift()) await sendOne(p);
      }),
    );
  }

  emit("finishing");
  const res = await api.post(`/versions/${versionId}/upload/complete`);
  emit("done");
  return res;
}

const KEY = "pending-upload";
export interface PendingUpload {
  versionId: string;
  fileName: string;
  size: number;
  lastModified: number;
}
export const savePending = (p: PendingUpload) => localStorage.setItem(KEY, JSON.stringify(p));
export const clearPending = () => localStorage.removeItem(KEY);
export function loadPending(): PendingUpload | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}
