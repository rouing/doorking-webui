import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackController, type BackHistory } from '../back.ts';
import { doorKingCsv } from '../csv.ts';
import { fmtIntlPhone, formatPhoneDigits, hidePortalHoldNoise, jobLabel, phoneFull } from '../format.ts';
import { fmtPhone, generateSafeEntryCode, isWeakEntryCode, parseNanpPhone } from '../lib/shared.ts';
import type { ResidentRow, TransactionRow } from '../types.ts';

function sampleResident(overrides: Partial<ResidentRow> = {}): ResidentRow {
  return {
    directoryCode: '101',
    name: 'Alice, "A"',
    type: 'Resident',
    hidden: false,
    areaCode: '214',
    phone: '5550100',
    entryCode: '4821',
    securityLevel: 1,
    floor: 0,
    elevatorRef: 0,
    cards: ['19910', '00042'],
    note: 'Unit note',
    ...overrides,
  };
}

test('doorKingCsv escapes quotes, sorts cards ascending, and marks hidden residents Y', () => {
  const csv = doorKingCsv('Oakridge', [
    sampleResident({ directoryCode: '102', name: 'Hidden User', hidden: true, cards: ['500'] }),
    sampleResident({ directoryCode: '101' }),
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('ACCOUNT,Resident,H,AAC,PHONE,Dir,ENT,SL,Device'));
  assert.ok(lines[1].includes('"Alice, ""A""",N,214,5550100,101,4821,1,00042'));
  assert.ok(lines[2].includes('"Hidden User",Y,214,5550100,102,4821,1,00500'));
});

test('generateSafeEntryCode avoids weak patterns and existing codes', () => {
  assert.equal(isWeakEntryCode('1234'), true);
  assert.equal(isWeakEntryCode('0000'), true);
  assert.equal(isWeakEntryCode('1212'), true);
  assert.equal(isWeakEntryCode('4829'), false);

  const taken = ['4829', '7391'];
  const code = generateSafeEntryCode(taken);
  assert.match(code, /^\d{4}$/);
  assert.equal(taken.includes(code), false);
  assert.equal(isWeakEntryCode(code), false);
});

test('doorKingCsv attaches unassignedCards to directory code 000', () => {
  const csv = doorKingCsv('Oakridge', [
    sampleResident({ directoryCode: '000', name: '', entryCode: '', cards: [] }),
  ], ['777']);
  assert.ok(csv.includes('000,,1,00777'));
});

test('hidePortalHoldNoise hides paired Hold Begin/End for Portal Open and keeps real holds', () => {
  const baseTs = 1795542936000;
  const rows: TransactionRow[] = [
    { ts: baseTs, date: '2026-11-24', time: '11:55 AM', minute: '20261124-1155', eventType: 'Portal Open', access: 'Admit', name: 'Alice', directoryCode: '101', relay: 'Entry', number: '101', raw: 'p1', source: 'portal' },
    { ts: baseTs - 36_000, date: '2026-11-24', time: '11:55 AM', minute: '20261124-1155', eventType: 'Hold End', access: 'Rels', name: '', directoryCode: '', relay: 'Entry', number: '', raw: 'h1' },
    { ts: baseTs - 36_000, date: '2026-11-24', time: '11:55 AM', minute: '20261124-1155', eventType: 'Hold Begin', access: 'Hold', name: '', directoryCode: '', relay: 'Entry', number: '', raw: 'h2' },
    { ts: baseTs - 3_600_000, date: '2026-11-24', time: '10:55 AM', minute: '20261124-1055', eventType: 'Hold End', access: 'Rels', name: '', directoryCode: '', relay: 'Entry', number: '', raw: 'h3' },
    { ts: baseTs - 5_400_000, date: '2026-11-24', time: '10:25 AM', minute: '20261124-1025', eventType: 'Hold Begin', access: 'Hold', name: '', directoryCode: '', relay: 'Entry', number: '', raw: 'h4' },
  ];
  const out = hidePortalHoldNoise(rows);
  assert.equal(out.length, 3);
  assert.equal(out[0].eventType, 'Portal Open');
  assert.equal(out[1].raw, 'h3');
  assert.equal(out[2].raw, 'h4');
});

test('libphonenumber-js phone parsing & formatting covers NANP, local 7-digit, and international E.164', () => {
  assert.deepEqual(parseNanpPhone('(214) 555-0100'), { areaCode: '214', phone: '5550100' });
  assert.deepEqual(parseNanpPhone('+1 214 555 0100', { keepLeadingOne: true }), { areaCode: '1214', phone: '5550100' });
  assert.deepEqual(parseNanpPhone('555-0100'), { areaCode: '', phone: '5550100' });
  assert.equal(parseNanpPhone('12345'), null);

  assert.equal(fmtPhone('2145550100'), '(214) 555-0100');
  assert.equal(fmtPhone('12145550100'), '1 (214) 555-0100');
  assert.equal(fmtPhone('5550100'), '555-0100');
  assert.equal(phoneFull(sampleResident({ areaCode: '214', phone: '5550100' })), '(214) 555-0100');
  assert.equal(formatPhoneDigits('2145550100'), '(214) 555-0100');

  assert.equal(fmtIntlPhone('+12145550100'), '+1 (214) 555-0100');
  assert.equal(fmtIntlPhone('+442079460958'), '+44 20 7946 0958');
});

test('jobLabel returns compact status labels without job type prefix', () => {
  assert.equal(jobLabel(null), '');
  assert.equal(jobLabel({ state: 'idle', what: 'residents', log: [] }), '');
  assert.equal(jobLabel({ state: 'running', what: 'transactions', log: [] }), 'Running');
  assert.equal(jobLabel({ state: 'running', what: 'residents', log: [] }), 'Running');
  assert.equal(jobLabel({ state: 'done', what: 'send', log: [] }), 'Done');
  assert.equal(jobLabel({ state: 'failed', what: 'transactions', log: [] }), 'Failed');
});

test('createBackController clamps history.go to pushedDepth and never cascades history.back on empty stack', async () => {
  const calls: string[] = [];
  let state: unknown = null;
  let pendingPop = 0;
  const hist: BackHistory = {
    get state() { return state; },
    pushState(data) { state = data; calls.push(`push:${JSON.stringify(data)}`); },
    replaceState(data) { state = data; calls.push(`replace:${JSON.stringify(data)}`); },
    go(delta) { calls.push(`go:${delta}`); pendingPop++; },
    back() { calls.push('back'); },
  };
  const ctrl = createBackController(hist);

  // Portal toggle: GateApp unmounts its layer and ResidentPortal mounts its back-to-staff layer in one commit.
  let closedGate = false;
  let closedPortal = false;
  const cleanupGate = ctrl.push({ close: () => { closedGate = true; } });
  assert.equal(ctrl.depth, 1);

  cleanupGate();
  const cleanupPortal = ctrl.push({ close: () => { closedPortal = true; } });
  await Promise.resolve(); // flush queueMicrotask
  assert.equal(pendingPop, 1);
  assert.equal(calls.at(-1), 'go:-1');

  // Browser delivers popstate for history.go(-1); queued portal entry is pushed cleanly.
  ctrl.onPopState();
  assert.equal(ctrl.depth, 1);
  assert.equal(ctrl.size, 1);
  assert.equal(closedGate, false);

  // Hardware/browser Back closes ResidentPortal back to Staff view.
  ctrl.onPopState();
  assert.equal(closedPortal, true);
  assert.equal(ctrl.depth, 0);
  assert.equal(ctrl.size, 0);
  cleanupPortal(); // no-op since popped by Back
  await Promise.resolve();
  assert.equal(pendingPop, 1);

  // Stale dkLayer entry on an empty stack must NOT call history.back(); it replaces state in place.
  state = { dkLayer: 1 };
  ctrl.onPopState();
  assert.equal(calls.includes('back'), false);
  assert.equal(state, null);
  assert.equal(calls.at(-1), 'replace:null');
});

test('createBackController keeps a multi-step layer armed while close() returns true', () => {
  let state: unknown = null;
  const hist: BackHistory = {
    get state() { return state; },
    pushState(data) { state = data; },
    replaceState(data) { state = data; },
    go() {},
    back() {},
  };
  const ctrl = createBackController(hist);

  let exited = false;
  const pages = ['residents', 'vendors', 'transactions'];
  ctrl.push({ close: () => { exited = true; } });
  const cleanupNav = ctrl.push({
    close: () => {
      pages.pop();
      return pages.length > 1;
    },
  });
  assert.equal(ctrl.size, 2);
  assert.equal(ctrl.depth, 2);

  // First Back steps transactions -> vendors and stays armed.
  ctrl.onPopState();
  assert.deepEqual(pages, ['residents', 'vendors']);
  assert.equal(exited, false);
  assert.equal(ctrl.size, 2);
  assert.equal(ctrl.depth, 2);

  // Second Back steps vendors -> residents and releases the layer.
  ctrl.onPopState();
  assert.deepEqual(pages, ['residents']);
  assert.equal(exited, false);
  assert.equal(ctrl.size, 1);
  assert.equal(ctrl.depth, 1);
  cleanupNav(); // no-op since popped on final step

  // Third Back exits via the underlying layer.
  ctrl.onPopState();
  assert.equal(exited, true);
  assert.equal(ctrl.size, 0);
  assert.equal(ctrl.depth, 0);
});
