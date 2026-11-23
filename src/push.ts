/**
 * @module src/push
 *
 * Web Push notifications (RFC 8291/8292 via `web-push`) for installed PWAs and browsers. Stores per-device push
 * subscriptions in `push_subscriptions` and either uses configured VAPID keys from `config.json` or auto-generates
 * and persists a VAPID keypair (private key encrypted) in `meta`.
 */
import crypto from 'node:crypto';
import * as webpush from 'web-push';
import { all, decrypt, encrypt, getMeta, one, run, setMeta, type Store } from './db.ts';
import { httpError } from './errors.ts';
import { userKey } from './users.ts';
import { assertPublicHostname, isBlockedIp } from './webhooks.ts';
import type { PushSubscriptionInfo } from './types.ts';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

interface PushSubRow {
  id: string;
  username: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

const fromRow = (row: PushSubRow): PushSubscriptionInfo => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/**
 * Generates a fresh VAPID P-256 keypair (base64url) for Web Push.
 *
 * @returns `{ publicKey, privateKey }` strings.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

/**
 * Returns active VAPID keys: explicit keys from `config.json` when configured, else auto-generated once and stored
 * in the `meta` table (private key encrypted with `doorking.key`).
 *
 * @param store - Database store handle.
 * @param cfg - Push config section (`vapidPublicKey`, `vapidPrivateKey`, `subject`) plus fallback `appUrl`.
 * @returns Promise resolving to `VapidConfig`.
 */
export async function ensureVapidKeys(
  store: Store,
  cfg: { vapidPublicKey?: string; vapidPrivateKey?: string; subject?: string; appUrl?: string },
): Promise<VapidConfig> {
  const subject = (cfg.subject || '').trim() || (cfg.appUrl && /^https:\/\//.test(cfg.appUrl) ? cfg.appUrl : 'mailto:admin@localhost');
  if (cfg.vapidPublicKey && cfg.vapidPrivateKey) {
    return { publicKey: cfg.vapidPublicKey, privateKey: cfg.vapidPrivateKey, subject };
  }
  const storedPub = await getMeta(store, 'vapidPublicKey');
  const storedPriv = await getMeta(store, 'vapidPrivateKey');
  if (storedPub && storedPriv) {
    return { publicKey: storedPub, privateKey: decrypt(store, storedPriv), subject };
  }
  const generated = webpush.generateVAPIDKeys();
  await setMeta(store, 'vapidPublicKey', generated.publicKey);
  await setMeta(store, 'vapidPrivateKey', encrypt(store, generated.privateKey));
  return { publicKey: generated.publicKey, privateKey: generated.privateKey, subject };
}

/**
 * Validates and saves (or updates) a browser's PushSubscription for `username`.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param body - Subscription payload (`{ endpoint, keys: { p256dh, auth }, label? }`).
 * @returns Promise resolving to the saved `PushSubscriptionInfo`.
 * @throws HTTP 400 error on invalid subscription fields.
 */
export async function savePushSubscription(
  store: Store,
  username: string,
  body: { endpoint?: unknown; keys?: unknown; label?: unknown },
): Promise<PushSubscriptionInfo> {
  const endpoint = String(body.endpoint ?? '').trim();
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw httpError('Push subscription endpoint must be a valid https:// URL'); }
  if (parsed.protocol !== 'https:') throw httpError('Push subscription endpoint must use https://');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) || isBlockedIp(host)) {
    throw httpError('Push subscription endpoint cannot target loopback, private network, or link-local addresses');
  }
  const keys = (body.keys && typeof body.keys === 'object' ? body.keys : {}) as { p256dh?: unknown; auth?: unknown };
  const p256dh = String(keys.p256dh ?? '').trim();
  const auth = String(keys.auth ?? '').trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,100}$/.test(auth)) {
    throw httpError('Push subscription keys (p256dh, auth) are missing or invalid');
  }
  const label = String(body.label ?? '').trim().slice(0, 60) || 'Browser';
  const name = userKey(username);
  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  await run(store, `INSERT INTO push_subscriptions (id, username, endpoint, p256dh, auth, label, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (endpoint) DO UPDATE SET username = excluded.username, p256dh = excluded.p256dh,
    auth = excluded.auth, label = excluded.label`,
  [id, name, endpoint, p256dh, auth, label, now]);
  const row = (await one<PushSubRow>(store, 'SELECT * FROM push_subscriptions WHERE endpoint = $1', [endpoint]))!;
  return fromRow(row);
}

/**
 * Lists the signed-in user's registered push devices.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `PushSubscriptionInfo[]`.
 */
export async function listPushSubscriptions(store: Store, username: string): Promise<PushSubscriptionInfo[]> {
  return (await all<PushSubRow>(store, 'SELECT * FROM push_subscriptions WHERE username = $1 ORDER BY created_at DESC', [userKey(username)])).map(fromRow);
}

/**
 * Removes one push subscription belonging to `username` (by subscription `id` or `endpoint`).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param idOrEndpoint - Subscription ID or endpoint URL.
 * @returns Promise resolving to `true` when a subscription was removed.
 */
export async function deletePushSubscription(store: Store, username: string, idOrEndpoint: string): Promise<boolean> {
  return (await run(store, 'DELETE FROM push_subscriptions WHERE username = $1 AND (id = $2 OR endpoint = $2)',
    [userKey(username), String(idOrEndpoint)])) > 0;
}

/**
 * Sends a Web Push notification to all subscribed devices of `usernames`, pruning stale `404`/`410` subscriptions.
 *
 * @param store - Database store handle.
 * @param vapid - Active VAPID key configuration.
 * @param usernames - Target usernames.
 * @param payload - Notification title, body, optional URL and tag.
 * @param [options] - Optional sender override (for tests) and diagnostic logger.
 * @returns Promise resolving to `{ sent, failed, removed }` counts.
 */
export async function sendPushToUsers(
  store: Store,
  vapid: VapidConfig,
  usernames: string[],
  payload: PushPayload,
  { sendFn, log = () => {} }: {
    sendFn?: (sub: webpush.PushSubscription, data: string, opts: webpush.RequestOptions) => Promise<unknown>;
    log?: (msg: string) => void;
  } = {},
): Promise<{ sent: number; failed: number; removed: number }> {
  const unique = [...new Set(usernames.map(userKey).filter(Boolean))];
  if (!unique.length) return { sent: 0, failed: 0, removed: 0 };
  const subs = await all<PushSubRow>(store, 'SELECT * FROM push_subscriptions WHERE username = ANY($1::text[])', [unique]);
  const out = { sent: 0, failed: 0, removed: 0 };
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/', tag: payload.tag || 'doorking-alert' });
  const options: webpush.RequestOptions = {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: 3600,
  };
  const deliver = sendFn || (async (sub, data, opts) => {
    await assertPublicHostname(sub.endpoint);
    return webpush.sendNotification(sub, data, opts);
  });
  for (const sub of subs) {
    try {
      await deliver({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, options);
      await run(store, 'UPDATE push_subscriptions SET last_used_at = $2 WHERE id = $1', [sub.id, new Date().toISOString()]);
      out.sent++;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await run(store, 'DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
        out.removed++;
      } else {
        out.failed++;
        log(`Push to ${sub.username} (${sub.label}) failed: ${(err as Error).message}`);
      }
    }
  }
  return out;
}
