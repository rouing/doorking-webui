// Calls to the server's REST API (see web/server.ts). Errors carry the server's { error } message.

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let signedOut = () => {};
// Called when a request comes back 401 (the session ended), except the sign-in request itself.
export function onSignedOut(fn: () => void) { signedOut = fn; }

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    // The server rejects any POST/PUT without a JSON content-type (415), so set it for every non-GET.
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status === 401 && !(method === 'POST' && url === '/api/session')) signedOut();
  if (!res.ok) throw new ApiError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`, res.status, json);
  return json as T;
}

export type GateApi = <T = unknown>(method: string, sub: string, body?: unknown) => Promise<T>;

// Requests for one gate: /api/gates/<phone><sub>.
export const gateUrl = (phone: string, sub: string) => `/api/gates/${encodeURIComponent(phone)}${sub}`;
export const gateApi = (phone: string): GateApi => (method, sub, body) => api(method, gateUrl(phone, sub), body);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Per-browser settings in localStorage. Never holds a password or master code.
export function lsGet<T>(key: string, def: T): T {
  try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v) as T; } catch { return def; }
}
export function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}
