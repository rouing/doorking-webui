// API keys (table api_keys, see db.ts): each belongs to one gate, not to a person; the admin who created it is only
// recorded. A key is "dkg_<id>_<secret>" (id: 12 hex digits, secret: 32 random bytes, base64url), shown once when it
// is created; only its SHA-256 is stored. Role 'admin' or 'readonly' like people's; optional expiry. Scripts send it
// as "Authorization: Bearer <key>" (web/server.ts decides which routes a key may use).
import crypto from 'node:crypto';
import { all, one, run, type Store } from './db.ts';
import { checkRole, type GateRole } from './gate-list.ts';
import { userKey } from './users.ts';
import type { ApiKeyInfo } from './types.ts';

export type { ApiKeyInfo };
export const API_KEY_EXPIRY_DAYS = [0, 30, 90, 365]; // 0 = never
const NAME_MAX = 40;
const DAY_MS = 86400000;

interface ApiKeyRow {
  id: string; phone: string; name: string; role: GateRole; secret_hash: string; created_by: string; created_at: string;
  expires_at: string | null; last_used_at: string | null;
}

const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');
const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
const fromRow = (r: ApiKeyRow): ApiKeyInfo => ({
  id: r.id, name: r.name, role: r.role, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at,
});

// Creates a key for the gate. Returns the key (to show once) and its details.
export async function createApiKey(store: Store, phone: unknown, { name, role, expiresDays = 0 }: { name: unknown; role: unknown; expiresDays?: unknown },
  by: string): Promise<{ key: string; apiKey: ApiKeyInfo }> {
  const label = String(name ?? '').trim();
  if (!label || label.length > NAME_MAX) throw bad(`Give the key a name of 1-${NAME_MAX} characters`);
  const r = checkRole(role);
  const days = Number(expiresDays || 0);
  if (!API_KEY_EXPIRY_DAYS.includes(days)) throw bad('Expiry must be never, 30, 90 or 365 days');
  const id = crypto.randomBytes(6).toString('hex');
  const key = `dkg_${id}_${crypto.randomBytes(32).toString('base64url')}`;
  const now = new Date();
  await run(store, `INSERT INTO api_keys (id, phone, name, role, secret_hash, created_by, created_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, phoneDigits(phone), label, r, sha256(key).toString('hex'), userKey(by),
    now.toISOString(), days ? new Date(now.getTime() + days * DAY_MS).toISOString() : null]);
  const row = (await one<ApiKeyRow>(store, 'SELECT * FROM api_keys WHERE id = $1', [id]))!;
  return { key, apiKey: fromRow(row) };
}

// The gate's keys, newest first (never the key or its hash).
export async function listApiKeys(store: Store, phone: unknown): Promise<ApiKeyInfo[]> {
  return (await all<ApiKeyRow>(store, 'SELECT * FROM api_keys WHERE phone = $1 ORDER BY created_at DESC', [phoneDigits(phone)])).map(fromRow);
}

// Revokes (deletes) one of the gate's keys; returns its name.
export async function revokeApiKey(store: Store, phone: unknown, id: unknown): Promise<string> {
  const r = await one<{ name: string }>(store, 'DELETE FROM api_keys WHERE phone = $1 AND id = $2 RETURNING name', [phoneDigits(phone), String(id)]);
  if (!r) throw bad('API key not found', 404);
  return r.name;
}

// The key's gate, id, name and role when the key is valid and not expired, else null. last_used_at is written at
// most once a minute.
export async function findApiKey(store: Store, key: unknown): Promise<{ id: string; phone: string; name: string; role: GateRole } | null> {
  const m = /^dkg_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/.exec(String(key ?? ''));
  if (!m) return null;
  const r = await one<ApiKeyRow>(store, 'SELECT * FROM api_keys WHERE id = $1', [m[1]]);
  if (!r || !crypto.timingSafeEqual(sha256(String(key)), Buffer.from(r.secret_hash, 'hex'))) return null;
  const now = Date.now();
  if (r.expires_at && new Date(r.expires_at).getTime() <= now) return null;
  if (!r.last_used_at || now - new Date(r.last_used_at).getTime() > 60000) {
    await run(store, 'UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [r.id, new Date(now).toISOString()]);
  }
  return { id: r.id, phone: r.phone, name: r.name, role: r.role };
}
