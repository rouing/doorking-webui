import assert from 'node:assert/strict';
import test from 'node:test';
import { doorKingCsv } from '../csv.ts';
import { hidePortalHoldNoise } from '../format.ts';
import { generateSafeEntryCode, isWeakEntryCode } from '../lib/shared.ts';
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
