// Passkeys (WebAuthn) as another way to sign in, through @simplewebauthn/server. Table passkeys (see db.ts) keeps
// each credential's id, public key and signature counter; nothing in it is secret. Passkeys belong to the site name
// they were made on (the relying party id): the public HTTPS name, or "localhost" when the page is opened on the
// server itself. Challenges live in memory for 5 minutes and are used once.
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { all, one, run, type Store } from './db.ts';
import { userKey } from './users.ts';
import type { PasskeyInfo } from './types.ts';

export type { PasskeyInfo };
// rpID: the site name passkeys are tied to; origin: the page's origin (https://<name>, or http://localhost:<port>).
export interface RelyingParty { rpID: string; origin: string }

const RP_NAME = 'DoorKing Gate Manager';
const CHALLENGE_MS = 5 * 60000;
const MAX_CHALLENGES = 1000;
const NAME_MAX = 40;

interface PasskeyRow {
  id: string; username: string; rp_id: string; public_key: Buffer; counter: number; transports: string[] | null; name: string;
  device_type: string; backed_up: boolean; created_at: string; last_used_at: string | null;
}

const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const fromRow = (r: PasskeyRow): PasskeyInfo => ({
  id: r.id, name: r.name, site: r.rp_id, synced: r.device_type === 'multiDevice' && r.backed_up, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

// challenge -> { expires, username (registration), rpID }
const challenges = new Map<string, { expires: number; username: string | null; rpID: string }>();
function remember(challenge: string, username: string | null, rpID: string): void {
  const now = Date.now();
  for (const [c, v] of challenges) if (v.expires < now) challenges.delete(c);
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  challenges.set(challenge, { expires: now + CHALLENGE_MS, username, rpID });
}
// True (and forgets it) when the challenge was issued for this user (null: sign-in) and site, and hasn't expired.
function takeChallenge(challenge: string, username: string | null, rpID: string): boolean {
  const c = challenges.get(challenge);
  challenges.delete(challenge);
  return Boolean(c && c.expires >= Date.now() && c.username === username && c.rpID === rpID);
}

// The user's WebAuthn user handle (random, so the username isn't stored on the authenticator), created when missing.
async function userHandle(store: Store, username: string): Promise<Uint8Array> {
  const r = await one<{ webauthn_id: string | null }>(store, 'SELECT webauthn_id FROM users WHERE username = $1', [username]);
  if (!r) throw bad(`No user "${username}"`, 404);
  if (r.webauthn_id) return new Uint8Array(Buffer.from(r.webauthn_id, 'base64url'));
  const id = crypto.randomBytes(32);
  await run(store, 'UPDATE users SET webauthn_id = $2 WHERE username = $1 AND webauthn_id IS NULL', [username, id.toString('base64url')]);
  return userHandle(store, username);
}

export async function listPasskeys(store: Store, username: unknown): Promise<PasskeyInfo[]> {
  return (await all<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE username = $1 ORDER BY created_at',
    [userKey(username)])).map(fromRow);
}

// Options for adding a passkey to the user's account (the caller has checked their password).
export async function registrationOptions(store: Store, username: unknown, rp: RelyingParty) {
  const name = userKey(username);
  const existing = await all<{ id: string; transports: string[] | null }>(store, 'SELECT id, transports FROM passkeys WHERE username = $1 AND rp_id = $2',
    [name, rp.rpID]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: rp.rpID, userName: name, userID: await userHandle(store, name) as never, attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports || undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  remember(options.challenge, name, rp.rpID);
  return options;
}

// Checks the browser's answer to registrationOptions and saves the passkey under `label`.
export async function addPasskey(store: Store, username: unknown, response: unknown, label: unknown, rp: RelyingParty): Promise<PasskeyInfo> {
  const name = userKey(username);
  const title = String(label ?? '').trim() || 'Passkey';
  if (title.length > NAME_MAX) throw bad(`The passkey name must be at most ${NAME_MAX} characters`);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedChallenge: (c) => takeChallenge(c, name, rp.rpID),
      expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
    });
  } catch (e) { throw bad(`The passkey could not be added: ${(e as Error).message}`); }
  if (!v.verified) throw bad('The passkey could not be added');
  const { credential: cred, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const added = await run(store, `INSERT INTO passkeys (id, username, rp_id, public_key, counter, transports, name, device_type, backed_up, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
  [cred.id, name, rp.rpID, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports || []), title, credentialDeviceType,
    credentialBackedUp, new Date().toISOString()]);
  if (!added) throw bad('This passkey is already registered', 409);
  return fromRow((await one<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE id = $1', [cred.id]))!);
}

// Options for signing in with any passkey made for this site (discoverable passkeys: no username needed).
export async function authenticationOptions(rp: RelyingParty) {
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' });
  remember(options.challenge, null, rp.rpID);
  return options;
}

// Checks a passkey sign-in; returns the username. Throws 401 on anything wrong (unknown passkey, bad signature,
// expired challenge, counter gone backwards: a possible copy of the key).
export async function signInWithPasskey(store: Store, response: unknown, rp: RelyingParty): Promise<string> {
  const res = response as AuthenticationResponseJSON;
  const refused = (why: string) => bad(`Passkey sign-in failed: ${why}`, 401);
  const row = res && typeof res.id === 'string'
    ? await one<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE id = $1 AND rp_id = $2', [res.id, rp.rpID]) : undefined;
  if (!row) throw refused('this passkey is not registered here (it may have been removed)');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: res, expectedChallenge: (c) => takeChallenge(c, null, rp.rpID), expectedOrigin: rp.origin, expectedRPID: rp.rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports || undefined },
      requireUserVerification: true,
    });
  } catch (e) { throw refused((e as Error).message); }
  if (!v.verified) throw refused('the signature did not match');
  await run(store, 'UPDATE passkeys SET counter = $2, last_used_at = $3, backed_up = $4 WHERE id = $1',
    [row.id, v.authenticationInfo.newCounter, new Date().toISOString(), v.authenticationInfo.credentialBackedUp]);
  return row.username;
}

export async function renamePasskey(store: Store, username: unknown, id: unknown, label: unknown): Promise<void> {
  const title = String(label ?? '').trim();
  if (!title || title.length > NAME_MAX) throw bad(`Give the passkey a name of 1-${NAME_MAX} characters`);
  if (!await run(store, 'UPDATE passkeys SET name = $3 WHERE username = $1 AND id = $2', [userKey(username), String(id), title])) {
    throw bad('Passkey not found', 404);
  }
}

export async function removePasskey(store: Store, username: unknown, id: unknown): Promise<string> {
  const r = await one<{ name: string }>(store, 'DELETE FROM passkeys WHERE username = $1 AND id = $2 RETURNING name', [userKey(username), String(id)]);
  if (!r) throw bad('Passkey not found', 404);
  return r.name;
}
