/**
 * @module web/auth
 *
 * Sign-in helpers: rate limits (rate-limiter-flexible), sessions, step-up and re-confirmation, passkey relying party,
 * single sign-on, cookies (@fastify/cookie) and allowed hosts.
 */
import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import * as dk from '../index.ts';
import type { Reply, Session } from './context.ts';
import type { ContextModule } from './context.ts';
import { logger } from '../src/logging.ts';

/**
 * Create auth.
 *
 * @param deps - Injected module dependencies.
 * @returns Operation result.
 */
export function createAuth(deps: ContextModule) {
  const { config, IDLE_MS, MAX_AGE_MS, MAX_FAILED_SIGN_INS, PORT, PUBLIC_HOST, SIGN_IN_WINDOW_MS, STEP_UP_MS, store } = deps;
  /** Rate limiters per point cap, window = SIGN_IN_WINDOW_MS (rate-limiter-flexible). */
  const windowSec = Math.max(1, Math.ceil(SIGN_IN_WINDOW_MS / 1000));
  const limiters = new Map<number, RateLimiterMemory>();
  const limiterFor = (points: number): RateLimiterMemory => {
    let limiter = limiters.get(points);
    if (!limiter) { limiter = new RateLimiterMemory({ points, duration: windowSec }); limiters.set(points, limiter); }
    return limiter;
  };
  const RESET_PER_ACCOUNT = 3;
  const PER_ADDRESS = 30;
  // Active `${user}|${ip}` keys per user with expiry, pruned on sweep and capped so memory stays bounded.
  const MAX_TRACKED_USERS = 1000;
  const userIpKeys = new Map<string, Map<string, number>>();
  function rememberUserIp(user: string, key: string): void {
    const expiresAt = Date.now() + SIGN_IN_WINDOW_MS;
    let entries = userIpKeys.get(user);
    if (!entries) {
      if (userIpKeys.size >= MAX_TRACKED_USERS) pruneUserIpKeys();
      if (userIpKeys.size >= MAX_TRACKED_USERS) userIpKeys.delete(userIpKeys.keys().next().value!);
      entries = new Map();
      userIpKeys.set(user, entries);
    }
    entries.set(key, expiresAt);
  }
  function pruneUserIpKeys(now = Date.now()): void {
    for (const [user, entries] of userIpKeys) {
      for (const [key, expiresAt] of entries) if (expiresAt <= now) entries.delete(key);
      if (!entries.size) userIpKeys.delete(user);
    }
  }

  /**
   * Records a request; true when the key already reached `limit` requests in the window (the request is refused).
   *
   * @param key - Rate-limit bucket key.
   * @param limit - Maximum requests allowed in the window.
   * @returns Promise resolving to `true` when the limit is exceeded.
   */
  async function overLimit(key: string, limit: number): Promise<boolean> {
    try { await limiterFor(limit).consume(key); return false; } catch { return true; }
  }
  const clientIp = (req: FastifyRequest): string => dk.clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.server.trustProxy);
  /**
   * While no account exists, creating the first one needs this code, printed only to the server's console (journalctl),
   * so a stranger reaching a fresh public install can't claim it first.
   */
  const setup = { code: '', running: false }; // the first-account setup code while no account exists; running: one being created
  /**
   * A new setup code (printed to the console by Application while no account exists).
   *
   * @returns `string` result.
   */
  function newSetupCode(): string {
    setup.code = crypto.randomBytes(5).toString('hex');
    return setup.code;
  }
  const setupCodeMatches = (given: unknown): boolean => {
    const code = Buffer.from(String(given || '').trim().toLowerCase());
    return Boolean(setup.code) && code.length === Buffer.byteLength(setup.code) && crypto.timingSafeEqual(code, Buffer.from(setup.code));
  };
  const endSetup = () => { setup.code = ''; };
  /**
   * Runs the first-account setup one request at a time (null: one is already running).
   *
   * @param fn - Callback function to execute.
   * @returns Promise resolving to `T | null`.
   */
  async function oneSetupAtATime<T>(fn: () => Promise<T>): Promise<T | null> {
    if (setup.running) return null;
    setup.running = true;
    try { return await fn(); } finally { setup.running = false; }
  }
  const approvals = new dk.PasskeyApprovals(); // codes from a signed-in device that let another device add a passkey
  /**
   * Failed sign-in limits (dk.signInKeys); "me:<user>" counts the signed-in user's own password checks (confirmOwnPassword).
   *
   * @param user - Local account username (or actor name for audit logs).
   * @param ip - Client IP address.
   * @returns Computed result.
   */
  const signInKeys = (user: string, ip: string) => dk.signInKeys(user, ip, MAX_FAILED_SIGN_INS);
  /** Safely refunds 1 consumed point without ever driving a cleared or expired bucket negative. */
  async function safeReward(key: string, limit: number): Promise<void> {
    const limiter = limiterFor(limit);
    const state = await limiter.get(key);
    if (state && state.consumedPoints > 0) await limiter.reward(key, 1).catch(() => {});
  }

  /**
   * Atomically checks and counts a password try before the password is verified, so concurrent tries can't burst past
   * the limit. Returns null when over limit (rolling back any earlier keys), else a function that refunds the try
   * when the password was right or the check errored.
   *
   * @param keys - Rate-limit keys and their point caps.
   * @returns Promise resolving to a refund callback, or `null` when rate-limited.
   */
  async function countTry(keys: [string, number][]): Promise<(() => Promise<void>) | null> {
    const consumed: [string, number][] = [];
    for (const [key, limit] of keys) {
      try {
        await limiterFor(limit).consume(key);
        consumed.push([key, limit]);
      } catch {
        await Promise.all(consumed.map(([consumedKey, consumedLimit]) => safeReward(consumedKey, consumedLimit)));
        return null;
      }
    }
    for (const [key] of consumed) {
      if (key.includes('|')) rememberUserIp(key.slice(0, key.indexOf('|')), key);
    }
    return async () => {
      await Promise.all(consumed.map(([consumedKey, consumedLimit]) => safeReward(consumedKey, consumedLimit)));
    };
  }
  /**
   * Forgets the failed sign-ins of a user name from one address (after a sign-in that worked there).
   *
   * @param user - Local account username.
   * @param ip - Client IP address.
   */
  async function clearFailedSignIn(user: string, ip: string): Promise<void> {
    const key = `${user}|${ip}`;
    await limiterFor(MAX_FAILED_SIGN_INS).delete(key);
    const entries = userIpKeys.get(user);
    entries?.delete(key);
    if (entries && !entries.size) userIpKeys.delete(user);
  }
  /**
   * Forgets an account's failed sign-ins across all addresses (after a password reset).
   *
   * @param user - Local account username.
   */
  async function clearFailures(user: string): Promise<void> {
    const ops: Promise<unknown>[] = [
      limiterFor(MAX_FAILED_SIGN_INS * dk.SIGN_IN_USER_FACTOR).delete(user),
      limiterFor(MAX_FAILED_SIGN_INS).delete(`me:${user}`),
    ];
    for (const key of userIpKeys.get(user)?.keys() || []) ops.push(limiterFor(MAX_FAILED_SIGN_INS).delete(key));
    userIpKeys.delete(user);
    await Promise.all(ops);
  }
  /** Ends idle sessions (they are kept in the database, so they survive a restart) and prunes expired rate-limit tracking. */
  async function sweepSessions() {
    try {
      for (const user of await dk.sweepSessions(store, IDLE_MS, MAX_AGE_MS)) logger('session').info`${user} signed out (idle or signed in too long ago)`;
    } catch (err) { logger('session').error`Session sweep failed: ${(err as Error).message}`; }
    pruneUserIpKeys();
    approvals.sweep();
  }
  const NATIVE_SESSION_PREFIX = 'dks_';
  const wantsBearerSession = (req: FastifyRequest): boolean =>
    String(req.headers['x-client-auth'] || '').trim().toLowerCase() === 'bearer';
  const sessionTokenFor = (req: FastifyRequest, tok: string): { sessionToken?: string } =>
    (wantsBearerSession(req) ? { sessionToken: `${NATIVE_SESSION_PREFIX}${tok}` } : {});

  async function sessionFromToken(sid: string | undefined): Promise<Session | null> {
    if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
    const found = await dk.findSession(store, sid, IDLE_MS, MAX_AGE_MS);
    if (!found) return null;
    const user = await dk.getUser(store, found.username);
    if (!user) return null;
    /** A linked provider that turns passwords off: the password can't be changed there, so it isn't asked for. */
    let mustChangePassword = user.mustChangePassword;
    if (mustChangePassword && await passwordOff(user.username)) {
      await dk.clearMustChangePassword(store, user.username);
      mustChangePassword = false;
    }
    return { tokenHash: found.tokenHash, user: user.username, gate: found.gate, mustChangePassword, strongAt: found.strongAt, signedInAt: found.createdAt };
  }
  async function currentSession(req: FastifyRequest): Promise<Session | null> {
    return sessionFromToken(req.cookies?.sid);
  }
  /**
   * Until when the session's passkey confirmation covers the sensitive actions (ms), or null.
   *
   * @param session - Authenticated user or API-key session.
   * @returns `number | null` result.
   */
  const strongUntil = (session: Session): number | null => (session.strongAt && session.strongAt + STEP_UP_MS > Date.now() ? session.strongAt + STEP_UP_MS : null);
  /**
   * The refusal of a sensitive action without a recent passkey confirmation (see STEP_UP).
   * extra: a sentence added to the error.
   *
   * @param session - Authenticated user or API-key session.
   * @param [extra] - A sentence added to the error.
   * @returns HTTP `[status, body]` reply tuple.
   */
  async function stepUpRefusal(session: Session, extra = ''): Promise<Reply> {
    const hasPasskey = (await dk.listPasskeys(store, session.user)).length > 0;
    return [403, { stepUp: true, hasPasskey, error: (hasPasskey
      ? 'Confirm it\'s you with your passkey to do this.'
      : 'This needs a passkey. Add one in User Settings (Passkeys), then try again.') + extra }];
  }
  /**
   * Re-confirming who it is before a sensitive account change (email, adding or removing a passkey), so a stolen session
   * alone isn't enough; dk.reauthNeeded decides how. Returns the refusal, or null.
   */
  const SIGN_IN_AGAIN = `For your security, sign out and sign in again, then make this change within ${STEP_UP_MS / 60000} minutes.`;
  const LOST_PASSKEY = ` Lost your passkey? Reset your password with the email link, sign in, and change your passkeys within ${STEP_UP_MS / 60000} minutes.`;
  async function reauthNeed(session: Session, change: dk.ReauthChange): Promise<dk.Reauth> {
    const user = (await dk.getUser(store, session.user))!;
    return dk.reauthNeeded({
      strong: Boolean(strongUntil(session)), hasPassword: user.hasPassword, passkeys: (await dk.listPasskeys(store, session.user)).length,
      signedInAt: session.signedInAt, resetAt: user.resetAt ? new Date(user.resetAt).getTime() : null, now: Date.now(), windowMs: STEP_UP_MS,
    }, change);
  }
  async function reauthRefusal(session: Session, change: dk.ReauthChange, given?: unknown): Promise<Reply | null> {
    const need = await reauthNeed(session, change);
    if (need === 'ok') return null;
    if (need === 'password') return confirmOwnPassword(session.user, given);
    if (need === 'step-up') return stepUpRefusal(session, change === 'email' ? '' : LOST_PASSKEY);
    return [403, { error: SIGN_IN_AGAIN }];
  }
  const meReply = (user: dk.User) => ({ username: user.username, email: user.email, pendingEmail: user.pendingEmail, phone: user.phone, dark: user.dark,
    notifyAccess: user.notifyAccess, notifyAlerts: user.notifyAlerts });
  /**
   * The site name passkeys are tied to for this request: the public name (over HTTPS), or localhost on the server
   * itself; null for any other host (such as 127.0.0.1, which WebAuthn doesn't accept).
   */
  const challenges = new dk.PasskeyChallenges(); // this server's passkey challenges
  const androidOrigins = config.android.sha256CertFingerprints.map((fp) => dk.androidApkKeyHashOrigin(fp));
  function relyingParty(req: FastifyRequest): dk.RelyingParty | null {
    const host = (req.headers.host || '').toLowerCase();
    if (PUBLIC_HOST && host === PUBLIC_HOST) {
      const webOrigin = `https://${PUBLIC_HOST}`;
      return { rpID: PUBLIC_HOST, origin: androidOrigins.length ? [webOrigin, ...androidOrigins] : webOrigin, challenges };
    }
    if (host === `localhost:${PORT}`) {
      const webOrigin = `http://localhost:${PORT}`;
      return { rpID: 'localhost', origin: androidOrigins.length ? [webOrigin, ...androidOrigins] : webOrigin, challenges };
    }
    return null;
  }
  /** Single sign-on providers (config.json sso.providers; src/sso.ts). */
  const SSO = config.sso.providers;
  const ssoFlows = new dk.SsoFlows(); // this server's sign-ins in progress
  const SSO_LIST = SSO.map((provider) => ({ id: provider.id, name: provider.name }));
  const providerOf = (id: unknown) => SSO.find((provider) => provider.id === id);
  /**
   * Where a provider sends the browser back: like passkeys, the public name over HTTPS, or localhost on the server.
   *
   * @param req - Incoming Fastify request.
   * @param provider - Configured OpenID Connect SSO provider.
   * @returns `string | null` result.
   */
  const ssoRedirect = (req: FastifyRequest, provider: dk.SsoProvider): string | null => {
    const rp = relyingParty(req);
    const webOrigin = rp ? (Array.isArray(rp.origin) ? rp.origin[0] : rp.origin) : null;
    return webOrigin ? `${webOrigin}/api/sso/${provider.id}/callback` : null;
  };
  const NO_SSO_SITE = `Single sign-on works only at ${PUBLIC_HOST ? `https://${PUBLIC_HOST}` : 'this site\'s public name'} or http://localhost:${PORT}`;
  const isPublic = (req: FastifyRequest) => Boolean(PUBLIC_HOST) && (req.headers.host || '').toLowerCase() === PUBLIC_HOST;
  /**
   * Cookie options for @fastify/cookie: session cookie is SameSite=Strict; SSO binding cookie is SameSite=Lax (cross-site callback).
   *
   * @param req - Incoming Fastify request.
   * @returns `CookieSerializeOptions` result.
   */
  const sessionCookieOpts = (req: FastifyRequest): CookieSerializeOptions => ({
    httpOnly: true, sameSite: 'strict', path: '/', secure: isPublic(req),
  });
  const ssoCookieOpts = (req: FastifyRequest, maxAge?: number): CookieSerializeOptions => ({
    httpOnly: true, sameSite: 'lax', path: '/api/sso', secure: isPublic(req), ...(maxAge !== undefined && { maxAge }),
  });
  /**
   * Confirms a sensitive change with the current password, checked like a sign-in (5 wrong tries pause it); accounts with
   * no password (single sign-on) aren't asked. Returns the refusal, or null.
   *
   * @param username - Local account username.
   * @param given - Unvalidated caller input.
   * @returns Promise resolving to `Reply | null`.
   * @throws Error when validation or the underlying operation fails.
   */
  async function confirmOwnPassword(username: string, given: unknown): Promise<Reply | null> {
    if (!(await dk.getUser(store, username))!.hasPassword) return null;
    const takeBack = await countTry([[`me:${username}`, MAX_FAILED_SIGN_INS]]);
    if (!takeBack) return [429, { error: `Too many wrong passwords. Try again in ${SIGN_IN_WINDOW_MS / 60000} minutes.` }];
    let right: boolean;
    try { right = await dk.checkOwnPassword(store, username, given); } catch (err) { await takeBack(); throw err; }
    if (!right) return [403, { error: 'Your password is wrong' }];
    await takeBack();
    return null;
  }
  /**
   * Why the account can't use a password (linked to a provider with passwords: false), or null.
   *
   * @param username - Local account username.
   * @returns Promise resolving to `string | null`.
   */
  async function passwordOff(username: string): Promise<string | null> {
    const by = await dk.passwordBlockers(store, username, SSO);
    return by.length ? `Your account signs in with ${by.join(' or ')}; password sign-in is turned off for it` : null;
  }
  const NO_PASSKEY_SITE = `Passkeys work only at ${PUBLIC_HOST ? `https://${PUBLIC_HOST}` : 'this site\'s public name'} or http://localhost:${PORT}`;
  const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])]);
  const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`,
    ...(PUBLIC_HOST ? [`https://${PUBLIC_HOST}`] : [])]);
  return { approvals, reauthNeed, RESET_PER_ACCOUNT, PER_ADDRESS, overLimit, clientIp, newSetupCode, setupCodeMatches, endSetup, oneSetupAtATime, clearFailedSignIn, signInKeys, countTry, clearFailures, sweepSessions, sessionFromToken, sessionTokenFor, NATIVE_SESSION_PREFIX, currentSession, strongUntil, stepUpRefusal, reauthRefusal, meReply, relyingParty, SSO, SSO_LIST, providerOf, ssoFlows, ssoRedirect, NO_SSO_SITE, sessionCookieOpts, ssoCookieOpts, confirmOwnPassword, passwordOff, NO_PASSKEY_SITE, ALLOWED_HOSTS, ALLOWED_ORIGINS };
}

export type AuthModule = ReturnType<typeof createAuth>;
