/**
 * @module src/sso
 *
 * Single sign-on with OpenID Connect providers (Entra ID, Google Workspace, Okta, …; config.json sso.providers). A
 * provider identity (provider id + the provider's permanent subject) is linked to a local account (user_identities);
 * the app keeps deciding what each account may do (gate roles). A sign-in attempt is kept in memory for 10 minutes and
 * tied to the browser that started it (a cookie holds its binding); it uses state, nonce and PKCE, and openid-client
 * checks the ID token (issuer, audience, expiry, nonce).
 *
 * Session age: with maxAgeHours, the authentication at the provider (the ID token's auth_time) must be at most that
 * old; linking from User Settings always needs a fresh one (made after the attempt started). Providers are asked with
 * max_age; Entra with prompt=login for a fresh one (its max_age handling isn't dependable; its own limit is a
 * Conditional Access sign-in frequency). auth_time is checked here either way, and a missing one is refused.
 *
 * Which account an identity signs in to: the one it is linked to; else, only for providers with allowedDomains and a
 * trusted email from one of them (see trustedEmail), the invited account waiting on that email (the invitation is
 * accepted), else the account with that confirmed email (linked), else a new account when autoCreate is on. Anyone
 * else is told to ask a gate admin for an invitation. Linking from User Settings and accepting an invitation link
 * with a provider work for any provider.
 */
import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import type { SsoProvider } from './config.ts';
import { all, one, phoneDigits, run, transaction, type Store } from './db.ts';
import { peekToken, useToken } from './email.ts';
import { acceptInviteWithSso, createSsoUser, getUser, recordSignIn, userKey } from './users.ts';
import { isResidentOnlyUser } from './gate-list.ts';
import { httpError } from './errors.ts';
import type { GateRole } from './types.ts';

export type SsoMode = 'signin' | 'link' | 'invite';
/** Auth strength claims recorded from the verified ID token (`amr`, `acr`/`acrs`, `auth_time`). */
export interface SsoAuthClaims { amr: string[]; acr: string; authTime: number | null }
/**
 * email: '' when the provider gave none; emailVerified: null when it didn't say; hd: Google Workspace domain ('' none).
 */
export interface SsoClaims {
  subject: string; email: string; emailVerified: boolean | null; name: string; hd: string;
  auth: SsoAuthClaims;
  groups: string[];
}
export interface SsoResult {
  mode: SsoMode; username?: string; inviteToken?: string; identity: SsoClaims; strong: boolean;
  native?: boolean; nativeVerifierHash?: Buffer;
}
export interface SsoIdentity { provider: string; providerName: string; subject: string; email: string; linkedAt: string; lastUsedAt: string | null }
export type SsoOutcome = 'signed-in' | 'linked' | 'created' | 'invite-accepted';

const FLOW_MS = 10 * 60000;
const NATIVE_CODE_MS = 2 * 60000;
const SKEW_MS = 2 * 60000;
const MAX_FLOWS = 500;

const CONFIG_MS = 24 * 3600000; // a provider's discovered configuration is fetched again after this

interface Flow {
  provider: string; nonce: string; verifier: string; binding: string; redirectUri: string; mode: SsoMode;
  username?: string; inviteToken?: string; native?: boolean; nativeVerifierHash?: Buffer; at: number;
}
interface NativeExchange { username: string; strong: boolean; verifierHash: Buffer; at: number }

export interface ProviderDiscovery {
  issuer: string;
  authorization: string;
  token: string;
  authTime: boolean | null;
}

export interface StartSsoOptions {
  mode: SsoMode;
  redirectUri: string;
  username?: string;
  inviteToken?: string;
  native?: boolean;
  now?: number;
}

export interface StartSsoReply {
  url: string;
  binding: string;
  nativeVerifier?: string;
}

export interface IssueNativeSsoOptions {
  username: string;
  strong: boolean;
  verifierHash: Buffer;
  now?: number;
}

/**
 * Encapsulates in-flight OIDC sign-in states, native exchange codes, and cached provider discovery metadata.
 */
export class SsoFlows {
  private readonly flows = new Map<string, Flow>();
  private readonly nativeCodes = new Map<string, NativeExchange>();
  private readonly configs = new Map<string, { config: Promise<oidc.Configuration>; at: number }>();

  isNativeState(state: string | null | undefined): boolean {
    return Boolean(state && this.flows.get(state)?.native);
  }

  getConfig(provider: SsoProvider, now = Date.now()): Promise<oidc.Configuration> {
    const key = `${provider.id}|${provider.issuer}|${provider.clientId}|${provider.clientSecret}`;
    const cached = this.configs.get(key);
    if (cached && now - cached.at < CONFIG_MS) return cached.config;
    const local = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(provider.issuer);
    const config = oidc.discovery(
      new URL(provider.issuer),
      provider.clientId,
      undefined,
      provider.clientSecret ? oidc.ClientSecretPost(provider.clientSecret) : oidc.None(),
      local ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
    config.catch(() => { if (this.configs.get(key)?.config === config) this.configs.delete(key); });
    this.configs.set(key, { config, at: now });
    return config;
  }

  putFlow(state: string, flow: Flow, now = Date.now()): void {
    for (const [k, existing] of this.flows) if (now - existing.at > FLOW_MS) this.flows.delete(k);
    if (this.flows.size >= MAX_FLOWS) throw httpError('Too many sign-ins are in progress. Try again in a few minutes.', 429);
    this.flows.set(state, flow);
  }

  takeFlow(state: string): Flow | undefined {
    const flow = this.flows.get(state);
    if (flow) this.flows.delete(state);
    return flow;
  }

  issueNativeCode({ username, strong, verifierHash, now = Date.now() }: IssueNativeSsoOptions): string {
    for (const [k, entry] of this.nativeCodes) if (now - entry.at > NATIVE_CODE_MS) this.nativeCodes.delete(k);
    while (this.nativeCodes.size >= MAX_FLOWS) this.nativeCodes.delete(this.nativeCodes.keys().next().value!);
    const code = crypto.randomBytes(32).toString('base64url');
    this.nativeCodes.set(code, { username, strong, verifierHash, at: now });
    return code;
  }

  consumeNativeCode(code: unknown, verifier: unknown, now = Date.now()): { username: string; strong: boolean } {
    const key = String(code || '').trim();
    const rawVerifier = String(verifier || '').trim();
    const entry = this.nativeCodes.get(key);
    if (entry) this.nativeCodes.delete(key);
    if (!entry || now - entry.at > NATIVE_CODE_MS || !rawVerifier) {
      throw httpError('This sign-in code has expired or was already used. Try signing in again.', 401);
    }
    const givenHash = crypto.createHash('sha256').update(rawVerifier).digest();
    if (givenHash.length !== entry.verifierHash.length || !crypto.timingSafeEqual(givenHash, entry.verifierHash)) {
      throw httpError('Sign-in verification failed. Try signing in again.', 401);
    }
    return { username: entry.username, strong: entry.strong };
  }
}

const isGoogle = (provider: SsoProvider): boolean => new URL(provider.issuer).hostname === 'accounts.google.com';
const isEntra = (provider: SsoProvider): boolean => new URL(provider.issuer).hostname === 'login.microsoftonline.com';

function freshSignIn(provider: SsoProvider, mode: SsoMode): Record<string, string> {
  if (mode === 'link') return isEntra(provider) ? { prompt: 'login' } : { max_age: '0' };
  if (provider.maxAgeHours && !isEntra(provider)) return { max_age: String(provider.maxAgeHours * 3600) };
  return {};
}

export async function discoverProvider(sso: SsoFlows, provider: SsoProvider): Promise<ProviderDiscovery> {
  const metadata = (await sso.getConfig(provider)).serverMetadata();
  const claims = Array.isArray(metadata.claims_supported) ? metadata.claims_supported : null;
  return {
    issuer: metadata.issuer,
    authorization: String(metadata.authorization_endpoint || ''),
    token: String(metadata.token_endpoint || ''),
    authTime: claims ? claims.includes('auth_time') : null,
  };
}

export async function startSso(
  sso: SsoFlows,
  provider: SsoProvider,
  { mode, redirectUri, username, inviteToken, native = false, now = Date.now() }: StartSsoOptions,
): Promise<StartSsoReply> {
  const config = await sso.getConfig(provider, now);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const binding = crypto.randomBytes(32).toString('base64url');
  const nativeVerifier = native ? crypto.randomBytes(32).toString('base64url') : undefined;
  const nativeVerifierHash = nativeVerifier ? crypto.createHash('sha256').update(nativeVerifier).digest() : undefined;
  const params: Record<string, string> = {
    redirect_uri: redirectUri, scope: 'openid email profile', state, nonce, prompt: 'select_account',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  };
  if (isGoogle(provider) && provider.allowedDomains.length === 1) params.hd = provider.allowedDomains[0];
  Object.assign(params, freshSignIn(provider, mode));
  sso.putFlow(state, { provider: provider.id, nonce, verifier, binding, redirectUri, mode, username, inviteToken, native, nativeVerifierHash, at: now }, now);
  return { url: oidc.buildAuthorizationUrl(config, params).href, binding, ...(nativeVerifier && { nativeVerifier }) };
}

export function issueNativeSsoCode(sso: SsoFlows, opts: IssueNativeSsoOptions): string {
  return sso.issueNativeCode(opts);
}

export function consumeNativeSsoCode(sso: SsoFlows, code: unknown, verifier: unknown, now = Date.now()): { username: string; strong: boolean } {
  return sso.consumeNativeCode(code, verifier, now);
}

const sameText = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const STRONG_AMR = new Set(['mfa', 'hwk', 'fido', 'otp', 'swk', 'rsa', 'pop', 'sms', 'tel', 'bio', 'fpt', 'eye', 'face']);

/**
 * Extracts verified identity, MFA/auth-strength claims (`amr`, `acr`/`acrs`, `auth_time`), and optional group/role claims.
 *
 * @param claims - Verified ID token claims.
 * @param [groupClaim] - Claim name containing group/role values (default `'groups'`).
 * @returns Normalized `SsoClaims`.
 */
export function claimsOf(claims: Record<string, unknown>, groupClaim = 'groups'): SsoClaims {
  const address = (value: unknown) => (typeof value === 'string' && value.includes('@') ? value : '');
  const email = address(claims.email) || address(claims.preferred_username);
  const verified = claims.email_verified;
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase()) : [];
  const acr = typeof claims.acr === 'string' ? claims.acr
    : Array.isArray(claims.acrs) ? claims.acrs.filter((item): item is string => typeof item === 'string').join(' ') : '';
  const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : null;
  const rawGroups = claims[groupClaim];
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((item): item is string => typeof item === 'string')
    : typeof rawGroups === 'string' ? [rawGroups] : [];
  return {
    subject: String(claims.sub ?? ''), email: userKey(email),
    emailVerified: !address(claims.email) || verified === undefined ? null : verified === true || verified === 'true',
    name: typeof claims.name === 'string' ? claims.name : '', hd: typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '',
    auth: { amr, acr, authTime },
    groups,
  };
}

/**
 * True when an SSO sign-in proves recent MFA/phishing-resistant authentication (`auth_time` within `windowMs`, plus
 * strong `amr` or a configured `strongAcrs` match), so the session may count toward step-up.
 *
 * @param provider - Configured SSO provider.
 * @param auth - Verified `amr`, `acr`, and `authTime` claims.
 * @param [now] - Current time in milliseconds.
 * @param [windowMs] - Step-up validity window in milliseconds (default 3 hours).
 * @returns True when the SSO sign-in counts as strong authentication.
 */
export function isStrongSso(provider: SsoProvider, auth: SsoAuthClaims, now = Date.now(), windowMs = 180 * 60000): boolean {
  if (auth.authTime === null) return false;
  if (auth.authTime * 1000 < now - windowMs - SKEW_MS) return false;
  if (auth.amr.some((method) => STRONG_AMR.has(method))) return true;
  if (auth.amr.length >= 2) return true;
  if (provider.strongAcrs?.length && auth.acr) {
    const tokens = auth.acr.split(/\s+/);
    if (provider.strongAcrs.some((wanted) => tokens.includes(wanted))) return true;
  }
  return false;
}

/**
 * Checks the session age (see the top): link needs an authentication made after the attempt started; otherwise
 * maxAgeHours, when set, bounds it. A small clock skew is allowed.
 *
 * @param provider - Configured OpenID Connect SSO provider.
 * @param authTime - `unknown` value.
 * @param flow - `Flow` value.
 * @param now - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @throws HTTP 400 error on invalid input or conflict.
 */
function checkAuthTime(provider: SsoProvider, authTime: unknown, flow: Flow, now: number): void {
  if (flow.mode !== 'link' && !provider.maxAgeHours) return;
  if (typeof authTime !== 'number') {
    throw httpError(`${provider.name} didn't say when you signed in (auth_time), which this server requires.${isEntra(provider)
      ? ' An administrator must add the auth_time optional claim to the ID token in the Entra app registration.' : ''}`);
  }
  const ms = authTime * 1000;
  if (flow.mode === 'link' && ms < flow.at - SKEW_MS) throw httpError(`Sign in to ${provider.name} again to link it: linking needs a fresh sign-in. Try again.`);
  if (flow.mode !== 'link' && ms < now - provider.maxAgeHours * 3600000 - SKEW_MS) {
    throw httpError(`Your ${provider.name} sign-in is more than ${provider.maxAgeHours} hours old. Sign out of ${provider.name}, then sign in again.`);
  }
}

/**
 * Finishes a sign-in from the provider's answer (query: the callback's query string; binding: from the browser's
 * cookie). The attempt must exist, be unexpired, belong to this provider and browser, and is used up either way; the
 * code is exchanged with the PKCE verifier and the ID token checked against the nonce.
 *
 * @param sso - Per-server SSO flow and discovery cache.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param query - The callback's query string.
 * @param binding - From the browser's cookie.
 * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Promise resolving to `SsoResult`.
 * @throws HTTP 200/400 error on invalid input or conflict.
 */
export async function finishSso(sso: SsoFlows, provider: SsoProvider, query: URLSearchParams, binding: string, now = Date.now()): Promise<SsoResult> {
  const state = query.get('state') || '';
  const flow = sso.takeFlow(state);
  const error = query.get('error');
  if (error) throw httpError(`${provider.name} didn't sign you in: ${(query.get('error_description') || error).slice(0, 200)}`);
  if (!flow || flow.provider !== provider.id || now - flow.at > FLOW_MS) throw httpError('This sign-in has expired or was already used. Try again.');
  if (!flow.native && (!binding || !sameText(binding, flow.binding))) throw httpError('This sign-in was started in another browser or tab. Try again.');
  const url = new URL(flow.redirectUri);
  url.search = query.toString();
  const tokens = await oidc.authorizationCodeGrant(await sso.getConfig(provider, now), url,
    { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || !claims.sub) throw httpError(`${provider.name} didn't say who you are`);
  checkAuthTime(provider, claims.auth_time, flow, now);
  const identity = claimsOf(claims as Record<string, unknown>, provider.roleMap?.claim || 'groups');
  const strong = isStrongSso(provider, identity.auth, now);
  return {
    mode: flow.mode, username: flow.username, inviteToken: flow.inviteToken, identity, strong,
    ...(flow.native && { native: true, nativeVerifierHash: flow.nativeVerifierHash }),
  };
}

/**
 * The identity's email when it can be matched to accounts for this provider: not marked unverified and, when the
 * provider has allowedDomains, from one of them (Google: also its Workspace domain, so a personal Google account made
 * with a work address doesn't count). '' when it can't.
 *
 * @param provider - Configured OpenID Connect SSO provider.
 * @param id - Unique record identifier.
 * @returns `string` result.
 */
export function trustedEmail(provider: SsoProvider, id: SsoClaims): string {
  if (!id.email || id.emailVerified === false) return '';
  if (!provider.allowedDomains.length) return id.email;
  if (!provider.allowedDomains.includes(id.email.split('@')[1])) return '';
  if (isGoogle(provider) && !provider.allowedDomains.includes(id.hd)) return '';
  return id.email;
}

/**
 * Why an identity's email can't be matched to accounts (trustedEmail gave ''), for the person signing in.
 *
 * @param provider - Configured OpenID Connect SSO provider.
 * @param id - Unique record identifier.
 * @returns `string` result.
 */
function untrustedReason(provider: SsoProvider, id: SsoClaims): string {
  const ask = `Ask a gate admin to invite you, then accept the invitation with ${provider.name}; or sign in another way and link it in User Settings.`;
  if (!id.email) return `${provider.name} didn't give an email address, and this ${provider.name} account isn't linked to an account here. ${ask}`;
  if (id.emailVerified === false) return `${provider.name} says ${id.email} isn't verified, so it can't be matched to an account here. ${ask}`;
  if (!provider.allowedDomains.includes(id.email.split('@')[1])) return `${id.email} can't sign in here: only accounts from ${provider.allowedDomains.join(', ')} can.`;
  return `${id.email} isn't a ${provider.allowedDomains.join(' or ')} Google Workspace account. Sign in with your Workspace account.`;
}

/**
 * The account an identity is linked to, or null.
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param subject - Provider subject identifier (`sub` claim).
 * @returns Promise resolving to `string | null`.
 */
async function linkedUser(store: Store, provider: string, subject: string): Promise<string | null> {
  const row = await one<{ username: string }>(store, 'SELECT username FROM user_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
  return row ? row.username : null;
}

/**
 * Links an identity to an account (409 when it belongs to another one).
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param username - Local account username.
 * @param id - Unique record identifier.
 * @throws HTTP 409 error on invalid input or conflict.
 */
async function link(store: Store, provider: SsoProvider, username: string, id: SsoClaims): Promise<void> {
  const owner = await linkedUser(store, provider.id, id.subject);
  if (owner && owner !== username) throw httpError(`This ${provider.name} account is already linked to another user`, 409);
  if (owner) return;
  await run(store, `INSERT INTO user_identities (provider, subject, username, email, linked_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (provider, subject) DO NOTHING`, [provider.id, id.subject, userKey(username), id.email, new Date().toISOString()]);
  if (await linkedUser(store, provider.id, id.subject) !== userKey(username)) throw httpError(`This ${provider.name} account is already linked to another user`, 409);
}

const checkTrusted = (provider: SsoProvider, id: SsoClaims): void => {
  if (provider.allowedDomains.length && !trustedEmail(provider, id)) throw httpError(untrustedReason(provider, id), 403);
};

async function assertStaffSsoAllowed(store: Store, username: string, message: string): Promise<void> {
  if (await isResidentOnlyUser(store, username)) throw httpError(message, 403);
}

async function completeLink(store: Store, provider: SsoProvider, result: SsoResult): Promise<{ username: string; outcome: SsoOutcome }> {
  const name = userKey(result.username);
  if (!name || !await getUser(store, name)) throw httpError('Sign in again, then link the account from User Settings', 401);
  await assertStaffSsoAllowed(store, name, 'Single sign-on is not available for Resident Portal accounts. Use your password or a passkey instead.');
  checkTrusted(provider, result.identity);
  await link(store, provider, name, result.identity);
  return { username: name, outcome: 'linked' };
}

async function completeInvite(store: Store, provider: SsoProvider, result: SsoResult, touch: (username: string) => Promise<unknown>):
  Promise<{ username: string; outcome: SsoOutcome }> {
  const id = result.identity;
  const invalid = 'This invitation link is invalid, used or expired. Ask the gate admin to send a new one.';
  const token = await peekToken(store, 'invite', result.inviteToken);
  if (!token) throw httpError(invalid);
  const user = await getUser(store, token.username);
  if (!user || !user.invited) throw httpError('This invitation was already used. Sign in instead.', 409);
  await assertStaffSsoAllowed(store, user.username, 'Single sign-on is not available for Resident Portal invitations. Set a password using the invitation link instead.');
  checkTrusted(provider, id);
  if (await linkedUser(store, provider.id, id.subject)) throw httpError(`This ${provider.name} account is already linked to another user`, 409);
  await transaction(store, async (tx) => {
    if (!await useToken(tx, 'invite', result.inviteToken)) throw httpError(invalid);
    await acceptInviteWithSso(tx, user.username);
    await link(tx, provider, user.username, id);
  });
  await touch(user.username);
  return { username: user.username, outcome: 'invite-accepted' };
}

/**
 * What a finished sign-in means for the accounts (see the module comment). Sign-ins and accepted invitations are
 * recorded as sign-ins. Returns the account and what happened; throws (403/409) with a message for the user.
 *
 * @param store - Database store handle.
 * @param provider - Configured OpenID Connect SSO provider.
 * @param result - Verified operation result.
 * @returns Promise resolving to `{ username: string; outcome: SsoOutcome }`.
 * @throws HTTP 400/403 error on invalid input or conflict.
 */
const ROLE_RANK: Record<GateRole, number> = { resident: 0, readonly: 1, editor: 2, admin: 3 };

/**
 * Applies `provider.roleMap` to grant or upgrade `gate_access` roles based on the user's verified SSO groups/roles.
 * Never removes existing access or the last admin of a gate.
 *
 * @param store - Database store handle.
 * @param provider - Configured SSO provider.
 * @param username - Local account username.
 * @param groups - Group/role values from the verified ID token.
 */
export async function syncSsoGateRoles(store: Store, provider: SsoProvider, username: string, groups: string[]): Promise<void> {
  if (!provider.roleMap || !groups.length) return;
  const desired = new Map<string, GateRole>();
  const allGates = (await all<{ phone: string }>(store, 'SELECT phone FROM managed_gates')).map((row) => row.phone);
  const gateSet = new Set(allGates);
  for (const group of groups) {
    const rules = provider.roleMap.map[group];
    if (!rules) continue;
    for (const [target, role] of Object.entries(rules)) {
      const phones = target === '*' ? allGates : [phoneDigits(target)].filter((p) => gateSet.has(p));
      for (const phone of phones) {
        const prev = desired.get(phone);
        if (!prev || ROLE_RANK[role] > ROLE_RANK[prev]) desired.set(phone, role);
      }
    }
  }
  if (!desired.size) return;
  const name = userKey(username);
  const now = new Date().toISOString();
  for (const [phone, role] of desired) {
    const existing = await one<{ role: GateRole }>(store, 'SELECT role FROM gate_access WHERE phone = $1 AND username = $2', [phone, name]);
    if (!existing) {
      await run(store, 'INSERT INTO gate_access (phone, username, role, granted_by, granted_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [phone, name, role, `sso:${provider.id}`, now]);
    } else if (ROLE_RANK[role] > ROLE_RANK[existing.role]) {
      await run(store, 'UPDATE gate_access SET role = $3 WHERE phone = $1 AND username = $2', [phone, name, role]);
    }
  }
}

export async function completeSso(store: Store, provider: SsoProvider, result: SsoResult): Promise<{ username: string; outcome: SsoOutcome }> {
  const id = result.identity;
  const touch = async (username: string) => {
    await run(store, 'UPDATE user_identities SET last_used_at = $3, email = $4, last_claims = $5 WHERE provider = $1 AND subject = $2',
      [provider.id, id.subject, new Date().toISOString(), id.email || '', JSON.stringify(id.auth)]);
    await syncSsoGateRoles(store, provider, username, id.groups);
    await recordSignIn(store, username);
  };
  if (result.mode === 'link') return completeLink(store, provider, result);
  if (result.mode === 'invite') return completeInvite(store, provider, result, touch);
  const linked = await linkedUser(store, provider.id, id.subject);
  if (linked) {
    await assertStaffSsoAllowed(store, linked, 'Single sign-on is not available for Resident Portal accounts. Sign in with your email and password or passkey.');
    await touch(linked);
    return { username: linked, outcome: 'signed-in' };
  }
  const email = trustedEmail(provider, id);
  if (!email || !provider.allowedDomains.length) {
    throw httpError(!email ? untrustedReason(provider, id) : `There is no account linked to this ${provider.name} account. Ask a gate admin to invite you, then accept the invitation with ${provider.name}; or sign in another way and link it in User Settings.`, 403);
  }
  const invited = await one<{ username: string }>(store, "SELECT username FROM users WHERE pending_email = $1 AND password_hash = '!'", [email]);
  if (invited) {
    await assertStaffSsoAllowed(store, invited.username, 'Single sign-on is not available for Resident Portal invitations. Use the invitation link to set your password.');
    await transaction(store, async (tx) => {
      await acceptInviteWithSso(tx, invited.username);
      await link(tx, provider, invited.username, id);
    });
    await touch(invited.username);
    return { username: invited.username, outcome: 'invite-accepted' };
  }
  const owner = await one<{ username: string }>(store, 'SELECT username FROM users WHERE email = $1', [email]);
  if (owner) {
    await assertStaffSsoAllowed(store, owner.username, 'Single sign-on is not available for Resident Portal accounts. Sign in with your email and password or passkey.');
    await link(store, provider, owner.username, id);
    await touch(owner.username);
    return { username: owner.username, outcome: 'linked' };
  }
  if (provider.autoCreate) {
    const user = await transaction(store, async (tx) => {
      const created = await createSsoUser(tx, { email, createdBy: `sso:${provider.id}` });
      await link(tx, provider, created.username, id);
      return created;
    });
    await touch(user.username);
    return { username: user.username, outcome: 'created' };
  }
  throw httpError(`There is no account for ${email} here. Ask a gate admin to invite you.`, 403);
}

/**
 * The account's linked identities (providerName: the configured name, or the id when the provider was removed).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param providers - List of configured OpenID Connect SSO providers.
 * @returns Promise resolving to `SsoIdentity[]`.
 */
export async function listIdentities(store: Store, username: string, providers: SsoProvider[]): Promise<SsoIdentity[]> {
  return (await all<{ provider: string; subject: string; email: string; linked_at: string; last_used_at: string | null }>(store,
    'SELECT provider, subject, email, linked_at, last_used_at FROM user_identities WHERE username = $1 ORDER BY linked_at', [userKey(username)]))
    .map((row) => ({ provider: row.provider, providerName: providers.find((provider) => provider.id === row.provider)?.name || row.provider, subject: row.subject,
      email: row.email, linkedAt: row.linked_at, lastUsedAt: row.last_used_at }));
}

/**
 * False when the account is linked to a provider set to passwords: false (it must sign in with that provider).
 * Whether the account keeps a way to sign in once passkey `passkeyId` is removed: another passkey, a linked provider
 * that is configured, or a password (a provider that turns passwords off is linked, so that counts already).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param passkeyId - `string` value.
 * @param providers - List of configured OpenID Connect SSO providers.
 * @returns Promise resolving to `true` when the condition holds.
 */
export async function signInLeftWithoutPasskey(store: Store, username: string, passkeyId: string, providers: SsoProvider[]): Promise<boolean> {
  const name = userKey(username);
  if (await one(store, 'SELECT 1 AS x FROM passkeys WHERE username = $1 AND id <> $2', [name, String(passkeyId)])) return true;
  const linked = await all<{ provider: string }>(store, 'SELECT provider FROM user_identities WHERE username = $1', [name]);
  if (linked.some((row) => providers.some((provider) => provider.id === row.provider))) return true;
  return Boolean((await getUser(store, name))?.hasPassword);
}

/**
 * The providers that keep the account from using a password (their names), [] when none.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param providers - List of configured OpenID Connect SSO providers.
 * @returns Promise resolving to `string[]`.
 */
export async function passwordBlockers(store: Store, username: string, providers: SsoProvider[]): Promise<string[]> {
  const ids = new Set((await all<{ provider: string }>(store, 'SELECT provider FROM user_identities WHERE username = $1', [userKey(username)])).map((row) => row.provider));
  return providers.filter((provider) => !provider.passwords && ids.has(provider.id)).map((provider) => provider.name);
}

/**
 * Unlinks one identity; refused (409) when the account would be left with no way to sign in: another identity of a
 * configured provider, a passkey, or a usable password (one it has and may still use).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param options - Options object.
 * @param options.provider - Configured OpenID Connect SSO provider.
 * @param options.subject - Provider subject identifier (`sub` claim).
 * @param providers - List of configured OpenID Connect SSO providers.
 * @throws HTTP 400/404 error on invalid input or conflict.
 */
export async function unlinkIdentity(store: Store, username: string, { provider, subject }: { provider: unknown; subject: unknown }, providers: SsoProvider[]): Promise<void> {
  const name = userKey(username);
  const rest = (await all<{ provider: string; subject: string }>(store, 'SELECT provider, subject FROM user_identities WHERE username = $1', [name]));
  if (!rest.some((row) => row.provider === provider && row.subject === subject)) throw httpError('That sign-in is not linked to your account', 404);
  const others = rest.filter((row) => !(row.provider === provider && row.subject === subject));
  const user = (await getUser(store, name))!;
  const passwordsOff = new Set(providers.filter((configured) => !configured.passwords).map((configured) => configured.id));
  const canPassword = user.hasPassword && !others.some((other) => passwordsOff.has(other.provider));
  const passkeys = await one(store, 'SELECT 1 AS x FROM passkeys WHERE username = $1', [name]);
  if (!canPassword && !passkeys && !others.some((other) => providers.some((configured) => configured.id === other.provider))) {
    throw httpError('This is your only way to sign in. Add a passkey, set a password or link another account first.', 409);
  }
  await run(store, 'DELETE FROM user_identities WHERE username = $1 AND provider = $2 AND subject = $3', [name, provider, subject]);
}
