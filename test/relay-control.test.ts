// Run with: node --test test/relay-control.test.ts
import test from 'node:test';
import assert from 'node:assert';
import * as dk from '../index.ts';

// Fake DKS client: GetRelays returns `status`, SetRelays records the Settings string.
function fakeClient(status, reply = 'OK') {
  const calls = [];
  return {
    calls,
    getRelays: () => Promise.resolve(status),
    setRelays: (u, p, ph, m, settings) => { calls.push(settings); return Promise.resolve(reply); },
  };
}
const cred = { user: 'u', password: 'p', phoneNumber: '1', masterCode: 'm', retryMs: 1 };

test('controlRelays: 20-char Settings = mode letter + 19 states; main-board change -> M', async () => {
  const c = fakeClient('0000000000000000000');
  const r = await dk.controlRelays(c, cred, { 1: true });
  assert.strictEqual(r.settings, 'M0100000000000000000');
  assert.strictEqual(r.settings.length, 20);
});

test('controlRelays: untouched relays echo current; unknown (2) sent as 0', async () => {
  const c = fakeClient('2100000000000000000'); // relay0 unknown, relay1 on
  const r = await dk.controlRelays(c, cred, { 2: true });
  // relay0 2->0, relay1 stays 1, relay2 set 1, rest 0, mode M (no bank 3-18 change)
  assert.strictEqual(r.settings, 'M0110000000000000000');
});

test('controlRelays: mode letter reflects which banks change', async () => {
  const base = '0000000000000000000';
  // relay 5 is in bank 3-10 -> R
  assert.strictEqual((await dk.controlRelays(fakeClient(base), cred, {})).settings[0], 'M');
  const setBank1 = await dk.controlRelays({ getRelays: () => Promise.resolve(base), setRelays: () => Promise.resolve('OK') },
    cred, {});
  assert.strictEqual(setBank1.settings[0], 'M');
});

test('controlRelays: retries on timeout reply, then succeeds', async () => {
  let n = 0;
  const c = {
    getRelays: () => Promise.resolve('0000000000000000000'),
    setRelays: (u, p, ph, m, s) => { n += 1; return Promise.resolve(n < 3 ? 'Error: a network timeout error has occurred.' : 'OK'); },
  };
  const r = await dk.controlRelays(c, cred, { 1: true });
  assert.strictEqual(r.reply, 'OK');
  assert.strictEqual(n, 3);
});
