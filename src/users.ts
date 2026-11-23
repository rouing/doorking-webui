/**
 * @module src/users
 *
 * Local accounts and their sign-in sessions (tables users and sessions, see db.ts). Usernames and emails are
 * case-insensitive (stored lower case) and unique. Passwords are kept as scrypt hashes; nobody can read or set
 * another user's password from the web (the CLI's reset-password is for whoever runs the server). Sessions are
 * random tokens kept as SHA-256 hashes, so a copy of the database can't be used to sign in.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { all, getMeta, one, run, setMeta, transaction, type Store } from './db.ts';
import { httpError } from './errors.ts';
import { PASSWORD_MIN } from './shared.ts';

const PASSWORD_MAX = 200;
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, len: number, options: crypto.ScryptOptions) => Promise<Buffer>;

/**
 * email: the verified address ('' none); pendingEmail: an address waiting for its confirmation link. phone: E.164
 * ('' none; not verified). invited: the
 * account was created with an email invitation that hasn't been accepted yet (it has no password). hasPassword: it has a
 * password (accounts created or accepted through single sign-on have none until they set one with a reset link).
 */
export interface User {
  username: string; email: string; pendingEmail: string; phone: string; dark: boolean; mustChangePassword: boolean; notifyAccess: boolean;
  notifyAlerts: boolean; invited: boolean; hasPassword: boolean; createdAt: string; createdBy: string; lastSignIn: string | null; signIns: number;
  resetAt: string | null; // the last password reset by email link
}
interface UserRow {
  username: string; password_hash: string; email: string | null; pending_email: string | null; phone: string | null; dark: boolean; must_change: boolean;
  notify_access: boolean; notify_alerts: boolean; created_at: string; created_by: string; last_sign_in: string | null; sign_ins: number;
  reset_at: string | null;
}
/**
 * The password hash of an invited account that hasn't chosen a password yet: nothing can match it.
 * The password hash of an account that signs in with single sign-on and has no password: nothing can match it either.
 */
const SSO_ONLY = '!sso';
const hasPasswordHash = (hash: string): boolean => hash !== NO_PASSWORD && hash !== SSO_ONLY;
const NO_PASSWORD = '!';

/**
 * User key.
 *
 * @param user - Local account username (or actor name for audit logs).
 * @returns `string` result.
 */
export const userKey = (user: unknown): string => String(user || '').trim().toLowerCase();
const fromRow = (row: UserRow): User => ({
  username: row.username, email: row.email || '', pendingEmail: row.pending_email || '', phone: row.phone || '', dark: row.dark, mustChangePassword: row.must_change,
  notifyAccess: row.notify_access, notifyAlerts: row.notify_alerts, invited: row.password_hash === NO_PASSWORD, hasPassword: hasPasswordHash(row.password_hash), createdAt: row.created_at, createdBy: row.created_by, lastSignIn: row.last_sign_in, signIns: row.sign_ins,
  resetAt: row.reset_at ? new Date(row.reset_at).toISOString() : null,
});

/**
 * 3-32 letters, digits, '.', '_' or '-', starting with a letter or digit; returned lower case.
 *
 * @param given - Unvalidated caller input.
 * @returns `string` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkUsername(given: unknown): string {
  const name = userKey(given);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(name)) {
    throw httpError('Username must be 3-32 letters, digits, dots, dashes or underscores, starting with a letter or digit');
  }
  return name;
}

/**
 * Check password.
 *
 * @param password - Plain-text password.
 * @returns `string` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkPassword(password: unknown): string {
  const text = String(password ?? '');
  if (text.length < PASSWORD_MIN) throw httpError(`Password must be at least ${PASSWORD_MIN} characters`);
  if (text.length > PASSWORD_MAX) throw httpError(`Password must be at most ${PASSWORD_MAX} characters`);
  return text;
}

/**
 * The user's phone number in international form (E.164: + country code and digits), or '' for none.
 * Validated and normalized via libphonenumber-js; numbers without a leading + default to US/Canada (+1).
 *
 * @param given - Unvalidated caller input.
 * @returns `string` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkUserPhone(given: unknown): string {
  const raw = String(given ?? '').trim();
  if (!raw) return '';
  if (!/^\+?[\d\s().\-]+$/.test(raw)) {
    throw httpError('A phone number may only have digits, spaces, dashes, brackets and a leading +');
  }
  const parsed = parsePhoneNumberFromString(raw, raw.startsWith('+') ? undefined : 'US');
  if (!parsed || !parsed.isPossible()) {
    throw httpError('Enter a 10-digit US/Canada number, or + and the country code (for example +44 20 7946 0958)');
  }
  return parsed.number;
}

/**
 * '' (no email) or a lower-case address.
 *
 * @param email - Email address.
 * @returns `string` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkEmail(email: unknown): string {
  const name = userKey(email);
  if (name && (name.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name))) throw httpError('That email address doesn\'t look right');
  return name;
}

/**
 * scrypt$N$r$p$salt$hash (base64).
 *
 * @param password - Plain-text password.
 * @returns Promise resolving to `string`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Verify password.
 *
 * @param password - Plain-text password.
 * @param stored - `string` value.
 * @returns Promise resolving to `true` when the condition holds.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return crypto.timingSafeEqual(got, want);
}
/** Compared against when the username is unknown, so a wrong username takes as long as a wrong password. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/**
 * User count.
 *
 * @param store - Database store handle.
 * @returns Promise resolving to `number`.
 */
export async function userCount(store: Store): Promise<number> {
  return Number((await one<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM users'))!.n);
}

/**
 * Get user.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `User | null`.
 */
export async function getUser(store: Store, username: string): Promise<User | null> {
  const row = await one<UserRow>(store, 'SELECT * FROM users WHERE username = $1', [userKey(username)]);
  return row ? fromRow(row) : null;
}

const emailTaken = async (store: Store, email: string, except = '') =>
  Boolean(email && await one(store, 'SELECT 1 AS x FROM users WHERE email = $1 AND username <> $2', [email, except]));

/**
 * Drops the "choose a new password" requirement (the account can't use a password: a linked provider turns them off).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 */
export async function clearMustChangePassword(store: Store, username: string): Promise<void> {
  await run(store, 'UPDATE users SET must_change = false WHERE username = $1', [userKey(username)]);
}

/**
 * Creates an account. The email given starts unconfirmed (pendingEmail). mustChangePassword: the password was set by
 * someone else (a gate admin or the CLI), so the user picks their own at the next sign-in. invite: no password yet;
 * the user sets one through their invitation link (acceptInvite). Throws 409 when the username or email is taken.
 */
export interface CreateUserParams {
  username: unknown; password?: unknown; email?: unknown; createdBy: string; mustChangePassword?: boolean; invite?: boolean;
}
/**
 * Create user.
 *
 * @param store - Database store handle.
 * @param options - Options object.
 * @param options.username - Local account username.
 * @param options.password - Plain-text password.
 * @param [options.email] - Email address.
 * @param options.createdBy - Username of the creator.
 * @param [options.mustChangePassword] - Must change password.
 * @param [options.invite] - Whether the account is being invited without a password.
 * @returns Promise resolving to `User`.
 * @throws HTTP 400/409 error on invalid input or conflict.
 */
export async function createUser(store: Store, { username, password, email = '', createdBy, mustChangePassword = true, invite = false }:
  CreateUserParams): Promise<User> {
  const name = checkUsername(username);
  const mail = checkEmail(email);
  if (invite && !mail) throw httpError('An invitation needs an email address');
  const hash = invite ? NO_PASSWORD : await hashPassword(checkPassword(password));
  if (await getUser(store, name)) throw httpError(`The username "${name}" is already taken`, 409);
  if (await emailTaken(store, mail)) throw httpError('That email address is already used by another account', 409);
  const added = await run(store, `INSERT INTO users (username, password_hash, pending_email, dark, must_change, created_at, created_by, sign_ins)
    VALUES ($1, $2, $3, false, $4, $5, $6, 0) ON CONFLICT (username) DO NOTHING`,
  [name, hash, mail || null, invite ? false : mustChangePassword, new Date().toISOString(), userKey(createdBy)]);
  if (!added) throw httpError(`The username "${name}" is already taken`, 409); // created at the same moment
  return (await getUser(store, name))!;
}

/**
 * Sets the password of an invited account and confirms its email (the invitation went to it). Returns the user.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param password - Plain-text password.
 * @returns Promise resolving to `User`.
 */
export async function acceptInvite(store: Store, username: string, password: unknown): Promise<User> {
  const name = userKey(username);
  const hash = await hashPassword(checkPassword(password));
  return takeInvite(store, name, hash);
}
/**
 * Sets the password hash of an invited account only while it still has none (one UPDATE, so of two acceptances at
 * once only one wins) and confirms the invited email.
 *
 * @param store - Database store handle.
 * @param name - Display name or filename.
 * @param hash - `string` value.
 * @returns Promise resolving to `User`.
 * @throws HTTP 409 error on invalid input or conflict.
 */
async function takeInvite(store: Store, name: string, hash: string): Promise<User> {
  const row = await one<{ pending_email: string | null }>(store,
    'UPDATE users SET password_hash = $2, must_change = false WHERE username = $1 AND password_hash = $3 RETURNING pending_email', [name, hash, NO_PASSWORD]);
  if (!row) throw httpError('This invitation was already used. Sign in instead.', 409);
  if (row.pending_email) await confirmEmail(store, name, row.pending_email);
  return (await getUser(store, name))!;
}

/**
 * Accepts an invitation through single sign-on: the account gets no password (it signs in with SSO) and its email, which
 * the invitation went to, is confirmed. Returns the user; 409 when the invitation was already used.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `User`.
 */
export async function acceptInviteWithSso(store: Store, username: string): Promise<User> {
  return takeInvite(store, userKey(username), SSO_ONLY);
}

/**
 * Creates an account for someone signing in with single sign-on (no password; email confirmed by the provider). The
 * username comes from the email's part before @, made valid and unique (smith.j, smith.j-2, …). 409 when the email
 * belongs to another account.
 *
 * @param store - Database store handle.
 * @param options - Options object.
 * @param options.email - Email address.
 * @param options.createdBy - Username of the creator.
 * @returns Promise resolving to `User`.
 * @throws HTTP 400/409 error on invalid input or conflict.
 */
/** Normalizes an email local-part into a valid 3–28 character username base, appending `-{attempt}` safely within 32 chars. */
function usernameCandidate(email: string, attempt: number): string {
  let base = email.split('@')[0].replace(/[^a-z0-9._-]+/g, '.').replace(/^[^a-z0-9]+/, '').slice(0, 28).replace(/[._-]+$/, '');
  if (base.length < 3) base = `${base || 'user'}${'000'.slice(base.length)}`.slice(0, 28);
  if (attempt === 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, Math.max(3, 32 - suffix.length))}${suffix}`;
}

export async function createSsoUser(store: Store, { email, createdBy }: { email: unknown; createdBy: string }): Promise<User> {
  const mail = checkEmail(email);
  if (!mail) throw httpError('An email address is needed');
  if (await emailTaken(store, mail)) throw httpError('That email address is already used by another account', 409);
  for (let i = 1; ; i++) {
    const name = usernameCandidate(mail, i);
    if (await getUser(store, name)) continue;
    const added = await run(store, `INSERT INTO users (username, password_hash, email, dark, must_change, created_at, created_by, sign_ins)
      VALUES ($1, $2, $3, false, false, $4, $5, 0) ON CONFLICT (username) DO NOTHING`, [name, SSO_ONLY, mail, new Date().toISOString(), userKey(createdBy)]);
    if (added) return (await getUser(store, name))!;
  }
}

/**
 * Makes `address` the user's confirmed email, if it is still their pending one and no other account has confirmed
 * it meanwhile. Returns the user, or throws (409 taken, 400 no longer pending).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param address - `string` value.
 * @returns Promise resolving to `User`.
 */
export async function confirmEmail(store: Store, username: string, address: string): Promise<User> {
  const name = userKey(username);
  const mail = userKey(address);
  await transaction(store, async (tx) => {
    const row = await one<{ pending_email: string | null }>(tx, 'SELECT pending_email FROM users WHERE username = $1 FOR UPDATE', [name]);
    if (!row || row.pending_email !== mail) throw httpError('This link is for an address that is no longer waiting to be confirmed');
    if (await emailTaken(tx, mail, name)) throw httpError('That email address is already used by another account', 409);
    await run(tx, 'UPDATE users SET email = $2, pending_email = NULL WHERE username = $1', [name, mail]);
    await run(tx, 'DELETE FROM email_tokens WHERE username = $1 AND kind = \'reset\'', [name]); // links sent to the old address
  });
  return (await getUser(store, name))!;
}

/**
 * The account for a password reset: by username or confirmed email; null when there is none, or it has no confirmed email.
 *
 * @param store - Database store handle.
 * @param identifier - `unknown` value.
 * @returns Promise resolving to `User | null`.
 */
export async function userForReset(store: Store, identifier: unknown): Promise<User | null> {
  const id = userKey(identifier);
  if (!id) return null;
  const row = await one<UserRow>(store, 'SELECT * FROM users WHERE (username = $1 OR email = $1) AND email IS NOT NULL', [id]);
  return row && row.password_hash !== NO_PASSWORD ? fromRow(row) : null;
}

/**
 * The accounts that should get this gate's alerts: its admins with a confirmed email and alerts on.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `{ username: string; email: string }[]`.
 */
export async function alertRecipients(store: Store, phone: string): Promise<{ username: string; email: string }[]> {
  return all(store, `SELECT u.username, u.email FROM gate_access a JOIN users u ON u.username = a.username
    WHERE a.phone = $1 AND a.role = 'admin' AND u.email IS NOT NULL AND u.notify_alerts`, [phone]);
}

/**
 * Once (2026-11-13): emails saved before confirmation links existed become unconfirmed (pending).
 *
 * @param store - Database store handle.
 * @returns Promise resolving to `number | null`.
 */
export async function unconfirmOldEmails(store: Store): Promise<number | null> {
  if (await getMeta(store, 'emailsUnconfirmed')) return null;
  const changed = await run(store, 'UPDATE users SET pending_email = email, email = NULL WHERE email IS NOT NULL AND pending_email IS NULL');
  await setMeta(store, 'emailsUnconfirmed', new Date().toISOString());
  return changed;
}

/**
 * The user when the password is right (and records the sign-in), else null. refuse: asked before the password is
 * checked; when it returns a reason, the password counts as wrong (null, like any wrong password, so the answer doesn't
 * tell whether the password was right).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param password - Plain-text password.
 * @param [refuse] - Asked before the password is checked.
 * @returns Promise resolving to `User | null`.
 */
export async function authenticate(store: Store, username: string, password: unknown,
  refuse?: (name: string) => Promise<string | null>): Promise<User | null> {
  const row = await one<UserRow>(store, 'SELECT * FROM users WHERE username = $1 OR (email = $1 AND email IS NOT NULL)', [userKey(username)]);
  /**
   * An account whose password sign-in is refused is checked against the dummy hash too, so the answer is the same
   * whether or not the old password was right.
   */
  const why = row && refuse ? await refuse(row.username) : null;
  const usable = row && !why && hasPasswordHash(row.password_hash);
  const ok = await verifyPassword(String(password ?? ''), usable ? row.password_hash : await DUMMY_HASH) && usable;
  if (!row || !ok) return null;
  await recordSignIn(store, row.username);
  return getUser(store, row.username);
}

/**
 * Counts a sign-in (password or passkey).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 */
export async function recordSignIn(store: Store, username: string): Promise<void> {
  await run(store, 'UPDATE users SET last_sign_in = $2, sign_ins = sign_ins + 1 WHERE username = $1', [userKey(username), new Date().toISOString()]);
}

/**
 * Finds an existing account by its confirmed or pending email address (case-insensitive).
 *
 * @param store - Database store handle.
 * @param email - Email address.
 * @returns Promise resolving to `User | null`.
 */
export async function findUserByEmail(store: Store, email: string): Promise<User | null> {
  const mail = userKey(email);
  if (!mail) return null;
  const row = await one<UserRow>(store, 'SELECT * FROM users WHERE email = $1 OR pending_email = $1 ORDER BY (email = $1) DESC LIMIT 1', [mail]);
  return row ? fromRow(row) : null;
}

/**
 * Finds an existing account eligible to be bound to a Resident Portal unit for `email`:
 * matches only a confirmed `email` OR an unaccepted admin invitation (`pending_email` with `password_hash = '!'`).
 * Unverified `pending_email` changes on active accounts are intentionally ignored to prevent unit takeover.
 */
export async function findUserForPortalBind(store: Store, email: string): Promise<User | null> {
  const mail = userKey(email);
  if (!mail) return null;
  const row = await one<UserRow>(store,
    "SELECT * FROM users WHERE email = $1 OR (pending_email = $1 AND password_hash = '!') ORDER BY (email = $1) DESC LIMIT 1",
    [mail]);
  return row ? fromRow(row) : null;
}

/**
 * Generates an unused local username derived from an email address (e.g. `jane.smith`, `jane.smith-2`).
 */
export async function uniqueUsernameForEmail(store: Store, email: string): Promise<string> {
  const mail = checkEmail(email);
  if (!mail) throw httpError('An email address is needed');
  for (let i = 1; ; i++) {
    const candidate = usernameCandidate(mail, i);
    if (!await getUser(store, candidate)) return candidate;
  }
}

/**
 * Permanently wipes a user account along with all sessions, passkeys, push subscriptions, email tokens,
 * SSO identities, and resident requests (used when revoking a resident-only account with no remaining access).
 *
 * @param store - Database store handle (or active transaction).
 * @param username - Local account username.
 */
export async function deleteUserCompletely(store: Store, username: string): Promise<void> {
  const name = userKey(username);
  if (!name) return;
  await run(store, 'DELETE FROM sessions WHERE username = $1', [name]);
  await run(store, 'DELETE FROM passkeys WHERE username = $1', [name]);
  await run(store, 'DELETE FROM push_subscriptions WHERE username = $1', [name]);
  await run(store, 'DELETE FROM email_tokens WHERE username = $1', [name]);
  await run(store, 'DELETE FROM user_identities WHERE username = $1', [name]);
  await run(store, 'DELETE FROM resident_requests WHERE username = $1', [name]);
  await run(store, 'DELETE FROM users WHERE username = $1', [name]);
}

/**
 * True when `password` is the user's current one (to confirm a sensitive change, such as adding a passkey).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param password - Plain-text password.
 * @returns Promise resolving to `true` when the condition holds.
 */
export async function checkOwnPassword(store: Store, username: string, password: unknown): Promise<boolean> {
  const row = await one<UserRow>(store, 'SELECT * FROM users WHERE username = $1', [userKey(username)]);
  return Boolean(row) && verifyPassword(String(password ?? ''), row!.password_hash);
}

/**
 * Sets a new password and ends the user's other sessions (keepSession: the token hash to keep, or none).
 * mustChange: true when someone else set it (the CLI).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param password - Plain-text password.
 * @param [options] - Options object.
 * @param [options.mustChange] - When `true`, require a password change on next sign-in (admin/CLI reset).
 * @param [options.keepSession] - The token hash to keep, or none.
 * @param [options.byEmail] - Whether the reset came from an email link (updates `reset_at`).
 */
export async function setPassword(store: Store, username: string, password: unknown,
  { mustChange = false, keepSession = '', byEmail = false }: { mustChange?: boolean; keepSession?: string; byEmail?: boolean } = {}): Promise<void> {
  const name = userKey(username);
  const hash = await hashPassword(checkPassword(password));
  await transaction(store, async (tx) => {
    if (!await run(tx, `UPDATE users SET password_hash = $2, must_change = $3${byEmail ? ', reset_at = now()' : ''} WHERE username = $1`, [name, hash, mustChange])) {
      throw httpError(`No user "${name}"`, 404);
    }
    await run(tx, 'DELETE FROM sessions WHERE username = $1 AND token_hash <> $2', [name, keepSession]);
    await run(tx, 'DELETE FROM email_tokens WHERE username = $1 AND kind = \'reset\'', [name]); // older reset links stop working
  });
}

/**
 * The user's own password change: the new password must differ from the current one, which the caller has checked
 * (web/auth.ts confirmOwnPassword, with its failed-try limits).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param options - Options object.
 * @param options.current - Current password or state.
 * @param options.next - New value or next state.
 * @param options.keepSession - Session token hash to keep signed in.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export async function changeOwnPassword(store: Store, username: string, { current, next, keepSession }: { current: unknown; next: unknown; keepSession: string }): Promise<void> {
  if (String(next ?? '') === String(current ?? '')) throw httpError('The new password must be different from the current one');
  await setPassword(store, username, next, { keepSession });
}

/**
 * '' removes the email (confirmed and pending); the confirmed address clears a pending change; any other address
 * becomes pending until its link is opened.
 *
 * @param store - Database store handle.
 * @param name - Display name or filename.
 * @param mail - `string` value.
 * @throws HTTP 409 error on invalid input or conflict.
 */
async function setOwnEmail(store: Store, name: string, mail: string): Promise<void> {
  if (!mail) {
    await run(store, 'UPDATE users SET email = NULL, pending_email = NULL WHERE username = $1', [name]);
    await run(store, 'DELETE FROM email_tokens WHERE username = $1 AND kind IN (\'reset\', \'verify\')', [name]);
    return;
  }
  const current = await getUser(store, name);
  if (current && mail === current.email) {
    await run(store, 'UPDATE users SET pending_email = NULL WHERE username = $1', [name]);
    return;
  }
  if (await emailTaken(store, mail, name)) throw httpError('That email address is already used by another account', 409);
  await run(store, 'UPDATE users SET pending_email = $2 WHERE username = $1', [name, mail]);
}

/**
 * The user's own settings: dark mode, phone ('' removes it), the two email notifications, and email: '' removes it (confirmed and pending);
 * the confirmed address clears a pending change; any other address becomes pending until its link is opened.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param options - Options object.
 * @param options.email - Email address.
 * @param options.dark - Dark.
 * @param options.phone - User's E.164 phone number (or blank string to remove).
 * @param options.notifyAccess - Notify access.
 * @param options.notifyAlerts - Notify alerts.
 * @returns Promise resolving to `User`.
 * @throws HTTP 404 error on invalid input or conflict.
 */
export async function updateUserSettings(store: Store, username: string, { email, dark, phone, notifyAccess, notifyAlerts }:
  { email?: unknown; dark?: unknown; phone?: unknown; notifyAccess?: unknown; notifyAlerts?: unknown }): Promise<User> {
  const name = userKey(username);
  if (phone !== undefined) await run(store, 'UPDATE users SET phone = $2 WHERE username = $1', [name, checkUserPhone(phone) || null]);
  if (email !== undefined) await setOwnEmail(store, name, checkEmail(email));
  if (dark !== undefined) await run(store, 'UPDATE users SET dark = $2 WHERE username = $1', [name, dark === true]);
  if (notifyAccess !== undefined) await run(store, 'UPDATE users SET notify_access = $2 WHERE username = $1', [name, notifyAccess !== false]);
  if (notifyAlerts !== undefined) await run(store, 'UPDATE users SET notify_alerts = $2 WHERE username = $1', [name, notifyAlerts !== false]);
  const user = await getUser(store, name);
  if (!user) throw httpError(`No user "${name}"`, 404);
  return user;
}

/** strongAt: when the session was last confirmed with a passkey (sign-in or confirmation), ms; null never. */
export interface SessionInfo { tokenHash: string; username: string; gate: string | null; lastSeen: number; strongAt: number | null; createdAt: number }

const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * A new session; returns the token for the cookie (only its hash is stored). strong: signed in with a passkey.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param [options] - Options object.
 * @param [options.strong] - Signed in with a passkey.
 * @returns Promise resolving to `string`.
 */
export async function createSession(store: Store, username: string, { strong = false } = {}): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  await run(store, 'INSERT INTO sessions (token_hash, username, created_at, last_seen, strong_at) VALUES ($1, $2, $3, $3, $4)',
    [tokenHash(token), userKey(username), now, strong ? now : null]);
  return token;
}

/**
 * Records a passkey confirmation on the session (see SessionInfo.strongAt); returns its time (ms).
 *
 * @param store - Database store handle.
 * @param tokenHashValue - SHA-256 hash of the session token.
 * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Promise resolving to `number`.
 */
export async function markSessionStrong(store: Store, tokenHashValue: string, now = Date.now()): Promise<number> {
  await run(store, 'UPDATE sessions SET strong_at = $2 WHERE token_hash = $1', [tokenHashValue, new Date(now).toISOString()]);
  return now;
}

const LOOPBACK_RE = /^(::1$|127\.|::ffff:127\.)/;
const PRIVATE_PROXY_RE = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|f[cd][0-9a-f]{2}:)/i;

/**
 * The client's address. Behind Caddy/NGINX on loopback (or a private Docker/LAN subnet when trustPrivate is true),
 * the last entry of X-Forwarded-For is the proxy's view of the client; from anywhere else the header is ignored.
 *
 * @param remote - Socket remote address.
 * @param forwarded - `X-Forwarded-For` header value.
 * @param [trustPrivate] - When `true`, also trust `X-Forwarded-For` from RFC 1918 private proxy subnets.
 * @returns `string` result.
 */
export function clientAddress(remote: string | undefined, forwarded: unknown, trustPrivate = false): string {
  const from = remote || '';
  const trusted = trustPrivate ? PRIVATE_PROXY_RE : LOOPBACK_RE;
  if (typeof forwarded === 'string' && forwarded.trim() && trusted.test(from)) return forwarded.split(',').pop()!.trim();
  return from;
}

/**
 * Failed sign-in limits as [key, limit]: one account from one address (max), one address over any accounts (4x), and one
 * account from any addresses (10x), so a stranger can't lock an account from a single address.
 */
export const SIGN_IN_IP_FACTOR = 4;
export const SIGN_IN_USER_FACTOR = 10;
/**
 * Sign in keys.
 *
 * @param user - Local account username (or actor name for audit logs).
 * @param ip - Client IP address.
 * @param max - `number` value.
 * @returns `[string, number][]` result.
 */
export const signInKeys = (user: string, ip: string, max: number): [string, number][] =>
  [[`${user}|${ip}`, max], [`ip:${ip}`, max * SIGN_IN_IP_FACTOR], [user, max * SIGN_IN_USER_FACTOR]];

/**
 * How a signed-in user must re-confirm who they are before a sensitive account change. strong: confirmed with a
 * passkey within windowMs; resetAt: last password reset by email link (ms). Adding or removing a passkey when there
 * is one needs a passkey confirmation, or a sign-in after a reset within windowMs (the way back for a lost passkey);
 * removing one is then allowed. The first passkey needs nothing more within FRESH_SIGN_IN_MS of signing in (so the
 * browser can save one right after a password sign-in). Otherwise (email, first passkey): the current password;
 * without one, a passkey confirmation when there is a passkey, else a sign-in within windowMs.
 */
export const FRESH_SIGN_IN_MS = 2 * 60000;
export type ReauthChange = 'email' | 'add-passkey' | 'remove-passkey';
export type Reauth = 'ok' | 'password' | 'step-up' | 'sign-in-again';
/**
 * What reauthNeeded decides from: the session's passkey confirmation (strong), the account's password and passkeys,
 * when the session signed in and when the password was last reset by email link (ms).
 */
export interface ReauthState {
  strong: boolean; hasPassword: boolean; passkeys: number; signedInAt: number; resetAt: number | null; now: number; windowMs: number;
}
/**
 * Reauth needed.
 *
 * @param state - Current state object.
 * @param change - Type of sensitive account change.
 * @returns `Reauth` result.
 */
export function reauthNeeded(state: ReauthState, change: ReauthChange): Reauth {
  if (state.strong) return 'ok';
  if (change === 'add-passkey' && state.passkeys === 0 && state.now - state.signedInAt <= FRESH_SIGN_IN_MS) return 'ok';
  if (change !== 'email' && state.passkeys > 0) {
    const recovering = state.resetAt !== null && state.signedInAt >= state.resetAt && state.now - state.resetAt <= state.windowMs;
    if (!recovering) return 'step-up';
    if (change === 'remove-passkey') return 'ok';
  }
  if (change === 'remove-passkey') return 'ok';
  if (state.hasPassword) return 'password';
  if (state.passkeys > 0) return 'step-up';
  return state.now - state.signedInAt <= state.windowMs ? 'ok' : 'sign-in-again';
}

/**
 * The session for a cookie token, or null when unknown, idle longer than idleMs or signed in longer than maxAgeMs
 * ago (it is then deleted).
 * last_seen is written at most once a minute.
 *
 * @param store - Database store handle.
 * @param token - One-time link token or session token.
 * @param idleMs - Idle timeout in milliseconds.
 * @param [maxAgeMs] - Maximum session age in milliseconds.
 * @returns Promise resolving to `SessionInfo | null`.
 */
export async function findSession(store: Store, token: string, idleMs: number, maxAgeMs = Infinity): Promise<SessionInfo | null> {
  const hash = tokenHash(token);
  const row = await one<{ username: string; gate: string | null; last_seen: string; strong_at: string | null; created_at: string }>(store,
    'SELECT username, gate, last_seen, strong_at, created_at FROM sessions WHERE token_hash = $1', [hash]);
  if (!row) return null;
  const seen = new Date(row.last_seen).getTime();
  const now = Date.now();
  if (now - seen > idleMs || now - new Date(row.created_at).getTime() > maxAgeMs) {
    await run(store, 'DELETE FROM sessions WHERE token_hash = $1', [hash]);
    return null;
  }
  if (now - seen > 60000) await run(store, 'UPDATE sessions SET last_seen = $2 WHERE token_hash = $1', [hash, new Date(now).toISOString()]);
  return { tokenHash: hash, username: row.username, gate: row.gate, lastSeen: now, strongAt: row.strong_at ? new Date(row.strong_at).getTime() : null,
    createdAt: new Date(row.created_at).getTime() };
}

/**
 * Delete session.
 *
 * @param store - Database store handle.
 * @param tokenHashValue - SHA-256 hash of the session token.
 */
export async function deleteSession(store: Store, tokenHashValue: string): Promise<void> {
  await run(store, 'DELETE FROM sessions WHERE token_hash = $1', [tokenHashValue]);
}

/**
 * The gate the web UI has open in this session (null closes it).
 *
 * @param store - Database store handle.
 * @param tokenHashValue - SHA-256 hash of the session token.
 * @param phone - Gate system phone number (digits or formatted).
 */
export async function setSessionGate(store: Store, tokenHashValue: string, phone: string | null): Promise<void> {
  await run(store, 'UPDATE sessions SET gate = $2 WHERE token_hash = $1', [tokenHashValue, phone]);
}

/**
 * Deletes sessions idle longer than idleMs; returns the usernames whose sessions ended.
 *
 * @param store - Database store handle.
 * @param idleMs - Idle timeout in milliseconds.
 * @param [maxAgeMs] - Maximum session age in milliseconds.
 * @returns Promise resolving to `string[]`.
 */
export async function sweepSessions(store: Store, idleMs: number, maxAgeMs = Infinity): Promise<string[]> {
  const cutoff = new Date(Date.now() - idleMs).toISOString();
  const oldest = new Date(Number.isFinite(maxAgeMs) ? Date.now() - maxAgeMs : 0).toISOString();
  return (await all<{ username: string }>(store, 'DELETE FROM sessions WHERE last_seen < $1 OR created_at < $2 RETURNING username', [cutoff, oldest]))
    .map((row) => row.username);
}
