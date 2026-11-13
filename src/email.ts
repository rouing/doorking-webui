// Email: an outbox (table emails) that a background sender delivers over SMTP (nodemailer), retrying failures, and
// single-use link tokens (table email_tokens) for verifying an address, resetting a password and accepting an
// invitation. Bodies hold links, so they are encrypted with the key and removed once an email is sent or given up;
// tokens are stored only as SHA-256 hashes and expire. Links use the URL fragment (#reset=…), which browsers never
// send to the server, so tokens don't end up in proxy logs.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { all, decrypt, encrypt, one, run, transaction, type Store } from './db.ts';
import { userKey } from './users.ts';
import type { ServerConfig } from './config.ts';

export type TokenKind = 'verify' | 'reset' | 'invite';
export const TOKEN_HOURS: Record<TokenKind, number> = { verify: 24, reset: 1, invite: 72 };
const RETRY_MINUTES = [1, 5, 15, 60, 240]; // after each failed try; then given up
const BATCH = 20;

export interface OutboxEmail { id: number; to: string; subject: string; kind: string; status: string; attempts: number; error: string | null; createdAt: string; sentAt: string | null }
export interface Mailer { sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<unknown> }

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// A new link token for the user (earlier unused ones of the same kind stop working). data: e.g. the address being
// verified. Returns the token (for the link only).
export async function createToken(store: Store, kind: TokenKind, username: string, data = ''): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await transaction(store, async (tx) => {
    await run(tx, 'DELETE FROM email_tokens WHERE username = $1 AND kind = $2', [userKey(username), kind]);
    await run(tx, 'INSERT INTO email_tokens (token_hash, kind, username, data, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [sha(token), kind, userKey(username), data, new Date(now).toISOString(), new Date(now + TOKEN_HOURS[kind] * 3600000).toISOString()]);
  });
  return token;
}

// The token's user and data if it is valid, unexpired and of this kind; it is used up either way when found.
// peek: look without using it up (to show whose invitation it is).
export async function useToken(store: Store, kind: TokenKind, token: unknown, { peek = false } = {}): Promise<{ username: string; data: string } | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const sql = peek ? 'SELECT username, data, kind, expires_at FROM email_tokens WHERE token_hash = $1'
    : 'DELETE FROM email_tokens WHERE token_hash = $1 RETURNING username, data, kind, expires_at';
  const r = await one<{ username: string; data: string; kind: string; expires_at: string }>(store, sql, [sha(token)]);
  if (!r || r.kind !== kind || new Date(r.expires_at).getTime() < Date.now()) return null;
  return { username: r.username, data: r.data };
}

// Whether the user has an unused, unexpired token of this kind (e.g. an invitation not yet accepted).
export async function hasToken(store: Store, kind: TokenKind, username: string): Promise<boolean> {
  return Boolean(await one(store, 'SELECT 1 AS x FROM email_tokens WHERE username = $1 AND kind = $2 AND expires_at > now()', [userKey(username), kind]));
}

export async function deleteExpiredTokens(store: Store): Promise<number> {
  return run(store, 'DELETE FROM email_tokens WHERE expires_at < now()');
}

// Queues an email (kind: what it is, for the log). The body is stored encrypted until it is sent.
export async function queueEmail(store: Store, { to, subject, text, kind }: { to: string; subject: string; text: string; kind: string }): Promise<number> {
  const r = await one<{ id: number }>(store, `INSERT INTO emails (to_addr, subject, kind, body, status, attempts, next_try, created_at)
    VALUES ($1, $2, $3, $4, 'queued', 0, now(), now()) RETURNING id`, [to, subject, kind, encrypt(store, text)]);
  return r!.id;
}

// Sends the queued emails that are due. A failure is tried again after RETRY_MINUTES; after the last it is given up.
// Returns the counts. log(message) gets each failure.
export async function sendQueued(store: Store, mailer: Mailer, from: string, log: (m: string) => void = () => {}): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const due = await all<{ id: number; to_addr: string; subject: string; body: string; attempts: number; kind: string }>(store,
    `SELECT id, to_addr, subject, body, attempts, kind FROM emails WHERE status = 'queued' AND next_try <= now() ORDER BY id LIMIT ${BATCH}`);
  for (const e of due) {
    try {
      await mailer.sendMail({ from, to: e.to_addr, subject: e.subject, text: decrypt(store, e.body) });
      await run(store, "UPDATE emails SET status = 'sent', attempts = attempts + 1, sent_at = now(), body = NULL, error = NULL WHERE id = $1", [e.id]);
      out.sent++;
    } catch (err) {
      const msg = String((err as Error).message || err).slice(0, 300);
      const wait = RETRY_MINUTES[e.attempts];
      if (wait === undefined) {
        await run(store, "UPDATE emails SET status = 'failed', attempts = attempts + 1, error = $2, body = NULL WHERE id = $1", [e.id, msg]);
      } else {
        await run(store, `UPDATE emails SET attempts = attempts + 1, error = $2, next_try = now() + ($3 || ' minutes')::interval WHERE id = $1`,
          [e.id, msg, String(wait)]);
      }
      log(`Email ${e.id} (${e.kind}) to ${e.to_addr} not sent${wait === undefined ? ', given up' : `, trying again in ${wait} min`}: ${msg}`);
      out.failed++;
    }
  }
  return out;
}

// The most recent emails (without bodies), newest first.
export async function listEmails(store: Store, limit = 100): Promise<OutboxEmail[]> {
  return (await all<{ id: number; to_addr: string; subject: string; kind: string; status: string; attempts: number; error: string | null; created_at: string; sent_at: string | null }>(store,
    `SELECT id, to_addr, subject, kind, status, attempts, error, created_at, sent_at FROM emails ORDER BY id DESC LIMIT ${Number(limit)}`))
    .map((r) => ({ id: r.id, to: r.to_addr, subject: r.subject, kind: r.kind, status: r.status, attempts: r.attempts, error: r.error, createdAt: r.created_at, sentAt: r.sent_at }));
}

// The SMTP sender for config.email, or null when email is off (no host).
export function createMailer(cfg: ServerConfig['email']): Mailer | null {
  if (!cfg.host) return null;
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.security === 'tls', requireTLS: cfg.security === 'starttls', ignoreTLS: cfg.security === 'none',
    ...(cfg.user && { auth: { user: cfg.user, pass: cfg.password } }),
  });
}

// The texts. app: the address links point to. All plain text.
const SIGN = '\n\n— DoorKing Gate Manager';
export const messages = {
  verify: (app: string, user: string, token: string) => ({
    subject: 'Confirm your email address',
    text: `Hello ${user},\n\nPlease confirm this email address for your DoorKing Gate Manager account by opening this link (valid for ${TOKEN_HOURS.verify} hours):\n\n${app}/#verify=${token}\n\nIf you didn't ask for this, ignore this email.${SIGN}`,
  }),
  emailChanged: (user: string, next: string) => ({
    subject: 'Your account email is being changed',
    text: `Hello ${user},\n\nSomeone signed in as you asked to change your account's email address to ${next}. It changes once that address is confirmed.\n\nIf this wasn't you, sign in and change your password straight away.${SIGN}`,
  }),
  reset: (app: string, user: string, token: string) => ({
    subject: 'Reset your password',
    text: `Hello ${user},\n\nTo choose a new password, open this link (valid for ${TOKEN_HOURS.reset} hour, usable once):\n\n${app}/#reset=${token}\n\nIf you didn't ask for this, ignore this email; your password stays the same.${SIGN}`,
  }),
  invite: (app: string, user: string, by: string, gate: string, token: string) => ({
    subject: 'You have been invited to DoorKing Gate Manager',
    text: `Hello,\n\n${by} created an account for you (username: ${user}) with access to ${gate}.\n\nChoose your password by opening this link (valid for ${TOKEN_HOURS.invite} hours):\n\n${app}/#invite=${token}\n\nThen sign in at ${app}.${SIGN}`,
  }),
  accessGranted: (app: string, user: string, by: string, gate: string, role: string) => ({
    subject: `You now have access to ${gate}`,
    text: `Hello ${user},\n\n${by} gave you ${role} access to ${gate}. Sign in at ${app} to open it.${SIGN}`,
  }),
  roleChanged: (app: string, user: string, by: string, gate: string, role: string) => ({
    subject: `Your access to ${gate} changed`,
    text: `Hello ${user},\n\n${by} changed your access to ${gate} to ${role}. ${app}${SIGN}`,
  }),
  accessRemoved: (user: string, by: string, gate: string) => ({
    subject: `Your access to ${gate} was removed`,
    text: `Hello ${user},\n\n${by} removed your access to ${gate}. If you think this is a mistake, contact one of the gate's admins.${SIGN}`,
  }),
  security: (app: string, user: string, what: string) => ({
    subject: `Security alert: ${what}`,
    text: `Hello ${user},\n\n${what} on your DoorKing Gate Manager account (${new Date().toUTCString()}).\n\nIf this wasn't you, sign in at ${app} and change your password, or ask for a password reset.${SIGN}`,
  }),
  gateAlert: (app: string, user: string, gate: string, what: string, detail: string) => ({
    subject: `Gate alert: ${what} (${gate})`,
    text: `Hello ${user},\n\n${what} for ${gate}.\n\n${detail}\n\nOpen the gate at ${app} for details (History, Scheduled Transfers). You get this as a gate admin; turn it off in User Settings.${SIGN}`,
  }),
};
