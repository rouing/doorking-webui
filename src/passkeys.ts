/**
 * @module src/passkeys
 *
 * Passkeys (WebAuthn) as another way to sign in, through @simplewebauthn/server. Table passkeys (see db.ts) keeps
 * each credential's id, public key and signature counter; nothing in it is secret. Passkeys belong to the site name
 * they were made on (the relying party id): the public HTTPS name, or "localhost" when the page is opened on the
 * server itself. Challenges live in memory for 5 minutes and are used once.
 */
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { all, one, run, type Store } from './db.ts';
import { userKey } from './users.ts';
import type { PasskeyInfo } from './types.ts';
import { httpError, UnknownPasskeyError } from './errors.ts';

export type { PasskeyInfo };
/**
 * rpID: the site name passkeys are tied to; origin: the allowed WebAuthn origin(s) (`https://<name>`,
 * `http://localhost:<port>`, and optional `android:apk-key-hash:<base64url>` for native Android apps);
 * challenges: where the challenges handed out are kept until answered.
 */
export interface RelyingParty { rpID: string; origin: string | string[]; challenges: PasskeyChallenges }

/**
 * Converts a colon-separated SHA-256 signing-certificate fingerprint (`AA:BB:...`) into the WebAuthn Android origin
 * format (`android:apk-key-hash:<base64url>`) verified by `@simplewebauthn/server`.
 *
 * @param sha256Fingerprint - Colon-separated 32-byte hex SHA-256 certificate fingerprint.
 * @returns Android APK key-hash WebAuthn origin string.
 */
export function androidApkKeyHashOrigin(sha256Fingerprint: string): string {
  const hex = sha256Fingerprint.replace(/:/g, '').trim();
  return `android:apk-key-hash:${Buffer.from(hex, 'hex').toString('base64url')}`;
}

const RP_NAME = 'DoorKing Gate Manager';
const CHALLENGE_MS = 5 * 60000;
const MAX_CHALLENGES = 1000;
const NAME_MAX = 40;

interface PasskeyRow {
  id: string; username: string; rp_id: string; public_key: Buffer; counter: number; transports: string[] | null; name: string;
  device_type: string; backed_up: boolean; created_at: string; last_used_at: string | null;
}

const fromRow = (row: PasskeyRow): PasskeyInfo => ({
  id: row.id, name: row.name, site: row.rp_id, synced: row.device_type === 'multiDevice' && row.backed_up, createdAt: row.created_at, lastUsedAt: row.last_used_at,
});

type Purpose = 'register' | 'register-auto' | 'signin' | 'confirm';
interface Challenge { expires: number; purpose: Purpose; username: string | null; rpID: string }

/** The challenges handed out and not yet answered (each server keeps its own: RelyingParty.challenges). */
export class PasskeyChallenges {
  private readonly pending = new Map<string, Challenge>(); // challenge -> who and what it is for (username null: sign-in)

  /**
   * Remember.
   *
   * @param challenge - Base64url WebAuthn challenge string.
   * @param purpose - Challenge purpose (`register`, `register-auto`, `signin`, or `confirm`).
   * @param username - Local account username.
   * @param rpID - `string` value.
   * @param [now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
   */
  remember(challenge: string, purpose: Purpose, username: string | null, rpID: string, now = Date.now()): void {
    for (const [old, stored] of this.pending) if (stored.expires < now) this.pending.delete(old);
    while (this.pending.size >= MAX_CHALLENGES) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(challenge, { expires: now + CHALLENGE_MS, purpose, username, rpID });
  }

  /**
   * True (and forgets it) when the challenge was issued for this purpose, user and site, and hasn't expired.
   *
   * @param challenge - Base64url WebAuthn challenge string.
   * @param purpose - Challenge purpose (`register`, `register-auto`, `signin`, or `confirm`).
   * @param username - Local account username.
   * @param rpID - `string` value.
   * @returns True when the condition holds.
   */
  take(challenge: string, purpose: Purpose, username: string | null, rpID: string): boolean {
    const stored = this.pending.get(challenge);
    this.pending.delete(challenge);
    return Boolean(stored && stored.expires >= Date.now() && stored.purpose === purpose && stored.username === username && stored.rpID === rpID);
  }
}
async function userHandle(store: Store, username: string): Promise<Uint8Array<ArrayBuffer>> {
  const row = await one<{ webauthn_id: string | null }>(store, 'SELECT webauthn_id FROM users WHERE username = $1', [username]);
  if (!row) throw httpError(`No user "${username}"`, 404);
  if (row.webauthn_id) return new Uint8Array(Buffer.from(row.webauthn_id, 'base64url'));
  const id = crypto.randomBytes(32);
  await run(store, 'UPDATE users SET webauthn_id = $2 WHERE username = $1 AND webauthn_id IS NULL', [username, id.toString('base64url')]);
  return userHandle(store, username);
}

/**
 * The user's WebAuthn user handle (base64url), or null when no passkey was ever made for the account. The page passes
 * it to the browser with the account's passkeys, so the phone or computer drops the ones removed here.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `string | null`.
 */
export async function passkeyUserHandle(store: Store, username: string): Promise<string | null> {
  const row = await one<{ webauthn_id: string | null }>(store, 'SELECT webauthn_id FROM users WHERE username = $1', [userKey(username)]);
  return row ? row.webauthn_id : null;
}

/**
 * List passkeys.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `PasskeyInfo[]`.
 */
export async function listPasskeys(store: Store, username: string): Promise<PasskeyInfo[]> {
  return (await all<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE username = $1 ORDER BY created_at',
    [userKey(username)])).map(fromRow);
}

/**
 * The two ways a passkey is added: with the browser's prompt (the user is verified), or saved by the browser by itself
 * right after a password sign-in (no prompt, so the device may not verify the user then). Each has its own challenges.
 */
interface Registration { purpose: 'register' | 'register-auto'; userVerification: 'required' | 'preferred' }
const PROMPTED: Registration = { purpose: 'register', userVerification: 'required' };
const AUTOMATIC: Registration = { purpose: 'register-auto', userVerification: 'preferred' };

async function optionsFor(store: Store, username: string, relyingParty: RelyingParty, registration: Registration) {
  const name = userKey(username);
  const existing = await all<{ id: string; transports: string[] | null }>(store, 'SELECT id, transports FROM passkeys WHERE username = $1 AND rp_id = $2',
    [name, relyingParty.rpID]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: relyingParty.rpID, userName: name, userID: await userHandle(store, name), attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({ id: credential.id, transports: credential.transports || undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: registration.userVerification },
  });
  relyingParty.challenges.remember(options.challenge, registration.purpose, name, relyingParty.rpID);
  return options;
}

/**
 * Options for adding a passkey with the browser's prompt (the caller has checked their password).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @returns Computed result.
 */
export const registrationOptions = (store: Store, username: string, relyingParty: RelyingParty) => optionsFor(store, username, relyingParty, PROMPTED);
/**
 * Options for the browser saving a passkey by itself right after a password sign-in.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @returns Computed result.
 */
export const autoRegistrationOptions = (store: Store, username: string, relyingParty: RelyingParty) =>
  optionsFor(store, username, relyingParty, AUTOMATIC);

async function savePasskey(store: Store, username: string, response: unknown, label: unknown, relyingParty: RelyingParty,
  registration: Registration): Promise<PasskeyInfo> {
  const name = userKey(username);
  const title = String(label ?? '').trim() || 'Passkey';
  if (title.length > NAME_MAX) throw httpError(`The passkey name must be at most ${NAME_MAX} characters`);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedChallenge: (challenge) => relyingParty.challenges.take(challenge, registration.purpose, name, relyingParty.rpID),
      expectedOrigin: relyingParty.origin, expectedRPID: relyingParty.rpID, requireUserVerification: registration.userVerification === 'required',
    });
  } catch (err) { throw httpError(`The passkey could not be added: ${(err as Error).message}`); }
  if (!verification.verified) throw httpError('The passkey could not be added');
  const { credential: cred, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const added = await run(store, `INSERT INTO passkeys (id, username, rp_id, public_key, counter, transports, name, device_type, backed_up, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
  [cred.id, name, relyingParty.rpID, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports || []), title, credentialDeviceType,
    credentialBackedUp, new Date().toISOString()]);
  if (!added) throw httpError('This passkey is already registered', 409);
  return fromRow((await one<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE id = $1', [cred.id]))!);
}

/**
 * Checks the browser's answer to registrationOptions and saves the passkey under `label`.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param response - WebAuthn browser response payload.
 * @param label - Display label.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @returns Computed result.
 */
export const addPasskey = (store: Store, username: string, response: unknown, label: unknown, relyingParty: RelyingParty) =>
  savePasskey(store, username, response, label, relyingParty, PROMPTED);
/**
 * Checks the browser's answer to autoRegistrationOptions and saves the passkey under `label`.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param response - WebAuthn browser response payload.
 * @param label - Display label.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @returns Computed result.
 */
export const addAutoPasskey = (store: Store, username: string, response: unknown, label: unknown, relyingParty: RelyingParty) =>
  savePasskey(store, username, response, label, relyingParty, AUTOMATIC);

/**
 * Options for signing in with any passkey made for this site (discoverable passkeys: no username needed).
 *
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @returns Promise resolving to the operation result.
 */
export async function authenticationOptions(relyingParty: RelyingParty) {
  /**
   * timeout: as long as the challenge lasts, so the username box's passkey suggestions wait for it (web/ui/Login.tsx).
   */
  const options = await generateAuthenticationOptions({ rpID: relyingParty.rpID, userVerification: 'required', timeout: CHALLENGE_MS });
  relyingParty.challenges.remember(options.challenge, 'signin', null, relyingParty.rpID);
  return options;
}

/**
 * Options for the signed-in user to confirm it's them with one of their passkeys for this site (step-up). 409 when
 * they have none here.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @returns Promise resolving to the operation result.
 * @throws HTTP 409 error on invalid input or conflict.
 */
export async function confirmationOptions(store: Store, username: string, relyingParty: RelyingParty) {
  const name = userKey(username);
  const mine = await all<{ id: string }>(store, 'SELECT id FROM passkeys WHERE username = $1 AND rp_id = $2',
    [name, relyingParty.rpID]);
  if (!mine.length) throw httpError(`You have no passkey for ${relyingParty.rpID}. Add one in User Settings.`, 409);
  /**
   * No transports: the browser then also offers a passkey on a phone or tablet nearby (its QR code), not only this device.
   */
  const options = await generateAuthenticationOptions({ rpID: relyingParty.rpID, userVerification: 'required',
    allowCredentials: mine.map((credential) => ({ id: credential.id })) });
  relyingParty.challenges.remember(options.challenge, 'confirm', name, relyingParty.rpID);
  return options;
}

/**
 * Checks a passkey answer to authenticationOptions; returns the passkey's username. Throws 401 on anything wrong
 * (unknown passkey, bad signature, expired challenge, counter gone backwards: a possible copy of the key).
 *
 * @param store - Database store handle.
 * @param response - WebAuthn browser response payload.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @param username - Local account username.
 * @param refused - `(why: string) => Error` value.
 * @returns Promise resolving to `string`.
 * @throws Error when validation or the underlying operation fails.
 */
async function checkPasskey(store: Store, response: unknown, relyingParty: RelyingParty, username: string | null, refused: (why: string) => Error): Promise<string> {
  const res = response as AuthenticationResponseJSON;
  const row = res && typeof res.id === 'string'
    ? await one<PasskeyRow>(store, 'SELECT * FROM passkeys WHERE id = $1 AND rp_id = $2', [res.id, relyingParty.rpID]) : undefined;
  if (!row) throw new UnknownPasskeyError(refused('this passkey is not registered here (it may have been removed)').message);
  if (username !== null && row.username !== username) throw refused('this passkey belongs to another account');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: res, expectedChallenge: (challenge) => relyingParty.challenges.take(challenge, username === null ? 'signin' : 'confirm', username, relyingParty.rpID),
      expectedOrigin: relyingParty.origin, expectedRPID: relyingParty.rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: Number(row.counter), transports: row.transports || undefined },
      requireUserVerification: true,
    });
  } catch (err) { throw refused((err as Error).message); }
  if (!verification.verified) throw refused('the signature did not match');
  await run(store, 'UPDATE passkeys SET counter = $2, last_used_at = $3, backed_up = $4 WHERE id = $1',
    [row.id, verification.authenticationInfo.newCounter, new Date().toISOString(), verification.authenticationInfo.credentialBackedUp]);
  return row.username;
}

/**
 * Checks a passkey sign-in; returns the username.
 *
 * @param store - Database store handle.
 * @param response - WebAuthn browser response payload.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 * @returns Promise resolving to `string`.
 */
export function signInWithPasskey(store: Store, response: unknown, relyingParty: RelyingParty): Promise<string> {
  return checkPasskey(store, response, relyingParty, null, (why) => httpError(`Passkey sign-in failed: ${why}`, 401));
}

/**
 * Checks that the signed-in user confirmed with one of their own passkeys (step-up; see authenticationOptions).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param response - WebAuthn browser response payload.
 * @param relyingParty - WebAuthn relying party (`rpID`, `origin`, `challenges`).
 */
export async function confirmWithPasskey(store: Store, username: string, response: unknown, relyingParty: RelyingParty): Promise<void> {
  await checkPasskey(store, response, relyingParty, userKey(username), (why) => httpError(`The passkey confirmation failed: ${why}`, 401));
}

/**
 * Rename passkey.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param id - Unique record identifier.
 * @param label - Display label.
 * @throws HTTP 400/404 error on invalid input or conflict.
 */
export async function renamePasskey(store: Store, username: string, id: string, label: unknown): Promise<void> {
  const title = String(label ?? '').trim();
  if (!title || title.length > NAME_MAX) throw httpError(`Give the passkey a name of 1-${NAME_MAX} characters`);
  if (!await run(store, 'UPDATE passkeys SET name = $3 WHERE username = $1 AND id = $2', [userKey(username), String(id), title])) {
    throw httpError('Passkey not found', 404);
  }
}

/**
 * Remove passkey.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @param id - Unique record identifier.
 * @returns Promise resolving to `string`.
 * @throws HTTP 404 error on invalid input or conflict.
 */
export async function removePasskey(store: Store, username: string, id: string): Promise<string> {
  const row = await one<{ name: string }>(store, 'DELETE FROM passkeys WHERE username = $1 AND id = $2 RETURNING name', [userKey(username), String(id)]);
  if (!row) throw httpError('Passkey not found', 404);
  return row.name;
}
