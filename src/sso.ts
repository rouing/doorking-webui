// Single sign-on with OpenID Connect providers (Entra ID, Google Workspace, Okta, …; config.json sso.providers). A
// provider identity (provider id + the provider's permanent subject) is linked to a local account (user_identities);
// the app keeps deciding what each account may do (gate roles). A sign-in attempt is kept in memory for 10 minutes and
// tied to the browser that started it (a cookie holds its binding); it uses state, nonce and PKCE, and openid-client
// checks the ID token (issuer, audience, expiry, nonce).
//
// Which account an identity signs in to: the one it is linked to; else, only for providers with allowedDomains and a
// trusted email from one of them (see trustedEmail), the invited account waiting on that email (the invitation is
// accepted), else the account with that confirmed email (linked), else a new account when autoCreate is on. Anyone
// else is told to ask a gate admin for an invitation. Linking from User Settings and accepting an invitation link
// with a provider work for any provider.
import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import type { SsoProvider } from './config.ts';
import { all, one, run, type Store } from './db.ts';
import { useToken } from './email.ts';
import { acceptInviteWithSso, createSsoUser, getUser, recordSignIn, userKey } from './users.ts';

export type SsoMode = 'signin' | 'link' | 'invite';
// email: '' when the provider gave none; emailVerified: null when it didn't say; hd: Google Workspace domain ('' none).
export interface SsoClaims { subject: string; email: string; emailVerified: boolean | null; name: string; hd: string }
export interface SsoResult { mode: SsoMode; username?: string; inviteToken?: string; identity: SsoClaims }
export interface SsoIdentity { provider: string; providerName: string; subject: string; email: string; linkedAt: string; lastUsedAt: string | null }
export type SsoOutcome = 'signed-in' | 'linked' | 'created' | 'invite-accepted';

const FLOW_MS = 10 * 60000;
const MAX_FLOWS = 500;
const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });

interface Flow { provider: string; nonce: string; verifier: string; binding: string; redirectUri: string; mode: SsoMode; username?: string; inviteToken?: string; at: number }
const flows = new Map<string, Flow>(); // by state
const configs = new Map<string, Promise<oidc.Configuration>>();

const isGoogle = (p: SsoProvider): boolean => new URL(p.issuer).hostname === 'accounts.google.com';

// The provider's OpenID configuration, discovered once (a failed discovery is tried again next time). Plain http is
// allowed for localhost issuers only (config.ts refuses others).
function configOf(p: SsoProvider): Promise<oidc.Configuration> {
  const key = `${p.id}|${p.issuer}|${p.clientId}|${p.clientSecret}`;
  let c = configs.get(key);
  if (!c) {
    const local = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(p.issuer);
    c = oidc.discovery(new URL(p.issuer), p.clientId, undefined, p.clientSecret ? oidc.ClientSecretPost(p.clientSecret) : oidc.None(),
      local ? { execute: [oidc.allowInsecureRequests] } : undefined);
    c.catch(() => configs.delete(key));
    configs.set(key, c);
  }
  return c;
}

// Checks that the provider can be reached and returns its endpoints (for the CLI's sso-check).
export async function discoverProvider(p: SsoProvider): Promise<{ issuer: string; authorization: string; token: string }> {
  const m = (await configOf(p)).serverMetadata();
  return { issuer: m.issuer, authorization: String(m.authorization_endpoint || ''), token: String(m.token_endpoint || '') };
}

// Starts a sign-in: returns the provider's URL to send the browser to, and the binding the browser must keep (a
// cookie) for the callback. redirectUri: <public address>/api/sso/<id>/callback, registered at the provider. mode:
// signin, link (username: the signed-in account) or invite (inviteToken: the invitation link's token).
export async function startSso(p: SsoProvider, { mode, redirectUri, username, inviteToken, now = Date.now() }:
  { mode: SsoMode; redirectUri: string; username?: string; inviteToken?: string; now?: number }): Promise<{ url: string; binding: string }> {
  const config = await configOf(p);
  for (const [k, f] of flows) if (now - f.at > FLOW_MS) flows.delete(k);
  if (flows.size >= MAX_FLOWS) throw bad('Too many sign-ins are in progress. Try again in a few minutes.', 429);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const binding = crypto.randomBytes(32).toString('base64url');
  const params: Record<string, string> = {
    redirect_uri: redirectUri, scope: 'openid email profile', state, nonce, prompt: 'select_account',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
  };
  if (isGoogle(p) && p.allowedDomains.length === 1) params.hd = p.allowedDomains[0];
  flows.set(state, { provider: p.id, nonce, verifier, binding, redirectUri, mode, username, inviteToken, at: now });
  return { url: oidc.buildAuthorizationUrl(config, params).href, binding };
}

const sameText = (a: string, b: string): boolean => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// The identity in checked ID token claims. The email is the email claim, else (Entra) preferred_username when it is
// an address.
export function claimsOf(c: Record<string, unknown>): SsoClaims {
  const address = (v: unknown) => (typeof v === 'string' && v.includes('@') ? v : '');
  const email = address(c.email) || address(c.preferred_username);
  const v = c.email_verified;
  return {
    subject: String(c.sub ?? ''), email: userKey(email),
    emailVerified: !address(c.email) || v === undefined ? null : v === true || v === 'true',
    name: typeof c.name === 'string' ? c.name : '', hd: typeof c.hd === 'string' ? c.hd.toLowerCase() : '',
  };
}

// Finishes a sign-in from the provider's answer (query: the callback's query string; binding: from the browser's
// cookie). The attempt must exist, be unexpired, belong to this provider and browser, and is used up either way; the
// code is exchanged with the PKCE verifier and the ID token checked against the nonce.
export async function finishSso(p: SsoProvider, query: URLSearchParams, binding: string, now = Date.now()): Promise<SsoResult> {
  const state = query.get('state') || '';
  const f = flows.get(state);
  if (f) flows.delete(state);
  const error = query.get('error');
  if (error) throw bad(`${p.name} didn't sign you in: ${(query.get('error_description') || error).slice(0, 200)}`);
  if (!f || f.provider !== p.id || now - f.at > FLOW_MS) throw bad('This sign-in has expired or was already used. Try again.');
  if (!binding || !sameText(binding, f.binding)) throw bad('This sign-in was started in another browser or tab. Try again.');
  const url = new URL(f.redirectUri);
  url.search = query.toString();
  const tokens = await oidc.authorizationCodeGrant(await configOf(p), url,
    { pkceCodeVerifier: f.verifier, expectedState: state, expectedNonce: f.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || !claims.sub) throw bad(`${p.name} didn't say who you are`);
  return { mode: f.mode, username: f.username, inviteToken: f.inviteToken, identity: claimsOf(claims as Record<string, unknown>) };
}

// The identity's email when it can be matched to accounts for this provider: not marked unverified and, when the
// provider has allowedDomains, from one of them (Google: also its Workspace domain, so a personal Google account made
// with a work address doesn't count). '' when it can't.
export function trustedEmail(p: SsoProvider, id: SsoClaims): string {
  if (!id.email || id.emailVerified === false) return '';
  if (!p.allowedDomains.length) return id.email;
  if (!p.allowedDomains.includes(id.email.split('@')[1])) return '';
  if (isGoogle(p) && !p.allowedDomains.includes(id.hd)) return '';
  return id.email;
}

// Why an identity's email can't be matched to accounts (trustedEmail gave ''), for the person signing in.
function untrustedReason(p: SsoProvider, id: SsoClaims): string {
  const ask = `Ask a gate admin to invite you, then accept the invitation with ${p.name}; or sign in another way and link it in User Settings.`;
  if (!id.email) return `${p.name} didn't give an email address, and this ${p.name} account isn't linked to an account here. ${ask}`;
  if (id.emailVerified === false) return `${p.name} says ${id.email} isn't verified, so it can't be matched to an account here. ${ask}`;
  if (!p.allowedDomains.includes(id.email.split('@')[1])) return `${id.email} can't sign in here: only accounts from ${p.allowedDomains.join(', ')} can.`;
  return `${id.email} isn't a ${p.allowedDomains.join(' or ')} Google Workspace account. Sign in with your Workspace account.`;
}

// The account an identity is linked to, or null.
async function linkedUser(store: Store, provider: string, subject: string): Promise<string | null> {
  const r = await one<{ username: string }>(store, 'SELECT username FROM user_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
  return r ? r.username : null;
}

// Links an identity to an account (409 when it belongs to another one).
async function link(store: Store, p: SsoProvider, username: string, id: SsoClaims): Promise<void> {
  const owner = await linkedUser(store, p.id, id.subject);
  if (owner && owner !== username) throw bad(`This ${p.name} account is already linked to another user`, 409);
  if (owner) return;
  await run(store, `INSERT INTO user_identities (provider, subject, username, email, linked_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (provider, subject) DO NOTHING`, [p.id, id.subject, userKey(username), id.email, new Date().toISOString()]);
  if (await linkedUser(store, p.id, id.subject) !== userKey(username)) throw bad(`This ${p.name} account is already linked to another user`, 409);
}

// What a finished sign-in means for the accounts (see the module comment). Sign-ins and accepted invitations are
// recorded as sign-ins. Returns the account and what happened; throws (403/409) with a message for the user.
export async function completeSso(store: Store, p: SsoProvider, r: SsoResult): Promise<{ username: string; outcome: SsoOutcome }> {
  const id = r.identity;
  const touch = (username: string) => run(store, 'UPDATE user_identities SET last_used_at = $3, email = $4 WHERE provider = $1 AND subject = $2',
    [p.id, id.subject, new Date().toISOString(), id.email || '']).then(() => recordSignIn(store, username));
  if (r.mode === 'link') {
    const name = userKey(r.username);
    if (!name || !await getUser(store, name)) throw bad('Sign in again, then link the account from User Settings', 401);
    if (p.allowedDomains.length && !trustedEmail(p, id)) throw bad(untrustedReason(p, id), 403);
    await link(store, p, name, id);
    return { username: name, outcome: 'linked' };
  }
  if (r.mode === 'invite') {
    const invalid = 'This invitation link is invalid, used or expired. Ask the gate admin to send a new one.';
    const t = await useToken(store, 'invite', r.inviteToken, { peek: true });
    if (!t) throw bad(invalid);
    const u = await getUser(store, t.username);
    if (!u || !u.invited) throw bad('This invitation was already used. Sign in instead.', 409);
    if (p.allowedDomains.length && !trustedEmail(p, id)) throw bad(untrustedReason(p, id), 403);
    if (await linkedUser(store, p.id, id.subject)) throw bad(`This ${p.name} account is already linked to another user`, 409);
    if (!await useToken(store, 'invite', r.inviteToken)) throw bad(invalid);
    await acceptInviteWithSso(store, u.username);
    await link(store, p, u.username, id);
    await touch(u.username);
    return { username: u.username, outcome: 'invite-accepted' };
  }
  const linked = await linkedUser(store, p.id, id.subject);
  if (linked) {
    await touch(linked);
    return { username: linked, outcome: 'signed-in' };
  }
  const email = trustedEmail(p, id);
  if (!email || !p.allowedDomains.length) {
    throw bad(!email ? untrustedReason(p, id) : `There is no account linked to this ${p.name} account. Ask a gate admin to invite you, then accept the invitation with ${p.name}; or sign in another way and link it in User Settings.`, 403);
  }
  const invited = await one<{ username: string }>(store, "SELECT username FROM users WHERE pending_email = $1 AND password_hash = '!'", [email]);
  if (invited) {
    await acceptInviteWithSso(store, invited.username);
    await link(store, p, invited.username, id);
    await touch(invited.username);
    return { username: invited.username, outcome: 'invite-accepted' };
  }
  const owner = await one<{ username: string }>(store, 'SELECT username FROM users WHERE email = $1', [email]);
  if (owner) {
    await link(store, p, owner.username, id);
    await touch(owner.username);
    return { username: owner.username, outcome: 'linked' };
  }
  if (p.autoCreate) {
    const u = await createSsoUser(store, { email, createdBy: `sso:${p.id}` });
    await link(store, p, u.username, id);
    await touch(u.username);
    return { username: u.username, outcome: 'created' };
  }
  throw bad(`There is no account for ${email} here. Ask a gate admin to invite you.`, 403);
}

// The account's linked identities (providerName: the configured name, or the id when the provider was removed).
export async function listIdentities(store: Store, username: unknown, providers: SsoProvider[]): Promise<SsoIdentity[]> {
  return (await all<{ provider: string; subject: string; email: string; linked_at: string; last_used_at: string | null }>(store,
    'SELECT provider, subject, email, linked_at, last_used_at FROM user_identities WHERE username = $1 ORDER BY linked_at', [userKey(username)]))
    .map((r) => ({ provider: r.provider, providerName: providers.find((p) => p.id === r.provider)?.name || r.provider, subject: r.subject,
      email: r.email, linkedAt: r.linked_at, lastUsedAt: r.last_used_at }));
}

// False when the account is linked to a provider set to passwords: false (it must sign in with that provider).
export async function passwordAllowed(store: Store, username: unknown, providers: SsoProvider[]): Promise<boolean> {
  const off = providers.filter((p) => !p.passwords).map((p) => p.id);
  if (!off.length) return true;
  return !await one(store, 'SELECT 1 AS x FROM user_identities WHERE username = $1 AND provider = ANY($2)', [userKey(username), off]);
}

// The providers that keep the account from using a password (their names), [] when none.
export async function passwordBlockers(store: Store, username: unknown, providers: SsoProvider[]): Promise<string[]> {
  const ids = new Set((await all<{ provider: string }>(store, 'SELECT provider FROM user_identities WHERE username = $1', [userKey(username)])).map((r) => r.provider));
  return providers.filter((p) => !p.passwords && ids.has(p.id)).map((p) => p.name);
}

// Unlinks one identity; refused (409) when the account would be left with no way to sign in: another identity of a
// configured provider, a passkey, or a usable password (one it has and may still use).
export async function unlinkIdentity(store: Store, username: unknown, provider: unknown, subject: unknown, providers: SsoProvider[]): Promise<void> {
  const name = userKey(username);
  const rest = (await all<{ provider: string; subject: string }>(store, 'SELECT provider, subject FROM user_identities WHERE username = $1', [name]));
  if (!rest.some((r) => r.provider === provider && r.subject === subject)) throw bad('That sign-in is not linked to your account', 404);
  const others = rest.filter((r) => !(r.provider === provider && r.subject === subject));
  const u = (await getUser(store, name))!;
  const passwordsOff = new Set(providers.filter((p) => !p.passwords).map((p) => p.id));
  const canPassword = u.hasPassword && !others.some((r) => passwordsOff.has(r.provider));
  const passkeys = await one(store, 'SELECT 1 AS x FROM passkeys WHERE username = $1', [name]);
  if (!canPassword && !passkeys && !others.some((r) => providers.some((p) => p.id === r.provider))) {
    throw bad('This is your only way to sign in. Add a passkey, set a password or link another account first.', 409);
  }
  await run(store, 'DELETE FROM user_identities WHERE username = $1 AND provider = $2 AND subject = $3', [name, provider, subject]);
}
