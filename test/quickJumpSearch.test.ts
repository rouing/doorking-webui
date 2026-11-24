import test from 'node:test';
import assert from 'node:assert';
import { searchGate } from '../nav/quickJumpSearch.ts';

test('searchGate ranks exact card/entry/directory code matches above names and pages', () => {
  const residents = [
    { directoryCode: '101', name: 'Smith, J', type: 'Resident' as const, hidden: false, areaCode: '214', areaCodeIndex: 0, phone: '5550101', entryCode: '4821', securityLevel: 1, elevatorRef: 1, floor: '' as const, cards: ['10234'], entryOffset: 0, recordOffset: 0, note: 'Front gate' },
    { directoryCode: '102', name: 'Baker, L', type: 'Resident' as const, hidden: false, areaCode: '214', areaCodeIndex: 0, phone: '5550102', entryCode: '', securityLevel: 1, elevatorRef: 1, floor: '' as const, cards: ['20001'], entryOffset: 20, recordOffset: 10, note: '' },
  ];
  const transactions = [
    { ts: 1, minute: '20261121-0900', date: '2026-11-21', time: '9:00 AM', eventType: 'Cards', number: '10234', lookup: 'card' as const, name: 'Smith, J', access: 'Admit', relay: 'Entry', apb: '', directoryCode: '101', camera: true, raw: '00' },
  ];
  const cardHits = searchGate('10234', { residents, transactions, elevators: true });
  assert.strictEqual(cardHits[0].kind, 'resident');
  if (cardHits[0].kind === 'resident') assert.strictEqual(cardHits[0].resident.directoryCode, '101');
  const codeHits = searchGate('4821', { residents, transactions, elevators: true });
  assert.strictEqual(codeHits[0].kind, 'resident');
  if (codeHits[0].kind === 'resident') assert.strictEqual(codeHits[0].resident.directoryCode, '101');
  const pageHits = searchGate('holidays', { residents, transactions, elevators: true });
  assert.strictEqual(pageHits[0].kind, 'page');
  if (pageHits[0].kind === 'page') assert.strictEqual(pageHits[0].page, 'holidays');
});
