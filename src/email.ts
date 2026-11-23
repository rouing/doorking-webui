/**
 * @module src/email
 *
 * Email: an outbox (table emails) that a background sender delivers over SMTP (nodemailer), retrying failures, and
 * single-use link tokens (table email_tokens) for verifying an address, resetting a password and accepting an
 * invitation. Bodies hold links, so they are encrypted with the key and removed once an email is sent or given up;
 * tokens are stored only as SHA-256 hashes and expire. Links use the URL fragment (#reset=…), which browsers never
 * send to the server, so tokens don't end up in proxy logs.
 */
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { all, decrypt, encrypt, one, run, transaction, type Store } from './db.ts';
import { userKey } from './users.ts';
import type { ServerConfig } from './config.ts';

export type TokenKind = 'verify' | 'reset' | 'invite';
export const TOKEN_HOURS: Record<TokenKind, number> = { verify: 24, reset: 1, invite: 72 };
const RETRY_MINUTES = [1, 5, 15, 60, 240]; // after each failed try; then given up
const BATCH = 20;

interface QueuedEmailRow { id: number; to_addr: string; subject: string; body: string; attempts: number; kind: string }
interface OutboxEmailRow {
  id: number; to_addr: string; subject: string; kind: string; status: string; attempts: number; error: string | null; created_at: string;
  sent_at: string | null;
}
export interface OutboxEmail { id: number; to: string; subject: string; kind: string; status: string; attempts: number; error: string | null; createdAt: string; sentAt: string | null }
export interface Mailer { sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> }

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * A new link token for the user (earlier unused ones of the same kind stop working). data: e.g. the address being
 * verified. Returns the token (for the link only).
 *
 * @param store - Database store handle.
 * @param kind - Item or operation kind.
 * @param username - Local account username.
 * @param [data] - Binary or structured payload.
 * @returns Promise resolving to `string`.
 */
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

type TokenUse = { username: string; data: string } | null;

/**
 * The token's user and data if it is valid, unexpired and of this kind; a token of this kind is used up either way
 * when found (one of another kind, e.g. an invitation opened as a password reset, is left as it is).
 *
 * @param store - Database store handle.
 * @param kind - Item or operation kind.
 * @param token - One-time link token or session token.
 * @returns Promise resolving to `TokenUse`.
 */
export function useToken(store: Store, kind: TokenKind, token: unknown): Promise<TokenUse> {
  return findToken(store, kind, token, 'DELETE FROM email_tokens WHERE token_hash = $1 AND kind = $2 RETURNING username, data, expires_at');
}

/**
 * The same, without using it up (to show whose invitation it is).
 *
 * @param store - Database store handle.
 * @param kind - Item or operation kind.
 * @param token - One-time link token or session token.
 * @returns Promise resolving to `TokenUse`.
 */
export function peekToken(store: Store, kind: TokenKind, token: unknown): Promise<TokenUse> {
  return findToken(store, kind, token, 'SELECT username, data, expires_at FROM email_tokens WHERE token_hash = $1 AND kind = $2');
}

async function findToken(store: Store, kind: TokenKind, token: unknown, sql: string): Promise<TokenUse> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await one<{ username: string; data: string; expires_at: string }>(store, sql, [sha(token), kind]);
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return { username: row.username, data: row.data };
}

/**
 * Delete expired tokens.
 *
 * @param store - Database store handle.
 * @returns Promise resolving to `number`.
 */
export async function deleteExpiredTokens(store: Store): Promise<number> {
  return run(store, 'DELETE FROM email_tokens WHERE expires_at < now()');
}

/**
 * Queues an email (kind: what it is, for the log). The body is stored encrypted until it is sent.
 *
 * @param store - Database store handle.
 * @param options - Options object.
 * @param options.to - Recipient email address.
 * @param options.subject - Provider subject identifier (`sub` claim).
 * @param options.text - Input text string.
 * @param options.kind - What it is, for the log.
 * @returns Promise resolving to `number`.
 */
export async function queueEmail(store: Store, { to, subject, text, kind }: { to: string; subject: string; text: string; kind: string }): Promise<number> {
  const row = await one<{ id: number }>(store, `INSERT INTO emails (to_addr, subject, kind, body, status, attempts, next_try, created_at)
    VALUES ($1, $2, $3, $4, 'queued', 0, now(), now()) RETURNING id`, [to, subject, kind, encrypt(store, text)]);
  return row!.id;
}

/**
 * A failed send: tried again after wait minutes, or given up (wait undefined: the retries are used up).
 *
 * @param store - Database store handle.
 * @param id - Unique record identifier.
 * @param msg - Error or email message.
 * @param wait - `number | undefined` value.
 */
async function recordFailure(store: Store, id: number, msg: string, wait: number | undefined): Promise<void> {
  if (wait === undefined) {
    await run(store, "UPDATE emails SET status = 'failed', attempts = attempts + 1, error = $2, body = NULL WHERE id = $1", [id, msg]);
    return;
  }
  await run(store, `UPDATE emails SET attempts = attempts + 1, error = $2, next_try = now() + ($3 || ' minutes')::interval WHERE id = $1`,
    [id, msg, String(wait)]);
}

/**
 * Sends the queued emails that are due. A failure is tried again after RETRY_MINUTES; after the last it is given up.
 * Returns the counts. log(message) gets each failure.
 *
 * @param store - Database store handle.
 * @param mailer - Configured SMTP mailer, or `null` when email is disabled.
 * @param from - `string` value.
 * @param [log] - Callback receiving progress or diagnostic messages.
 * @returns Promise resolving to `{ sent: number; failed: number }`.
 */
export async function sendQueued(store: Store, mailer: Mailer, from: string, log: (message: string) => void = () => {}): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const due = await all<QueuedEmailRow>(store,
    `SELECT id, to_addr, subject, body, attempts, kind FROM emails WHERE status = 'queued' AND next_try <= now() ORDER BY id LIMIT $1`, [BATCH]);
  for (const email of due) {
    try {
      await mailer.sendMail({ from, to: email.to_addr, subject: email.subject, text: decrypt(store, email.body) });
      await run(store, "UPDATE emails SET status = 'sent', attempts = attempts + 1, sent_at = now(), body = NULL, error = NULL WHERE id = $1", [email.id]);
      out.sent++;
    } catch (err) {
      const msg = String((err as Error).message || err).slice(0, 300);
      const wait = RETRY_MINUTES[email.attempts];
      await recordFailure(store, email.id, msg, wait);
      log(`Email ${email.id} (${email.kind}) to ${email.to_addr} not sent${wait === undefined ? ', given up' : `, trying again in ${wait} min`}: ${msg}`);
      out.failed++;
    }
  }
  return out;
}

/**
 * The most recent emails (without bodies), newest first.
 *
 * @param store - Database store handle.
 * @param [limit] - Maximum number of rows to return.
 * @returns Promise resolving to `OutboxEmail[]`.
 */
export async function listEmails(store: Store, limit = 100): Promise<OutboxEmail[]> {
  return (await all<OutboxEmailRow>(store,
    `SELECT id, to_addr, subject, kind, status, attempts, error, created_at, sent_at FROM emails ORDER BY id DESC LIMIT $1`, [limit]))
    .map((row) => ({ id: row.id, to: row.to_addr, subject: row.subject, kind: row.kind, status: row.status, attempts: row.attempts, error: row.error, createdAt: row.created_at, sentAt: row.sent_at }));
}

/**
 * The SMTP sender for config.email, or null when email is off (no host).
 *
 * @param cfg - Configuration or settings object.
 * @returns `Mailer | null` result.
 */
export function createMailer(cfg: ServerConfig['email']): Mailer | null {
  if (!cfg.host) return null;
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.security === 'tls', requireTLS: cfg.security === 'starttls', ignoreTLS: cfg.security === 'none',
    ...(cfg.user && { auth: { user: cfg.user, pass: cfg.password } }),
  });
}

/** The texts. app: the address links point to. All plain text. */
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
  residentInvite: (app: string, email: string, gate: string, code: string, token: string) => ({
    subject: `Set up your ${gate} Resident Portal`,
    text: `Hello,\n\nYour Resident Portal for ${gate} (Directory Code ${code}) is ready.\n\nChoose a password by opening this link (valid for ${TOKEN_HOURS.invite} hours):\n\n${app}/#invite=${token}\n\nAfter setting your password, sign in anytime at ${app} using your email address (${email}) or a passkey.\n\nInstall on your phone for quick access & push alerts:\n• iPhone (Safari): open ${app}, tap Share → Add to Home Screen, then open the app icon.\n• Android (Chrome): open ${app}, tap ⋮ → Install app.\n\nOnce installed, you can turn on Push Notifications and Passkey sign-in under the Account tab.${SIGN}`,
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
