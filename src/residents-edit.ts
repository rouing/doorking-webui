// Applies resident/vendor edits to the working-copy board buffers (names.bin, phone.bin, cards.bin).
// Pure: takes and returns Buffers, never touches the gate. Field encodings were all confirmed by
// isolated before/after gate pulls (see board-files.ts and the decode scoreboard):
//   names entry (20 bytes): name 0-14 (15, space padded), flag 15 (bit0=vendor, bit5=shown),
//     directory code 16-19 (right-justified, space padded; 1-4 digits per names.bin 0x40, see namesDirDigits).
//   phone record (10 bytes): dir code 0-1 (BCD), area-code index + 7-digit local number 2-5 (layout
//     depends on the area-code mode, see readPhoneFields), entry code 6-7 (BCD),
//     byte 8 = bits0-4 security | bits5-7 elevator-1, floor 9 (0xFF = unset).
//   cards record (4 bytes): card number 0-1 (BE), dir code 2-3 (BCD).
// names.bin and phone.bin layouts follow the area-code mode (255 or 10), detected from names.bin (namesLayout).

import {
  NAMES_LAYOUTS, namesLayout, readPhoneFields, writePhoneFields, NAMES_DIR_DIGITS_OFFSET, namesDirDigits, namesEntryCode,
} from './board-files.ts';

export interface BoardBuffers { names: Buffer; phone: Buffer; cards: Buffer }
// Fields of a resident edit; only those present are changed (see applyResidentEdit).
export interface ResidentEdit { directoryCode?: unknown; [field: string]: any }
export interface EditOptions { areaCodeSlots?: number }
export interface AreaCodeUse { index: number; code: string | null; uses: number }

const NAMES_ENTRY_SIZE = 20;
const NAMES_AREA_CODE_SLOTS = 255;
const NAMES_MIDDLE_POINTER_OFFSET = 0xf8; // 3-byte BE offset of the middle shown entry (DoorKing32.exe.c:119433)
export const NAMES_MODE_DELTA = NAMES_LAYOUTS[255].directoryOffset - NAMES_LAYOUTS[10].directoryOffset; // 0x380
const PHONE_SIZE = 10;
const CARD_SIZE = 4;

const err = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const digits = (s: unknown): string => String(s == null ? '' : s).replace(/\D/g, '');

// Right-justify decimal digits into nbytes (leading-F padding), matching the bcd() decoder.
// Empty -> all 0xFF (the "unset" convention the parsers use).
export function encodeBcd(value: unknown, nbytes: number): Buffer {
  const d = digits(value);
  if (!d) return Buffer.alloc(nbytes, 0xff);
  if (d.length > nbytes * 2) throw err(`"${d}" is too long for ${nbytes * 2} digits`);
  const nibbles = d.padStart(nbytes * 2, 'f').split('').map((c) => (c === 'f' ? 0xf : Number(c)));
  const out = Buffer.alloc(nbytes);
  for (let i = 0; i < nbytes; i++) out[i] = (nibbles[i * 2] << 4) | nibbles[i * 2 + 1];
  return out;
}

const bcdToStr = (buf: Uint8Array): string | null => {
  let s = '';
  for (const b of buf) for (const n of [b >> 4, b & 0xf]) if (n <= 9) s += n; else if (n !== 0xf) return null;
  return s;
};

const dirStart = (names: Buffer) => namesLayout(names).directoryOffset;
const phoneMode = (names: Buffer) => namesLayout(names).areaCodeMode;

// Directory code at the gate's digit count (names.bin 0x40); shorter input gets leading zeros.
function dirCode(names: Buffer, value: unknown): string {
  const n = namesDirDigits(names);
  const code = digits(value).padStart(n, '0');
  if (!digits(value) || code.length !== n) throw err(`A ${n}-digit directory code is required`);
  return code;
}

export function findNamesEntry(names: Buffer, code: string | null): number {
  for (let o = dirStart(names); o + NAMES_ENTRY_SIZE <= names.length; o += NAMES_ENTRY_SIZE) {
    if (namesEntryCode(names, o) === code) return o;
  }
  return -1;
}

const isEntryAt = (names: Buffer, o: number): boolean => namesEntryCode(names, o) !== null;

// Offset just past the last directory entry.
function directoryEnd(names: Buffer): number {
  let o = dirStart(names);
  while (isEntryAt(names, o)) o += NAMES_ENTRY_SIZE;
  return o;
}

// Offset just past the last used phone record.
function phoneEnd(phone: Buffer): number {
  let end = 0;
  for (let o = 0; o + PHONE_SIZE <= phone.length; o += PHONE_SIZE) if (!(phone[o] === 0xff && phone[o + 1] === 0xff)) end = o + PHONE_SIZE;
  return end;
}

// DoorKing32 order: empty slots, then residents (shown or hidden), then vendors; each by name ignoring case.
const entryGroup = (names: Buffer, o: number): number => (names[o + 15] & 0x01 ? 2 : isEmptySlot(names, o) ? 0 : 1);
const nameKey = (s: string): string => s.toUpperCase();

// Writes the middle shown-entry pointer at 0xF8-0xFA, as DoorKing32 does on save. Unchanged when nothing is shown.
// The stored offset always counts from the 255-mode directory start (0xF80).
export function updateMiddlePointer(names: Buffer): void {
  const start = dirStart(names);
  const shown: number[] = [];
  for (let o = start; isEntryAt(names, o); o += NAMES_ENTRY_SIZE) if (names[o + 15] === 0x20) shown.push(o);
  if (!shown.length) return;
  const o = shown[Math.floor((shown.length - 1) / 2)] + (NAMES_LAYOUTS[255].directoryOffset - start);
  names[NAMES_MIDDLE_POINTER_OFFSET] = (o >> 16) & 0xff;
  names[NAMES_MIDDLE_POINTER_OFFSET + 1] = (o >> 8) & 0xff;
  names[NAMES_MIDDLE_POINTER_OFFSET + 2] = o & 0xff;
}

// Recomputes the middle pointer only when the directory itself changed, so other edits leave the header alone.
function withPointer<T extends { names: Buffer }>(before: Buffer, result: T): T {
  const start = dirStart(before);
  const end = Math.max(directoryEnd(before), directoryEnd(result.names));
  if (!before.subarray(start, end).equals(result.names.subarray(start, end))) updateMiddlePointer(result.names);
  return result;
}

export function findPhoneRecord(phone: Buffer, code: string): number {
  for (let o = 0; o + PHONE_SIZE <= phone.length; o += PHONE_SIZE) {
    if (phone[o] === 0xff && phone[o + 1] === 0xff) continue;
    if (bcdToStr(phone.subarray(o, o + 2)) === code) return o;
  }
  return -1;
}

// Area-code slots allowed by the gate's "Area codes" setting ('10 Area Codes' or '255 Area Codes').
export const areaCodeLimit = (setting: unknown): number => (/^\s*10\b/.test(String(setting || '')) ? 10 : NAMES_AREA_CODE_SLOTS);

// Finds the area-code table index for value, appending to the first free slot (below limit) when absent.
// '' -> 0xFF (none). An area code is 3 digits, or 4 as 1 + area code for long-distance dialing (DoorKing manual:
// "Alternate Area Code"); the 4-digit form is stored as all 4 BCD digits (1315 -> 13 15).
export function areaCodeIndex(names: Buffer, value: unknown, limit: number = NAMES_AREA_CODE_SLOTS): number {
  const d = digits(value);
  if (!d) return 0xff;
  if (!/^(\d{3}|1\d{3})$/.test(d)) throw err(`Area code must be 3 digits, or 4 starting with 1 (got "${d}")`);
  const { areaCodeOffset, areaCodeSlots } = namesLayout(names);
  const max = Math.min(limit, areaCodeSlots);
  const want = encodeBcd(d, 2);
  let free = -1;
  for (let i = 0; i < areaCodeSlots; i++) {
    const o = areaCodeOffset + i * 2;
    if (o + 2 > names.length) break;
    const rec = names.subarray(o, o + 2);
    if (rec.equals(want)) return i;
    if (free < 0 && i < max && rec[0] === 0xff && rec[1] === 0xff) free = i;
  }
  if (free < 0) throw err(`No free area-code slots on the gate (limit ${max})`);
  want.copy(names, areaCodeOffset + free * 2);
  return free;
}

// Each phone record's area-code index (0xFF = none), keyed by phone-record offset (unused records skipped).
function phoneAreaIndexes(phone: Buffer, mode = 255): [number, number][] {
  const out: [number, number][] = [];
  const end = phoneEnd(phone);
  for (let po = 0; po + PHONE_SIZE <= end; po += PHONE_SIZE) {
    if (phone[po] === 0xff && phone[po + 1] === 0xff) continue;
    const i = readPhoneFields(phone.subarray(po, po + PHONE_SIZE), mode).areaCodeIndex;
    out.push([po, i == null ? 0xff : i]);
  }
  return out;
}

// The area-code table with how many phone records use each entry: [{ index, code, uses }].
export function areaCodeUsage(names: Buffer, phone: Buffer): AreaCodeUse[] {
  const { areaCodeOffset, areaCodeSlots, areaCodeMode } = namesLayout(names);
  const uses: Record<number, number> = {};
  for (const [, i] of phoneAreaIndexes(phone, areaCodeMode)) if (i !== 0xff) uses[i] = (uses[i] || 0) + 1;
  const out: AreaCodeUse[] = [];
  for (let i = 0; i < areaCodeSlots; i++) {
    const o = areaCodeOffset + i * 2;
    if (o + 2 > names.length) break;
    const rec = names.subarray(o, o + 2);
    if (rec[0] === 0xff && rec[1] === 0xff) continue;
    out.push({ index: i, code: bcdToStr(rec), uses: uses[i] || 0 });
  }
  return out;
}

// "directory code 101 (Smith, J)" for conflict messages; names is optional.
function holderLabel(names: Buffer | undefined, code: string | null): string {
  const o = names ? findNamesEntry(names, code) : -1;
  const name = o >= 0 ? names!.toString('latin1', o, o + 15).trim() : '';
  return `directory code ${code}${name ? ` (${name})` : ''}`;
}

// desired = array of card-number strings. Adds missing ones to free (all-0xFF) slots, clears removed ones.
// A card number already held by another directory code is refused (409).
export function applyCards(cards: Buffer, code: string, desired: unknown[] | null | undefined, names?: Buffer): void {
  const want = new Set((desired || []).map((c) => digits(c)).filter(Boolean));
  const have = new Set<string>();
  const free: number[] = [];
  const codeBcd = encodeBcd(code, 2);
  for (let o = 0; o + CARD_SIZE <= cards.length; o += CARD_SIZE) {
    const rec = cards.subarray(o, o + CARD_SIZE);
    if (rec.every((b) => b === 0xff)) { free.push(o); continue; }
    if (bcdToStr(rec.subarray(2, 4)) !== code) continue;
    const num = String(rec.readUInt16BE(0));
    if (want.has(num) || want.has(num.padStart(5, '0'))) have.add(num);
    else { cards.fill(0xff, o, o + CARD_SIZE); free.push(o); } // remove
  }
  for (const c of want) {
    const num = Number(c);
    if (have.has(String(num))) continue;
    if (num < 1 || num > 65407) throw err(`Card number ${c} is out of range (device codes are 00001-65407)`);
    for (let p = 0; p + CARD_SIZE <= cards.length; p += CARD_SIZE) {
      if (cards.readUInt16BE(p) !== num || cards.subarray(p, p + CARD_SIZE).every((b) => b === 0xff)) continue;
      const owner = bcdToStr(cards.subarray(p + 2, p + 4));
      if (owner !== code) throw err(`Card ${num} is already assigned to ${holderLabel(names, owner)}`, 409);
    }
    const o = free.shift();
    if (o == null) throw err('No free card slots on the gate');
    cards.writeUInt16BE(num, o);
    codeBcd.copy(cards, o + 2);
  }
}

// edit: { directoryCode (required), name, hidden, vendor, areaCode, phone, entryCode, securityLevel,
//   elevatorRef, floor, cards[] }. Only provided fields are changed. Returns new buffers.
// opts.areaCodeSlots limits where a new area code may go (see areaCodeLimit).
export function applyResidentEdit(buffers: BoardBuffers, edit: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  return withPointer(buffers.names, editBuffers(buffers, edit, opts));
}

function editBuffers(buffers: BoardBuffers, edit: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  const code = dirCode(names, edit.directoryCode);

  const no = findNamesEntry(names, code);
  if (no < 0) throw err(`No directory entry for code ${code}`, 404);
  if ('name' in edit) {
    const name = String(edit.name ?? '').slice(0, 15).padEnd(15, ' ');
    names.write(name, no, 15, 'latin1');
  }
  if ('vendor' in edit || 'hidden' in edit) {
    let flag = names[no + 15];
    if ('vendor' in edit) flag = edit.vendor ? flag | 0x01 : flag & ~0x01;
    // bit 5 = shown; hidden clears it. Vendors are never shown, so keep bit 5 clear for them.
    if ('hidden' in edit) flag = edit.hidden || (('vendor' in edit ? edit.vendor : flag & 0x01)) ? flag & ~0x20 : flag | 0x20;
    names[no + 15] = flag;
  }

  const po = findPhoneRecord(phone, code);
  if (po < 0) throw err(`No phone record for code ${code}`, 404);
  if ('areaCode' in edit || 'phone' in edit) {
    const mode = phoneMode(names);
    const f = readPhoneFields(phone.subarray(po, po + PHONE_SIZE), mode);
    if ('areaCode' in edit) {
      const i = areaCodeIndex(names, edit.areaCode, opts.areaCodeSlots);
      f.areaCodeIndex = i === 0xff ? null : i;
    }
    if ('phone' in edit) {
      const d = digits(edit.phone);
      if (d.length > 7) throw err('Phone number is the 7-digit local number (area code is separate)');
      f.phone = d ? d.padStart(7, '0') : null;
    }
    writePhoneFields(phone, po, f, mode);
  }
  if ('entryCode' in edit) {
    const bytes = encodeBcd(edit.entryCode, 2);
    if (!bytes.equals(phone.subarray(po + 6, po + 8)) && digits(edit.entryCode)) {
      for (let o = 0; o + PHONE_SIZE <= phone.length; o += PHONE_SIZE) {
        if (o === po || (phone[o] === 0xff && phone[o + 1] === 0xff)) continue;
        if (bytes.equals(phone.subarray(o + 6, o + 8))) {
          throw err(`Entry code ${digits(edit.entryCode)} is already used by ${holderLabel(names, bcdToStr(phone.subarray(o, o + 2)))}`, 409);
        }
      }
    }
    bytes.copy(phone, po + 6);
  }
  if ('securityLevel' in edit || 'elevatorRef' in edit) {
    let b = phone[po + 8];
    if ('securityLevel' in edit) {
      const s = Number(edit.securityLevel);
      if (!Number.isInteger(s) || s < 0 || s > 30) throw err('Security level must be 0-30');
      b = (b & ~0x1f) | s;
    }
    if ('elevatorRef' in edit) {
      const e = Number(edit.elevatorRef);
      if (!Number.isInteger(e) || e < 1 || e > 8) throw err('Elevator reference must be 1-8');
      b = (b & 0x1f) | ((e - 1) << 5);
    }
    phone[po + 8] = b;
  }
  if ('floor' in edit) {
    const f = edit.floor === '' || edit.floor == null ? null : Number(edit.floor);
    if (f !== null && (!Number.isInteger(f) || f < 1 || f > 64)) throw err('Floor must be 1-64 or blank');
    phone[po + 9] = f === null ? 0xff : f;
  }

  if ('cards' in edit) applyCards(cards, code, edit.cards, names);

  return { names, phone, cards };
}

// Deletes a resident/vendor by returning its slot to the gate's own "empty slot" state: the directory
// entry keeps its code but the name is blanked and the flag cleared (0x00), the phone record keeps its
// code but every field is blanked (area/phone/entry = 0xFF, byte 8 = 0x01, floor = 0xFF), and all of the
// slot's cards are removed. This matches genuine empty slots byte-for-byte (verified against names.bin).
export function deleteResident(buffers: BoardBuffers, directoryCode: unknown): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  const code = dirCode(names, directoryCode);
  const no = findNamesEntry(names, code);
  if (no < 0) throw err(`No directory entry for code ${code}`, 404);
  names.fill(0x20, no, no + 15); // blank name (15 spaces), keep the code (16-19)
  names[no + 15] = 0x00; // flag: empty, unused slot
  const po = findPhoneRecord(phone, code);
  if (po >= 0) {
    phone.fill(0xff, po + 2, po + 8); // area index, phone, entry code -> unset
    phone[po + 8] = 0x01; // security level 1, elevator ref default (matches empty slots)
    phone[po + 9] = 0xff; // floor unset
  }
  applyCards(cards, code, []); // drop every card assigned to this code
  return withPointer(buffers.names, { names, phone, cards });
}

// Removes a directory code entirely, as DoorKing32 does: the names entry and phone record are taken out,
// later entries/records move up, the freed bytes at the end become 0xFF, and the code's cards are removed.
export function removeDirectoryCode(buffers: BoardBuffers, directoryCode: unknown): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  const code = dirCode(names, directoryCode);
  const no = findNamesEntry(names, code);
  if (no < 0) throw err(`No directory entry for code ${code}`, 404);
  const nEnd = directoryEnd(names);
  names.copyWithin(no, no + NAMES_ENTRY_SIZE, nEnd);
  names.fill(0xff, nEnd - NAMES_ENTRY_SIZE, nEnd);
  const po = findPhoneRecord(phone, code);
  if (po >= 0) {
    const pEnd = phoneEnd(phone);
    phone.copyWithin(po, po + PHONE_SIZE, pEnd);
    phone.fill(0xff, pEnd - PHONE_SIZE, pEnd);
  }
  applyCards(cards, code, []);
  return withPointer(buffers.names, { names, phone, cards });
}

// Inserts a new directory code: the names entry goes in DoorKing32's name order and the phone record
// (fields blank, byte 8 = 0x01) in code order; later entries/records move down.
function insertDirectoryCode(buffers: BoardBuffers, code: string, name: string, flag: number): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const nEnd = directoryEnd(names);
  if (nEnd + NAMES_ENTRY_SIZE > names.length || !names.subarray(nEnd, nEnd + NAMES_ENTRY_SIZE).every((b) => b === 0xff)) {
    throw err('No room for another directory entry', 409);
  }
  const group = flag & 0x01 ? 2 : flag === 0 && !name.trim() ? 0 : 1;
  const key = nameKey(name);
  let at = dirStart(names);
  for (; at < nEnd; at += NAMES_ENTRY_SIZE) {
    const g = entryGroup(names, at);
    if (g > group || (g === group && nameKey(names.toString('latin1', at, at + 15)) > key)) break;
  }
  names.copyWithin(at + NAMES_ENTRY_SIZE, at, nEnd);
  names.write(name, at, 15, 'latin1');
  names[at + 15] = flag;
  names.write(code.padStart(4, ' '), at + 16, 4, 'latin1');

  const pEnd = phoneEnd(phone);
  if (pEnd + PHONE_SIZE > phone.length) throw err('No room for another phone record', 409);
  let po = 0;
  for (; po < pEnd; po += PHONE_SIZE) {
    if (phone[po] === 0xff && phone[po + 1] === 0xff) continue;
    if (Number(bcdToStr(phone.subarray(po, po + 2))) > Number(code)) break;
  }
  phone.copyWithin(po + PHONE_SIZE, po, pEnd);
  Buffer.concat([encodeBcd(code, 2), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xff])]).copy(phone, po);
  return { names, phone, cards: buffers.cards };
}

// True when a directory slot is unused: blank name and flag 0x00 (no vendor/shown bits). A hidden resident
// also has flag 0x00 but keeps its name, so the name check is what separates the two.
function isEmptySlot(names: Buffer, offset: number): boolean {
  return names[offset + 15] === 0x00 && names.toString('latin1', offset, offset + 15).trim() === '';
}

// Available (vacant) directory codes that a new resident/vendor can be assigned to.
export function emptySlots(names: Buffer): string[] {
  const out: string[] = [];
  for (let o = dirStart(names); isEntryAt(names, o); o += NAMES_ENTRY_SIZE) {
    if (isEmptySlot(names, o)) out.push(namesEntryCode(names, o)!);
  }
  return out;
}

export interface Duplicate { kind: 'directoryCode' | 'entryCode' | 'card'; value: string; holders: string[]; text: string }

// Values held by more than one entry: a directory code with more than one directory entry or phone record, an entry
// code on more than one phone record, a card number assigned to more than one directory code. Edits refuse to
// create these; this finds them in pulled data (another program may have written them) so the page can show them
// and a send can refuse them.
export function findDuplicates({ names, phone, cards }: BoardBuffers): Duplicate[] {
  const out: Duplicate[] = [];
  const entries = new Map<string, string[]>();
  for (let o = dirStart(names); isEntryAt(names, o); o += NAMES_ENTRY_SIZE) {
    const code = namesEntryCode(names, o)!;
    entries.set(code, [...(entries.get(code) || []), names.toString('latin1', o, o + 15).trim() || '(empty)']);
  }
  const records = new Map<string, number>();
  const entryCodes = new Map<string, string[]>();
  for (let o = 0; o + PHONE_SIZE <= phone.length; o += PHONE_SIZE) {
    if (phone[o] === 0xff && phone[o + 1] === 0xff) continue;
    const code = bcdToStr(phone.subarray(o, o + 2)) || '?';
    records.set(code, (records.get(code) || 0) + 1);
    const entry = phone[o + 6] === 0xff && phone[o + 7] === 0xff ? null : bcdToStr(phone.subarray(o + 6, o + 8));
    if (entry) entryCodes.set(entry, [...(entryCodes.get(entry) || []), holderLabel(names, code)]);
  }
  for (const code of new Set([...entries.keys(), ...records.keys()])) {
    const list = entries.get(code) || [];
    const n = records.get(code) || 0;
    if (list.length < 2 && n < 2) continue;
    const holders = list.length > 1 ? list : [`${n} phone records`];
    out.push({ kind: 'directoryCode', value: code, holders, text: `Directory code ${code} is used ${Math.max(list.length, n)} times (${holders.join('; ')})` });
  }
  for (const [value, holders] of entryCodes) {
    if (holders.length > 1) out.push({ kind: 'entryCode', value, holders, text: `Entry code ${value} is used by ${holders.join(' and ')}` });
  }
  const owners = new Map<string, Set<string>>();
  for (let o = 0; o + CARD_SIZE <= cards.length; o += CARD_SIZE) {
    if (cards.subarray(o, o + CARD_SIZE).every((b) => b === 0xff)) continue;
    const num = String(cards.readUInt16BE(o)).padStart(5, '0');
    owners.set(num, (owners.get(num) || new Set()).add(bcdToStr(cards.subarray(o + 2, o + 4)) || '?'));
  }
  for (const [value, codes] of owners) {
    if (codes.size < 2) continue;
    const holders = [...codes].map((c) => holderLabel(names, c));
    out.push({ kind: 'card', value, holders, text: `Card ${value} is assigned to ${holders.join(' and ')}` });
  }
  return out;
}

// Adds a resident/vendor. A vacant unit code is filled in place; a code that isn't on the gate yet is
// inserted (see insertDirectoryCode). A name is required (an entry with no name is itself the "empty"
// state). Fields are applied via the same encoder used for edits, so the byte layout is identical to the gate's.
export function addEntry(buffers: BoardBuffers, entry: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  const code = dirCode(buffers.names, entry && entry.directoryCode);
  if (!String(entry.name || '').trim()) throw err('A name is required');
  const vendor = Boolean(entry.vendor);
  const hidden = Boolean(entry.hidden);
  const no = findNamesEntry(buffers.names, code);
  let start = buffers;
  if (no >= 0) {
    if (!isEmptySlot(buffers.names, no)) throw err(`Directory code ${code} is already in use`, 409);
  } else {
    if (findPhoneRecord(buffers.phone, code) >= 0) throw err(`Directory code ${code} has a phone record but no directory entry`, 409);
    const name = String(entry.name).slice(0, 15).padEnd(15, ' ');
    start = insertDirectoryCode(buffers, code, name, vendor ? 0x01 : hidden ? 0x00 : 0x20);
  }
  return withPointer(buffers.names, editBuffers(start, { ...entry, directoryCode: code, vendor, hidden }, opts));
}

// Adds a directory code exactly as given, for rebuilding files from stored values: a blank name with neither vendor
// nor shown makes the gate's empty slot (as deleteResident leaves it). Users add through addEntry.
export function addStoredEntry(buffers: BoardBuffers, entry: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  const code = dirCode(buffers.names, entry && entry.directoryCode);
  if (findNamesEntry(buffers.names, code) >= 0 || findPhoneRecord(buffers.phone, code) >= 0) {
    throw err(`Directory code ${code} is already in use`, 409);
  }
  const vendor = Boolean(entry.vendor);
  const hidden = Boolean(entry.hidden);
  const name = String(entry.name ?? '').slice(0, 15).padEnd(15, ' ');
  const start = insertDirectoryCode(buffers, code, name, vendor ? 0x01 : hidden ? 0x00 : 0x20);
  return withPointer(buffers.names, editBuffers(start, { ...entry, directoryCode: code, vendor, hidden }, opts));
}

// Converts names.bin and phone.bin to the given area-code mode (255 or 10), as DoorKing32 does when the
// "Area codes" setting changes (matched against DoorKing32 snapshots):
//   255 -> 10: area codes no phone record uses are dropped and the rest keep their order (at most 10);
//     the table moves from 0xA41 to 0x44, the directory from 0xF80 to 0xC00, and names.bin shrinks by 0x380.
//   10 -> 255: the table moves back to 0xA41 (same indexes), the directory to 0xF80, and names.bin grows by 0x380.
// phone.bin keeps its size; each record's area-code index and number are rewritten in the new layout.
// The middle pointer is kept: it counts from 0xF80 in both modes.
export function convertAreaCodeMode(buffers: BoardBuffers, mode: number): BoardBuffers {
  const to = NAMES_LAYOUTS[mode as 255 | 10];
  if (!to) throw err(`Area-code mode must be 255 or 10 (got ${mode})`);
  const from = namesLayout(buffers.names);
  if (from === to) return { names: Buffer.from(buffers.names), phone: Buffer.from(buffers.phone), cards: buffers.cards };
  const usage = areaCodeUsage(buffers.names, buffers.phone);
  const kept = to.areaCodeMode === 10 ? usage.filter((a) => a.uses) : usage;
  if (kept.length > to.areaCodeSlots) {
    throw err(`The working copy uses ${kept.length} area codes (${kept.map((a) => a.code).join(', ')}). Reduce them to ${to.areaCodeSlots} or fewer first.`, 409);
  }
  const newIndex = new Map(kept.map((a, i) => [a.index, to.areaCodeMode === 10 ? i : a.index]));

  const old = buffers.names;
  const shift = to.directoryOffset - from.directoryOffset;
  const names = Buffer.alloc(old.length + shift, 0xff);
  old.copy(names, 0, 0, NAMES_LAYOUTS[10].directoryOffset);
  old.copy(names, to.directoryOffset, from.directoryOffset);
  names.fill(0xff, from.areaCodeOffset, Math.min(from.areaCodeOffset + from.areaCodeSlots * 2, NAMES_LAYOUTS[10].directoryOffset));
  for (const a of kept) encodeBcd(a.code, 2).copy(names, to.areaCodeOffset + newIndex.get(a.index)! * 2);

  const phone = Buffer.from(buffers.phone);
  const end = phoneEnd(phone);
  for (let po = 0; po + PHONE_SIZE <= end; po += PHONE_SIZE) {
    if (phone[po] === 0xff && phone[po + 1] === 0xff) continue;
    const f = readPhoneFields(phone.subarray(po, po + PHONE_SIZE), from.areaCodeMode);
    const i = f.areaCodeIndex == null ? undefined : newIndex.get(f.areaCodeIndex);
    writePhoneFields(phone, po, { ...f, areaCodeIndex: i == null ? null : i }, to.areaCodeMode);
  }
  return { names, phone, cards: buffers.cards };
}

// Changes "Num of Digits in Dir Code" (1-4), as DoorKing32 does (3 <-> 4 matched against DoorKing32 snapshots):
//   increase: every code in names.bin, phone.bin and cards.bin gets leading zeros (701 -> 0701); order is unchanged.
//   decrease: all resident data is wiped: the directory, area-code table and middle pointer in names.bin, and
//     every phone.bin and cards.bin record become 0xFF. The rest of the names.bin header is kept.
export function convertDirDigits(buffers: BoardBuffers, digitCount: unknown): BoardBuffers {
  const n = Number(digitCount);
  if (![1, 2, 3, 4].includes(n)) throw err('Directory code digits must be 1, 2, 3 or 4');
  const from = namesDirDigits(buffers.names);
  const layout = namesLayout(buffers.names);
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  names[NAMES_DIR_DIGITS_OFFSET] = n;
  if (n > from) {
    const pad = (c: string | null) => '0'.repeat(n - from) + c;
    for (let o = layout.directoryOffset; isEntryAt(names, o); o += NAMES_ENTRY_SIZE) {
      names.write(pad(namesEntryCode(names, o)).padStart(4, ' '), o + 16, 4, 'latin1');
    }
    const end = phoneEnd(phone);
    for (let po = 0; po + PHONE_SIZE <= end; po += PHONE_SIZE) {
      const c = bcdToStr(phone.subarray(po, po + 2));
      if (c) encodeBcd(pad(c), 2).copy(phone, po);
    }
    for (let o = 0; o + CARD_SIZE <= cards.length; o += CARD_SIZE) {
      const c = bcdToStr(cards.subarray(o + 2, o + 4));
      if (c) encodeBcd(pad(c), 2).copy(cards, o + 2);
    }
  } else if (n < from) {
    names.fill(0xff, layout.areaCodeOffset, Math.min(layout.areaCodeOffset + layout.areaCodeSlots * 2, layout.directoryOffset));
    names.fill(0xff, NAMES_MIDDLE_POINTER_OFFSET, NAMES_MIDDLE_POINTER_OFFSET + 3);
    names.fill(0xff, layout.directoryOffset);
    phone.fill(0xff);
    cards.fill(0xff);
  }
  return { names, phone, cards };
}
