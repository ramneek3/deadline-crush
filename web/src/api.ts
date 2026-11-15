export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000";

export interface VersionView {
  id: string;
  versionNo: number;
  title: string;
  description: string;
  links: string[];
  status: "uploading" | "queued" | "checking" | "accepted" | "needs_fix" | "failed";
  file: { name: string; size: number; sha256?: string } | null;
  problems: string[];
  hasPreview: boolean;
  createdAt: string;
  completedAt: string | null;
  expired?: boolean;
}
export interface Me {
  user: { id: string; name: string; email: string; role: "team" | "organizer" };
  team: { id: string; name: string; members: number } | null;
  deadline: { deadlineAt: string; graceSeconds: number; serverTime: string };
}
export interface Stats {
  serverTime: string;
  deadlineAt: string;
  graceSeconds: number;
  teams: number;
  teamsWithSubmission: number;
  totalVersions: number;
  versionsByStatus: Record<string, number>;
  countedByStatus: Record<string, number>;
  lateAttempts: number;
  lateAttemptsByReason: Record<string, number>;
  failedChecks: number;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any) {
    super(code);
  }
}

let token: string | null = localStorage.getItem("token");
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem("token", t);
  else localStorage.removeItem("token");
}

export async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_URL + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data);
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>("GET", p),
  post: <T = any>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
};

const MESSAGES: Record<string, string> = {
  deadline_passed: "The deadline has passed. New submissions and edits are closed.",
  grace_period_over: "The grace period for finishing uploads is over.",
  upload_started_after_deadline: "This upload started after the deadline, so it cannot be completed.",
  email_taken: "That email is already registered.",
  team_name_taken: "That team name is already taken.",
  invalid_credentials: "Wrong email or password.",
  validation_failed: "Please check the form fields.",
  storage_error: "Storage had a problem. Please retry in a moment.",
};
export const explain = (e: unknown) => (e instanceof ApiError ? MESSAGES[e.code] ?? `Request failed (${e.code})` : e instanceof Error ? e.message : "Something went wrong");
