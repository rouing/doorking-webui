/**
 * @module web/ui/account/passkeyAutofill
 *
 * Passkeys in the username box's suggestions (WebAuthn conditional mediation, "autofill"): a passkey request waits in
 * the background until the user picks one there. It gets a new challenge before the server's expires (5 minutes),
 * starts again after a timeout or a cancelled fingerprint prompt, and stops while the sign-in button's own passkey
 * request runs (whilePaused). Challenges are asked for only while the page is visible, so sign-in pages left open in
 * the background don't use up the server's per-address limit on them.
 */
import { useEffect, useRef, useState } from 'react';
import { browserSupportsWebAuthnAutofill, startAuthentication, WebAuthnAbortService, type AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { api } from '../api.ts';

export type PasskeyOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
export type PasskeyAnswer = (optionsJSON: PasskeyOptions, response: AuthenticationResponseJSON) => Promise<void>;

const RENEW_MS = 4 * 60000;
const RETRY_PAUSE_MS = 3000;

interface Handlers {
  onAnswer: PasskeyAnswer; // signs in with the picked passkey; throws when that fails
  onError: (err: unknown) => void; // a failed sign-in (the suggestions are offered again)
}

interface PasskeyAutofillOptions extends Handlers {
  enabled: boolean; // while the sign-in form shows
}

type Next = 'again' | 'stop';

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Resolves once the page is visible (at once when it is), or when stop aborts.
 *
 * @param stop - `AbortSignal` value.
 */
function whenVisible(stop: AbortSignal): Promise<void> {
  if (document.visibilityState === 'visible') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (document.visibilityState !== 'visible' && !stop.aborted) return;
      document.removeEventListener('visibilitychange', done);
      stop.removeEventListener('abort', done);
      resolve();
    };
    document.addEventListener('visibilitychange', done);
    stop.addEventListener('abort', done);
  });
}

/**
 * Signs in with the picked passkey: stop when it worked, offer the passkeys again when it didn't.
 *
 * @param optionsJSON - `PasskeyOptions` value.
 * @param response - WebAuthn browser response payload.
 * @param handlers - `Handlers` value.
 * @returns Promise resolving to `Next`.
 */
async function answer(optionsJSON: PasskeyOptions, response: AuthenticationResponseJSON, handlers: Handlers): Promise<Next> {
  try {
    await handlers.onAnswer(optionsJSON, response);
    return 'stop';
  } catch (err) {
    handlers.onError(err);
    return 'again';
  }
}

/**
 * After the browser's request ended without a passkey: renewed (again), timed out or cancelled (again, after a pause),
 * or anything else, such as the page closing or the button's request taking over (stop).
 *
 * @param err - Caught error value.
 * @param renewed - `AbortSignal` value.
 * @returns Promise resolving to `Next`.
 */
async function afterFailure(err: unknown, renewed: AbortSignal): Promise<Next> {
  const name = err instanceof Error ? err.name : '';
  if (renewed.aborted && name === 'AbortError') return 'again';
  if (name !== 'NotAllowedError') return 'stop';
  await sleep(RETRY_PAUSE_MS);
  return 'again';
}

/**
 * One offer of the passkeys, with a fresh challenge.
 *
 * @param stop - `AbortSignal` value.
 * @param handlers - `Handlers` value.
 * @returns Promise resolving to `Next`.
 */
async function offerOnce(stop: AbortSignal, handlers: Handlers): Promise<Next> {
  await whenVisible(stop);
  if (stop.aborted) return 'stop';
  const optionsJSON = await api<PasskeyOptions>('POST', '/api/passkey/options', {}).catch(() => null);
  if (!optionsJSON || stop.aborted) return 'stop';
  const renew = new AbortController();
  /**
   * The challenge is renewed in time, but in a hidden page only once it is visible again (it may have expired by then;
   * the waiting request is then renewed at once).
   */
  const ended = new AbortController(); // this offer is over: a renewal still waiting for the page must not cancel a later request
  const renewNow = () => { renew.abort(); WebAuthnAbortService.cancelCeremony(); };
  const timer = setTimeout(() => { whenVisible(ended.signal).then(() => { if (!ended.signal.aborted && !stop.aborted) renewNow(); }); }, RENEW_MS);
  try {
    return await answer(optionsJSON, await startAuthentication({ optionsJSON, useBrowserAutofill: true }), handlers);
  } catch (err) {
    return await afterFailure(err, renew.signal);
  } finally {
    clearTimeout(timer);
    ended.abort();
  }
}

async function offerUntilDone(stop: AbortSignal, handlers: Handlers): Promise<void> {
  if (!await browserSupportsWebAuthnAutofill()) return;
  while (!stop.aborted && await offerOnce(stop, handlers) === 'again');
}

/**
 * Offers the passkeys in the suggestions while enabled. whilePaused(run): stops offering while run() does its own
 * passkey request (its request cancels the waiting one), then offers them again.
 *
 * @param options - Options object.
 * @param options.enabled - Enabled.
 * @param options.onAnswer - On answer.
 * @param options.onError - On error.
 * @returns Operation result.
 */
export function usePasskeyAutofill({ enabled, onAnswer, onError }: PasskeyAutofillOptions) {
  const handlers = useRef<Handlers>({ onAnswer, onError });
  handlers.current = { onAnswer, onError };
  const [holds, setHolds] = useState(0);
  const holding = useRef(0);
  const active = enabled && holds === 0;
  useEffect(() => {
    if (!active) return undefined;
    const stop = new AbortController();
    offerUntilDone(stop.signal, { onAnswer: (...args) => handlers.current.onAnswer(...args), onError: (err) => handlers.current.onError(err) });
    return () => {
      stop.abort();
      if (!holding.current) WebAuthnAbortService.cancelCeremony(); // a paused run's own request has replaced it already
    };
  }, [active]);
  async function whilePaused(run: () => Promise<void>): Promise<void> {
    holding.current++;
    setHolds((count) => count + 1);
    try {
      await run();
    } finally {
      holding.current--;
      setHolds((count) => count - 1);
    }
  }
  return { whilePaused };
}
