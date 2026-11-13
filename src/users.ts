// Local accounts and their sign-in sessions (tables users and sessions, see db.ts). Usernames and emails are
// case-insensitive (stored lower case) and unique. Passwords are kept as scrypt hashes; nobody can read or set
// another user's password from the web (the CLI's reset-password is for whoever runs the server). Sessions are
// random tokens kept as SHA-256 hashes, so a copy of the database can't be used to sign in.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { all, one, run, transaction, type Store } from './db.ts';

export const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, o: crypto.ScryptOptions) => Promise<Buffer>;

export interface User {
  username: string; email: string; dark: boolean; mustChangePassword: boolean;
  createdAt: string; createdBy: string; lastSignIn: string | null; signIns: number;
}
interface UserRow {
  username: string; password_hash: string; email: string | null; dark: boolean; must_change: boolean;
  created_at: string; created_by: string; last_sign_in: string | null; sign_ins: number;
}

const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
export const userKey = (u: unknown): string => String(u || '').trim().toLowerCase();
const fromRow = (r: UserRow): User => ({
  username: r.username, email: r.email || '', dark: r.dark, mustChangePassword: r.must_change,
  createdAt: r.created_at, createdBy: r.created_by, lastSignIn: r.last_sign_in, signIns: r.sign_ins,
});

// 3-32 letters, digits, '.', '_' or '-', starting with a letter or digit; returned lower case.
export function checkUsername(u: unknown): string {
  const name = userKey(u);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(name)) {
    throw bad('Username must be 3-32 letters, digits, dots, dashes or underscores, starting with a letter or digit');
  }
  return name;
}

export function checkPassword(pw: unknown): string {
  const s = String(pw ?? '');
  if (s.length < PASSWORD_MIN) throw bad(`Password must be at least ${PASSWORD_MIN} characters`);
  if (s.length > PASSWORD_MAX) throw bad(`Password must be at most ${PASSWORD_MAX} characters`);
  return s;
}

// '' (no email) or a lower-case address.
export function checkEmail(e: unknown): string {
  const s = userKey(e);
  if (s && (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) throw bad('That email address doesn\'t look right');
  return s;
}

// scrypt$N$r$p$salt$hash (base64).
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(pw, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return crypto.timingSafeEqual(got, want);
}
// Compared against when the username is unknown, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export async function userCount(store: Store): Promise<number> {
  return Number((await one<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM users'))!.n);
}

export async function getUser(store: Store, username: unknown): Promise<User | null> {
  const r = await one<UserRow>(store, 'SELECT * FROM users WHERE username = $1', [userKey(username)]);
  return r ? fromRow(r) : null;
}

const emailTaken = async (store: Store, email: string, except = '') =>
  Boolean(email && await one(store, 'SELECT 1 AS x FROM users WHERE email = $1 AND username <> $2', [email, except]));

// Creates an account. mustChangePassword: the password was set by someone else (a gate admin or the CLI), so the
// user picks their own at the next sign-in. Throws 409 when the username or email is taken.
export async function createUser(store: Store, { username, password, email = '', createdBy, mustChangePassword = true }:
  { username: unknown; password: unknown; email?: unknown; createdBy: string; mustChangePassword?: boolean }): Promise<User> {
  const name = checkUsername(username);
  const pw = checkPassword(password);
  const mail = checkEmail(email);
  if (await getUser(store, name)) throw bad(`The username "${name}" is already taken`, 409);
  if (await emailTaken(store, mail)) throw bad('That email address is already used by another account', 409);
  await run(store, `INSERT INTO users (username, password_hash, email, dark, must_change, created_at, created_by, sign_ins)
    VALUES ($1, $2, $3, false, $4, $5, $6, 0) ON CONFLICT (username) DO NOTHING`,
  [name, await hashPassword(pw), mail || null, mustChangePassword, new Date().toISOString(), userKey(createdBy)]);
  return (await getUser(store, name))!;
}

// The user when the password is right (and records the sign-in), else null.
export async function authenticate(store: Store, username: unknown, password: unknown): Promise<User | null> {
  const r = await one<UserRow>(store, 'SELECT * FROM users WHERE username = $1', [userKey(username)]);
  const ok = await verifyPassword(String(password ?? ''), r ? r.password_hash : await DUMMY_HASH);
  if (!r || !ok) return null;
  await run(store, 'UPDATE users SET last_sign_in = $2, sign_ins = sign_ins + 1 WHERE username = $1', [r.username, new Date().toISOString()]);
  return getUser(store, r.username);
}

// Sets a new password and ends the user's other sessions (keepSession: the token hash to keep, or none).
// mustChange: true when someone else set it (the CLI).
export async function setPassword(store: Store, username: unknown, password: unknown,
  { mustChange = false, keepSession = '' }: { mustChange?: boolean; keepSession?: string } = {}): Promise<void> {
  const name = userKey(username);
  const hash = await hashPassword(checkPassword(password));
  await transaction(store, async (tx) => {
    if (!await run(tx, 'UPDATE users SET password_hash = $2, must_change = $3 WHERE username = $1', [name, hash, mustChange])) {
      throw bad(`No user "${name}"`, 404);
    }
    await run(tx, 'DELETE FROM sessions WHERE username = $1 AND token_hash <> $2', [name, keepSession]);
  });
}

// The user's own password change: the current password must be right and the new one different.
export async function changeOwnPassword(store: Store, username: unknown, current: unknown, next: unknown, keepSession: string): Promise<void> {
  const r = await one<UserRow>(store, 'SELECT * FROM users WHERE username = $1', [userKey(username)]);
  if (!r || !await verifyPassword(String(current ?? ''), r.password_hash)) throw bad('Your current password is wrong', 403);
  if (String(next ?? '') === String(current ?? '')) throw bad('The new password must be different from the current one');
  await setPassword(store, r.username, next, { keepSession });
}

// The user's own settings: email ('' removes it) and dark mode.
export async function updateUserSettings(store: Store, username: unknown, { email, dark }: { email?: unknown; dark?: unknown }): Promise<User> {
  const name = userKey(username);
  if (email !== undefined) {
    const mail = checkEmail(email);
    if (await emailTaken(store, mail, name)) throw bad('That email address is already used by another account', 409);
    await run(store, 'UPDATE users SET email = $2 WHERE username = $1', [name, mail || null]);
  }
  if (dark !== undefined) await run(store, 'UPDATE users SET dark = $2 WHERE username = $1', [name, dark === true]);
  const u = await getUser(store, name);
  if (!u) throw bad(`No user "${name}"`, 404);
  return u;
}

export interface SessionInfo { tokenHash: string; username: string; gate: string | null; lastSeen: number }

const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

// A new session; returns the token for the cookie (only its hash is stored).
export async function createSession(store: Store, username: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  await run(store, 'INSERT INTO sessions (token_hash, username, created_at, last_seen) VALUES ($1, $2, $3, $3)', [tokenHash(token), userKey(username), now]);
  return token;
}

// The session for a cookie token, or null when unknown or idle longer than idleMs (it is then deleted).
// last_seen is written at most once a minute.
export async function findSession(store: Store, token: string, idleMs: number): Promise<SessionInfo | null> {
  const h = tokenHash(token);
  const r = await one<{ username: string; gate: string | null; last_seen: string }>(store,
    'SELECT username, gate, last_seen FROM sessions WHERE token_hash = $1', [h]);
  if (!r) return null;
  const seen = new Date(r.last_seen).getTime();
  const now = Date.now();
  if (now - seen > idleMs) { await run(store, 'DELETE FROM sessions WHERE token_hash = $1', [h]); return null; }
  if (now - seen > 60000) await run(store, 'UPDATE sessions SET last_seen = $2 WHERE token_hash = $1', [h, new Date(now).toISOString()]);
  return { tokenHash: h, username: r.username, gate: r.gate, lastSeen: now };
}

export async function deleteSession(store: Store, tokenHashValue: string): Promise<void> {
  await run(store, 'DELETE FROM sessions WHERE token_hash = $1', [tokenHashValue]);
}

// The gate the web UI has open in this session (null closes it).
export async function setSessionGate(store: Store, tokenHashValue: string, phone: string | null): Promise<void> {
  await run(store, 'UPDATE sessions SET gate = $2 WHERE token_hash = $1', [tokenHashValue, phone]);
}

// Deletes sessions idle longer than idleMs; returns the usernames whose sessions ended.
export async function sweepSessions(store: Store, idleMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - idleMs).toISOString();
  return (await all<{ username: string }>(store, 'DELETE FROM sessions WHERE last_seen < $1 RETURNING username', [cutoff])).map((r) => r.username);
}
