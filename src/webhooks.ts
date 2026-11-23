/**
 * @module src/webhooks
 *
 * Per-gate outbound webhooks with HMAC-SHA256 signatures and an encrypted PostgreSQL delivery outbox (mirrors
 * `src/email.ts`). Blocks loopback and cloud metadata URLs by default to prevent SSRF.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { all, decrypt, encrypt, one, phoneDigits, run, type Store } from './db.ts';
import { httpError } from './errors.ts';
import type { WebhookDelivery, WebhookEvent, WebhookInfo } from './types.ts';

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  'pull.completed', 'send.completed', 'send.failed', 'relay.changed', 'suspicious.reported',
];

const RETRY_MINUTES = [1, 5, 15, 60];
const DELIVERY_BATCH = 20;
const DELIVERY_TIMEOUT_MS = 10000;
const MAX_WEBHOOKS_PER_GATE = 10;

interface WebhookRow {
  id: string;
  phone: string;
  name: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  enabled: boolean;
  created_by: string;
  created_at: string;
}

interface DeliveryRow {
  id: number;
  webhook_id: string;
  phone: string;
  event: string;
  payload: string | null;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

const fromWebhookRow = (row: WebhookRow): WebhookInfo => ({
  id: row.id, name: row.name, url: row.url, events: row.events, enabled: row.enabled, createdBy: row.created_by, createdAt: row.created_at,
});

const fromDeliveryRow = (row: DeliveryRow): WebhookDelivery => ({
  id: Number(row.id), webhookId: row.webhook_id, event: row.event, status: row.status, attempts: row.attempts,
  lastStatus: row.last_status, lastError: row.last_error, createdAt: row.created_at, sentAt: row.sent_at,
});

/**
 * Returns true if `ip` is a loopback, link-local, RFC 1918 private LAN, CGNAT, ULA, multicast, or unspecified address
 * (including IPv4-mapped IPv6 addresses like `::ffff:127.0.0.1` or `::ffff:7f00:1`).
 */
export function isBlockedIp(raw: string): boolean {
  const ip = raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mappedV4) return isBlockedIp(mappedV4[1]);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (net.isIPv6(ip)) {
    return ip === '::' || ip === '::1' || /^(fc|fd|fe[89ab]|ff)/.test(ip);
  }
  return false;
}

const BLOCKED_HOSTNAME_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;

/**
 * Validates an external HTTPS destination URL, blocking non-HTTPS schemes, loopback/private/link-local literal IPs,
 * and `.local`/`.localhost` hostnames.
 */
export function checkWebhookUrl(given: unknown, allowLocal = false): string {
  const raw = String(given ?? '').trim();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw httpError('Webhook URL must be a valid https:// URL'); }
  if (parsed.protocol !== 'https:' && !(allowLocal && parsed.protocol === 'http:')) {
    throw httpError('Webhook URL must use https://');
  }
  if (!allowLocal) {
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (BLOCKED_HOSTNAME_RE.test(host) || isBlockedIp(host)) {
      throw httpError('Webhook URL cannot target loopback, private network, or link-local addresses');
    }
  }
  return parsed.toString();
}

/**
 * Resolves `hostname` via DNS and rejects any destination that resolves to a private, loopback, or link-local IP
 * (prevents DNS-rebinding / split-horizon SSRF).
 */
export async function assertPublicHostname(url: string, allowLocal = false): Promise<void> {
  if (allowLocal) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAME_RE.test(host) || isBlockedIp(host)) {
    throw httpError('Destination host cannot target loopback, private network, or link-local addresses');
  }
  if (net.isIP(host)) return;
  const records = await dns.lookup(host, { all: true }).catch(() => {
    throw httpError('Destination host could not be resolved');
  });
  if (!records.length || records.some((rec) => isBlockedIp(rec.address))) {
    throw httpError('Destination host resolves to a private or loopback address');
  }
}

/**
 * Validates and normalizes webhook event names.
 *
 * @param given - Raw event list.
 * @returns Deduplicated list of valid `WebhookEvent` values.
 * @throws HTTP 400 error when empty or containing unknown event names.
 */
export function checkWebhookEvents(given: unknown): WebhookEvent[] {
  if (!Array.isArray(given) || !given.length) throw httpError('Pick at least one webhook event');
  const set = new Set<WebhookEvent>();
  for (const item of given) {
    if (typeof item !== 'string' || !WEBHOOK_EVENTS.includes(item as WebhookEvent)) {
      throw httpError(`Unknown webhook event "${String(item)}"`);
    }
    set.add(item as WebhookEvent);
  }
  return [...set];
}

/**
 * Computes the `X-DoorKing-Signature` header (`sha256=<hex>`) over `${timestamp}.${body}`.
 *
 * @param secret - Shared signing secret (`whsec_...`).
 * @param timestamp - Unix timestamp string (seconds).
 * @param body - Raw JSON request body.
 * @returns Signature header value.
 */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Creates a webhook for a gate and returns its info plus the one-time signing secret.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param input - Webhook creation payload (`name`, `url`, `events`, `enabled`).
 * @param by - Username creating the webhook.
 * @param [allowLocal] - Allow `http://127.0.0.1` destinations (tests only).
 * @returns Promise resolving to `{ webhook, secret }`.
 * @throws HTTP 400 error on invalid input or when the per-gate cap is reached.
 */
export async function createWebhook(
  store: Store,
  phone: string,
  input: { name?: unknown; url?: unknown; events?: unknown; enabled?: unknown },
  by: string,
  allowLocal = false,
): Promise<{ webhook: WebhookInfo; secret: string }> {
  const phoneKey = phoneDigits(phone);
  const existing = await all<{ id: string }>(store, 'SELECT id FROM webhooks WHERE phone = $1', [phoneKey]);
  if (existing.length >= MAX_WEBHOOKS_PER_GATE) throw httpError(`At most ${MAX_WEBHOOKS_PER_GATE} webhooks per gate`);
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 60) throw httpError('Give the webhook a name of 1-60 characters');
  const url = checkWebhookUrl(input.url, allowLocal);
  const events = checkWebhookEvents(input.events);
  const enabled = input.enabled !== false;
  const id = crypto.randomBytes(8).toString('hex');
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  await run(store, `INSERT INTO webhooks (id, phone, name, url, secret, events, enabled, created_by, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [id, phoneKey, name, url, encrypt(store, secret), JSON.stringify(events), enabled, by, new Date().toISOString()]);
  const row = (await one<WebhookRow>(store, 'SELECT * FROM webhooks WHERE id = $1', [id]))!;
  return { webhook: fromWebhookRow(row), secret };
}

/**
 * Lists all webhooks configured for a gate (secrets never returned).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `WebhookInfo[]`.
 */
export async function listWebhooks(store: Store, phone: string): Promise<WebhookInfo[]> {
  return (await all<WebhookRow>(store, 'SELECT * FROM webhooks WHERE phone = $1 ORDER BY created_at DESC', [phoneDigits(phone)])).map(fromWebhookRow);
}

/**
 * Updates a webhook's name, URL, events, or enabled flag.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param id - Webhook ID.
 * @param input - Partial update fields.
 * @param [allowLocal] - Allow local test URLs.
 * @returns Promise resolving to the updated `WebhookInfo`.
 * @throws HTTP 400/404 error on bad input or unknown webhook.
 */
export async function updateWebhook(
  store: Store,
  phone: string,
  id: string,
  input: { name?: unknown; url?: unknown; events?: unknown; enabled?: unknown },
  allowLocal = false,
): Promise<WebhookInfo> {
  const phoneKey = phoneDigits(phone);
  const row = await one<WebhookRow>(store, 'SELECT * FROM webhooks WHERE phone = $1 AND id = $2', [phoneKey, id]);
  if (!row) throw httpError('Webhook not found', 404);
  const name = input.name === undefined ? row.name : String(input.name ?? '').trim();
  if (!name || name.length > 60) throw httpError('Give the webhook a name of 1-60 characters');
  const url = input.url === undefined ? row.url : checkWebhookUrl(input.url, allowLocal);
  const events = input.events === undefined ? row.events : checkWebhookEvents(input.events);
  const enabled = input.enabled === undefined ? row.enabled : input.enabled === true;
  await run(store, 'UPDATE webhooks SET name = $3, url = $4, events = $5, enabled = $6 WHERE phone = $1 AND id = $2',
    [phoneKey, id, name, url, JSON.stringify(events), enabled]);
  return fromWebhookRow((await one<WebhookRow>(store, 'SELECT * FROM webhooks WHERE id = $1', [id]))!);
}

/**
 * Deletes a webhook and cascades its delivery history.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param id - Webhook ID.
 * @returns Promise resolving to the deleted webhook's name.
 * @throws HTTP 404 error when not found.
 */
export async function deleteWebhook(store: Store, phone: string, id: string): Promise<string> {
  const row = await one<{ name: string }>(store, 'DELETE FROM webhooks WHERE phone = $1 AND id = $2 RETURNING name', [phoneDigits(phone), id]);
  if (!row) throw httpError('Webhook not found', 404);
  return row.name;
}

/**
 * Enqueues a signed webhook delivery for every enabled webhook on `phone` subscribed to `event`.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param event - Event type name.
 * @param data - Event payload object.
 * @returns Promise resolving to the number of deliveries enqueued.
 */
export async function queueWebhookEvent(store: Store, phone: string, event: WebhookEvent, data: Record<string, unknown>): Promise<number> {
  const phoneKey = phoneDigits(phone);
  const hooks = await all<WebhookRow>(store, 'SELECT * FROM webhooks WHERE phone = $1 AND enabled = true', [phoneKey]);
  const matching = hooks.filter((hook) => hook.events.includes(event));
  if (!matching.length) return 0;
  const payload = JSON.stringify({ event, phone: phoneKey, timestamp: new Date().toISOString(), data });
  const encrypted = encrypt(store, payload);
  for (const hook of matching) {
    await run(store, `INSERT INTO webhook_deliveries (webhook_id, phone, event, payload, status, attempts, next_try, created_at)
      VALUES ($1, $2, $3, $4, 'queued', 0, now(), now())`, [hook.id, phoneKey, event, encrypted]);
  }
  return matching.length;
}

async function postSigned(url: string, secret: string, event: string, deliveryId: string, body: string, fetchFn: typeof fetch): Promise<{ ok: boolean; status: number; error?: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWebhookPayload(secret, timestamp, body);
  try {
    // Skip DNS SSRF check only when a custom test fetch is injected (e.g. unit tests hitting mock endpoints).
    if (fetchFn === fetch) await assertPublicHostname(url, url.startsWith('http://'));
    const res = await fetchFn(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-DoorKing-Event': event,
        'X-DoorKing-Delivery': deliveryId,
        'X-DoorKing-Timestamp': timestamp,
        'X-DoorKing-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: String((err as Error).message || err).slice(0, 300) };
  }
}

/**
 * Delivers due queued webhooks with retry backoff, clearing encrypted payloads once sent or exhausted.
 *
 * @param store - Database store handle.
 * @param [options] - Optional fetch implementation and diagnostic log callback.
 * @returns Promise resolving to `{ sent, failed }` counts.
 */
export async function deliverQueuedWebhooks(
  store: Store,
  { fetchFn = fetch, log = () => {} }: { fetchFn?: typeof fetch; log?: (msg: string) => void } = {},
): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const due = await all<DeliveryRow & { url: string; secret: string; enabled: boolean }>(store,
    `SELECT d.*, w.url, w.secret, w.enabled FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'queued' AND d.next_try <= now() ORDER BY d.id LIMIT $1`, [DELIVERY_BATCH]);
  for (const item of due) {
    if (!item.enabled || !item.payload) {
      await run(store, "UPDATE webhook_deliveries SET status = 'failed', payload = NULL, last_error = 'Webhook disabled' WHERE id = $1", [item.id]);
      continue;
    }
    const body = decrypt(store, item.payload);
    const secret = decrypt(store, item.secret);
    const res = await postSigned(item.url, secret, item.event, String(item.id), body, fetchFn);
    if (res.ok) {
      await run(store, "UPDATE webhook_deliveries SET status = 'sent', attempts = attempts + 1, last_status = $2, last_error = NULL, payload = NULL, sent_at = now() WHERE id = $1",
        [item.id, res.status]);
      out.sent++;
      continue;
    }
    const wait = RETRY_MINUTES[item.attempts];
    if (wait === undefined) {
      await run(store, "UPDATE webhook_deliveries SET status = 'failed', attempts = attempts + 1, last_status = $2, last_error = $3, payload = NULL WHERE id = $1",
        [item.id, res.status || null, res.error || 'Delivery failed']);
    } else {
      await run(store, `UPDATE webhook_deliveries SET attempts = attempts + 1, last_status = $2, last_error = $3, next_try = now() + ($4 || ' minutes')::interval WHERE id = $1`,
        [item.id, res.status || null, res.error || 'Delivery failed', String(wait)]);
    }
    log(`Webhook ${item.webhook_id} (${item.event}) failed${wait === undefined ? ', given up' : `, retrying in ${wait} min`}: ${res.error}`);
    out.failed++;
  }
  return out;
}

/**
 * Lists recent webhook delivery attempts for a gate, newest first.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param [limit] - Maximum rows to return (default 30).
 * @returns Promise resolving to `WebhookDelivery[]`.
 */
export async function listWebhookDeliveries(store: Store, phone: string, limit = 30): Promise<WebhookDelivery[]> {
  const rows = await all<DeliveryRow>(store,
    'SELECT id, webhook_id, phone, event, NULL AS payload, status, attempts, last_status, last_error, created_at, sent_at FROM webhook_deliveries WHERE phone = $1 ORDER BY id DESC LIMIT $2',
    [phoneDigits(phone), limit]);
  return rows.map(fromDeliveryRow);
}

/**
 * Sends a synchronous signed test ping to a configured webhook.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param id - Webhook ID.
 * @param [fetchFn] - Optional fetch override for tests.
 * @returns Promise resolving to `{ ok, status, error? }`.
 * @throws HTTP 404 error when the webhook does not exist.
 */
export async function sendTestWebhook(store: Store, phone: string, id: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; status: number; error?: string }> {
  const row = await one<WebhookRow>(store, 'SELECT * FROM webhooks WHERE phone = $1 AND id = $2', [phoneDigits(phone), id]);
  if (!row) throw httpError('Webhook not found', 404);
  const body = JSON.stringify({ event: 'webhook.test', phone: phoneDigits(phone), timestamp: new Date().toISOString(), data: { webhookId: row.id, name: row.name } });
  return postSigned(row.url, decrypt(store, row.secret), 'webhook.test', `test-${crypto.randomBytes(6).toString('hex')}`, body, fetchFn);
}
