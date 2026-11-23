/**
 * @module src/residents-edit
 *
 * Applies resident/vendor edits to the working-copy board buffers (names.bin, phone.bin, cards.bin).
 * Pure: takes and returns Buffers, never touches the gate. Field encodings were all confirmed by
 * isolated before/after gate pulls (see board-files.ts and the decode scoreboard):
 *   names entry (20 bytes): name 0-14 (15, space padded), flag 15 (bit0=vendor, bit5=shown),
 *     directory code 16-19 (right-justified, space padded; 1-4 digits per names.bin 0x40, see namesDirDigits).
 *   phone record (10 bytes): dir code 0-1 (BCD), area-code index + 7-digit local number 2-5 (layout
 *     depends on the area-code mode, see readPhoneFields), entry code 6-7 (BCD),
 *     byte 8 = bits0-4 security | bits5-7 elevator-1, floor 9 (0xFF = unset).
 *   cards record (4 bytes): card number 0-1 (BE), dir code 2-3 (BCD).
 * names.bin and phone.bin layouts follow the area-code mode (255 or 10), detected from names.bin (namesLayout).
 */

import {
  bcd, CARD_RECORD_SIZE, NAMES_DIR_DIGITS_OFFSET, NAMES_ENTRY_SIZE, NAMES_LAYOUTS, NAMES_MIDDLE_POINTER_OFFSET, namesDirDigits, namesEntryCode,
  namesLayout, PHONE_RECORD_SIZE, readPhoneFields, writePhoneFields,
} from './board-files.ts';
import { GATE_SETTING_FIELDS } from './gate-settings.ts';
import { httpError } from './errors.ts';
import { MAX_CARDS_PER_ENTRY } from './shared.ts';

export interface BoardBuffers { names: Buffer; phone: Buffer; cards: Buffer }
/**
 * Fields of a resident edit; only those present are changed (see applyResidentEdit).
 * An edit of one directory code, as sent by the page or API (values are checked when applied); a field left out is
 * left as it is.
 */
export interface ResidentEdit {
  directoryCode?: unknown; name?: unknown; vendor?: unknown; hidden?: unknown; cards?: unknown;
  areaCode?: unknown; phone?: unknown; entryCode?: unknown; securityLevel?: unknown; elevatorRef?: unknown; floor?: unknown;
}
export interface EditOptions { areaCodeSlots?: number }
export interface AreaCodeUse { index: number; code: string | null; uses: number }

const PHONE_FIELDS = ['areaCode', 'phone', 'entryCode', 'securityLevel', 'elevatorRef', 'floor'] as const;
const NAMES_AREA_CODE_SLOTS = 255;

const digits = (text: unknown): string => String(text == null ? '' : text).replace(/\D/g, '');

/**
 * Right-justify decimal digits into nbytes (leading-F padding), matching the bcd() decoder.
 * Empty -> all 0xFF (the "unset" convention the parsers use).
 *
 * @param value - Input value.
 * @param nbytes - `number` value.
 * @returns `Buffer` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function encodeBcd(value: unknown, nbytes: number): Buffer {
  const typed = digits(value);
  if (!typed) return Buffer.alloc(nbytes, 0xff);
  if (typed.length > nbytes * 2) throw httpError(`"${typed}" is too long for ${nbytes * 2} digits`);
  const nibbles = typed.padStart(nbytes * 2, 'f').split('').map((digit) => (digit === 'f' ? 0xf : Number(digit)));
  const out = Buffer.alloc(nbytes);
  for (let i = 0; i < nbytes; i++) out[i] = (nibbles[i * 2] << 4) | nibbles[i * 2 + 1];
  return out;
}


const dirStart = (names: Buffer) => namesLayout(names).directoryOffset;
const phoneMode = (names: Buffer) => namesLayout(names).areaCodeMode;

/**
 * Directory code at the gate's digit count (names.bin 0x40); shorter input gets leading zeros.
 *
 * @param names - Raw `names.bin` buffer.
 * @param value - Input value.
 * @returns `string` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
function dirCode(names: Buffer, value: unknown): string {
  const digitCount = namesDirDigits(names);
  const code = digits(value).padStart(digitCount, '0');
  if (!digits(value) || code.length !== digitCount) throw httpError(`A ${digitCount}-digit directory code is required`);
  return code;
}

/**
 * Find names entry.
 *
 * @param names - Raw `names.bin` buffer.
 * @param code - Directory code, HTTP status code, or verification code.
 * @returns `number` result.
 */
export function findNamesEntry(names: Buffer, code: string | null): number | null {
  for (let offset = dirStart(names); offset + NAMES_ENTRY_SIZE <= names.length; offset += NAMES_ENTRY_SIZE) {
    if (namesEntryCode(names, offset) === code) return offset;
  }
  return null;
}

const isEntryAt = (names: Buffer, offset: number): boolean => namesEntryCode(names, offset) !== null;

/**
 * Offset just past the last directory entry.
 *
 * @param names - Raw `names.bin` buffer.
 * @returns `number` result.
 */
function directoryEnd(names: Buffer): number {
  let offset = dirStart(names);
  while (isEntryAt(names, offset)) offset += NAMES_ENTRY_SIZE;
  return offset;
}

/**
 * Offset just past the last used phone record.
 *
 * @param phone - Gate system phone number (digits or formatted).
 * @returns `number` result.
 */
function phoneEnd(phone: Buffer): number {
  let end = 0;
  for (let offset = 0; offset + PHONE_RECORD_SIZE <= phone.length; offset += PHONE_RECORD_SIZE) if (!(phone[offset] === 0xff && phone[offset + 1] === 0xff)) end = offset + PHONE_RECORD_SIZE;
  return end;
}

/**
 * DoorKing32 order: empty slots, then residents (shown or hidden), then vendors; each by name ignoring case.
 *
 * @param names - Raw `names.bin` buffer.
 * @param offset - Byte offset.
 * @returns `number` result.
 */
const entryGroup = (names: Buffer, offset: number): number => (names[offset + 15] & 0x01 ? 2 : isEmptySlot(names, offset) ? 0 : 1);
const nameKey = (name: string): string => name.toUpperCase();

/**
 * Writes the middle shown-entry pointer at 0xF8-0xFA, as DoorKing32 does on save. Unchanged when nothing is shown.
 * The stored offset always counts from the 255-mode directory start (0xF80).
 *
 * @param names - Raw `names.bin` buffer.
 */
export function updateMiddlePointer(names: Buffer): void {
  const start = dirStart(names);
  const shown: number[] = [];
  for (let offset = start; isEntryAt(names, offset); offset += NAMES_ENTRY_SIZE) if (names[offset + 15] === 0x20) shown.push(offset);
  if (!shown.length) return;
  const offset = shown[Math.floor((shown.length - 1) / 2)] + (NAMES_LAYOUTS[255].directoryOffset - start);
  names[NAMES_MIDDLE_POINTER_OFFSET] = (offset >> 16) & 0xff;
  names[NAMES_MIDDLE_POINTER_OFFSET + 1] = (offset >> 8) & 0xff;
  names[NAMES_MIDDLE_POINTER_OFFSET + 2] = offset & 0xff;
}

/**
 * Recomputes the middle pointer only when the directory itself changed, so other edits leave the header alone.
 *
 * @param before - State or buffer before the change.
 * @param result - Verified operation result.
 * @returns `T` result.
 */
export function withPointer<T extends { names: Buffer }>(before: Buffer, result: T): T {
  const start = dirStart(before);
  const end = Math.max(directoryEnd(before), directoryEnd(result.names));
  if (!before.subarray(start, end).equals(result.names.subarray(start, end))) updateMiddlePointer(result.names);
  return result;
}

/**
 * Find phone record.
 *
 * @param phone - Gate system phone number (digits or formatted).
 * @param code - Directory code, HTTP status code, or verification code.
 * @returns `number` result.
 */
export function findPhoneRecord(phone: Buffer, code: string): number | null {
  for (let offset = 0; offset + PHONE_RECORD_SIZE <= phone.length; offset += PHONE_RECORD_SIZE) {
    if (phone[offset] === 0xff && phone[offset + 1] === 0xff) continue;
    if (bcd(phone.subarray(offset, offset + 2)) === code) return offset;
  }
  return null;
}

/**
 * Area-code slots allowed by the gate's "Area codes" setting ('10 Area Codes' or '255 Area Codes').
 *
 * @param setting - `unknown` value.
 * @returns `number` result.
 */
export const areaCodeLimit = (setting: unknown): number => (/^\s*10\b/.test(String(setting || '')) ? 10 : NAMES_AREA_CODE_SLOTS);

/**
 * Finds the area-code table index for value, appending to the first free slot (below limit) when absent.
 * '' -> 0xFF (none). An area code is 3 digits, or 4 as 1 + area code for long-distance dialing (DoorKing manual:
 * "Alternate Area Code"); the 4-digit form is stored as all 4 BCD digits (1315 -> 13 15).
 *
 * @param names - Raw `names.bin` buffer.
 * @param value - Input value.
 * @param [limit] - Maximum number of rows to return.
 * @returns `number` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function areaCodeIndex(names: Buffer, value: unknown, limit: number = NAMES_AREA_CODE_SLOTS): number {
  const typed = digits(value);
  if (!typed) return 0xff;
  if (!/^(\d{3}|1\d{3})$/.test(typed)) throw httpError(`Area code must be 3 digits, or 4 starting with 1 (got "${typed}")`);
  const { areaCodeOffset, areaCodeSlots } = namesLayout(names);
  const max = Math.min(limit, areaCodeSlots);
  const want = encodeBcd(typed, 2);
  let free = -1;
  for (let i = 0; i < areaCodeSlots; i++) {
    const offset = areaCodeOffset + i * 2;
    if (offset + 2 > names.length) break;
    const rec = names.subarray(offset, offset + 2);
    if (rec.equals(want)) return i;
    if (free < 0 && i < max && rec[0] === 0xff && rec[1] === 0xff) free = i;
  }
  if (free < 0) throw httpError(`No free area-code slots on the gate (limit ${max})`);
  want.copy(names, areaCodeOffset + free * 2);
  return free;
}

/**
 * Each phone record's area-code index (0xFF = none), keyed by phone-record offset (unused records skipped).
 *
 * @param phone - Gate system phone number (digits or formatted).
 * @param [mode] - Operation or layout mode.
 * @returns `[number, number][]` result.
 */
function phoneAreaIndexes(phone: Buffer, mode = 255): [number, number][] {
  const out: [number, number][] = [];
  const end = phoneEnd(phone);
  for (let phoneOffset = 0; phoneOffset + PHONE_RECORD_SIZE <= end; phoneOffset += PHONE_RECORD_SIZE) {
    if (phone[phoneOffset] === 0xff && phone[phoneOffset + 1] === 0xff) continue;
    const i = readPhoneFields(phone.subarray(phoneOffset, phoneOffset + PHONE_RECORD_SIZE), mode).areaCodeIndex;
    out.push([phoneOffset, i == null ? 0xff : i]);
  }
  return out;
}

/**
 * The area-code table with how many phone records use each entry: [{ index, code, uses }].
 *
 * @param names - Raw `names.bin` buffer.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns `AreaCodeUse[]` result.
 */
export function areaCodeUsage(names: Buffer, phone: Buffer): AreaCodeUse[] {
  const { areaCodeOffset, areaCodeSlots, areaCodeMode } = namesLayout(names);
  const uses: Record<number, number> = {};
  for (const [, i] of phoneAreaIndexes(phone, areaCodeMode)) if (i !== 0xff) uses[i] = (uses[i] || 0) + 1;
  const out: AreaCodeUse[] = [];
  for (let i = 0; i < areaCodeSlots; i++) {
    const offset = areaCodeOffset + i * 2;
    if (offset + 2 > names.length) break;
    const rec = names.subarray(offset, offset + 2);
    if (rec[0] === 0xff && rec[1] === 0xff) continue;
    out.push({ index: i, code: bcd(rec), uses: uses[i] || 0 });
  }
  return out;
}

/**
 * Puts the files in the layout DoorKing's software leaves after an edit (verified against a gate edited with it,
 * 2026-11-16): the directory in DoorKing32 order (empty slots, residents, vendors; by name ignoring case; ties and
 * empty slots keep their current order) with the middle pointer recomputed, cards.bin sorted by card number and
 * packed from the first record, and area codes no phone record uses cleared, so their slots are used again. Run after
 * users' edits only: files rebuilt from stored values keep the gate's layout.
 *
 * @param buffers - Board file buffers (`names`, `phone`, `cards`).
 * @returns `BoardBuffers` result.
 */
export function tidyBoard(buffers: BoardBuffers): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const start = dirStart(names);
  const end = directoryEnd(names);
  const entries = [];
  for (let offset = start; offset < end; offset += NAMES_ENTRY_SIZE) {
    entries.push({ group: entryGroup(names, offset), key: nameKey(names.toString('latin1', offset, offset + 15)), bytes: Buffer.from(names.subarray(offset, offset + NAMES_ENTRY_SIZE)) });
  }
  entries.sort((a, b) => a.group - b.group || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  entries.forEach((entry, i) => entry.bytes.copy(names, start + i * NAMES_ENTRY_SIZE));
  updateMiddlePointer(names);

  const recs = [];
  for (let offset = 0; offset + CARD_RECORD_SIZE <= buffers.cards.length; offset += CARD_RECORD_SIZE) {
    const rec = buffers.cards.subarray(offset, offset + CARD_RECORD_SIZE);
    if (!rec.every((byte) => byte === 0xff)) recs.push(Buffer.from(rec));
  }
  recs.sort((a, b) => a.readUInt16BE(0) - b.readUInt16BE(0));
  const cards = Buffer.alloc(buffers.cards.length, 0xff);
  recs.forEach((record, i) => record.copy(cards, i * CARD_RECORD_SIZE));

  const used = new Set(phoneAreaIndexes(buffers.phone, phoneMode(names)).map(([, i]) => i));
  const { areaCodeOffset, areaCodeSlots } = namesLayout(names);
  for (let i = 0; i < areaCodeSlots && areaCodeOffset + i * 2 + 2 <= names.length; i++) {
    if (!used.has(i)) names.fill(0xff, areaCodeOffset + i * 2, areaCodeOffset + i * 2 + 2);
  }
  return { names, phone: buffers.phone, cards };
}

/**
 * "directory code 101 (Smith, J)" for conflict messages; names is optional.
 *
 * @param names - Raw `names.bin` buffer.
 * @param code - Directory code, HTTP status code, or verification code.
 * @returns `string` result.
 */
function holderLabel(names: Buffer | undefined, code: string | null): string {
  const offset = names ? findNamesEntry(names, code) : null;
  const name = offset !== null ? names!.toString('latin1', offset, offset + 15).trim() : '';
  return `directory code ${code}${name ? ` (${name})` : ''}`;
}

/**
 * desired = array of card-number strings. Adds missing ones to free (all-0xFF) slots, clears removed ones.
 * A card number already held by another directory code is refused (409); more than MAX_CARDS_PER_ENTRY cards too,
 * unless the entry already had that many (only removing is then allowed to stay above it).
 *
 * @param cards - Raw `cards.bin` buffer or list of card numbers.
 * @param code - Directory code, HTTP status code, or verification code.
 * @param desired - Map of relay numbers to desired active state (`true` = held open).
 * @param [names] - Raw `names.bin` buffer.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function applyCards(cards: Buffer, code: string, desired: unknown, names?: Buffer): void {
  if (desired != null && !Array.isArray(desired)) throw httpError('Cards must be a list of card numbers');
  const want = new Set((desired || []).map((card) => digits(card)).filter(Boolean).map((card) => String(Number(card)))); // "5" and "00005" are one card
  const have = new Set<string>();
  const free: number[] = [];
  const codeBcd = encodeBcd(code, 2);
  for (let offset = 0; offset + CARD_RECORD_SIZE <= cards.length; offset += CARD_RECORD_SIZE) {
    const rec = cards.subarray(offset, offset + CARD_RECORD_SIZE);
    if (rec.every((byte) => byte === 0xff)) { free.push(offset); continue; }
    if (bcd(rec.subarray(2, 4)) !== code) continue;
    const num = String(rec.readUInt16BE(0));
    if (want.has(num)) {
      have.add(num);
      continue;
    }
    cards.fill(0xff, offset, offset + CARD_RECORD_SIZE); // remove
    free.push(offset);
  }
  if (want.size > MAX_CARDS_PER_ENTRY && [...want].some((card) => !have.has(card))) {
    throw httpError(`A directory code can have at most ${MAX_CARDS_PER_ENTRY} cards (${want.size} given)`);
  }
  for (const cardNumber of want) {
    const num = Number(cardNumber);
    if (have.has(cardNumber)) continue;
    if (num < 1 || num > 65407) throw httpError(`Card number ${cardNumber} is out of range (device codes are 00001-65407)`);
    for (let p = 0; p + CARD_RECORD_SIZE <= cards.length; p += CARD_RECORD_SIZE) {
      if (cards.readUInt16BE(p) !== num || cards.subarray(p, p + CARD_RECORD_SIZE).every((byte) => byte === 0xff)) continue;
      const owner = bcd(cards.subarray(p + 2, p + 4));
      if (owner !== code) throw httpError(`Card ${num} is already assigned to ${holderLabel(names, owner)}`, 409);
    }
    const offset = free.shift();
    if (offset == null) throw httpError('No free card slots on the gate');
    cards.writeUInt16BE(num, offset);
    codeBcd.copy(cards, offset + 2);
  }
}

/**
 * edit: { directoryCode (required), name, hidden, vendor, areaCode, phone, entryCode, securityLevel,
 *   elevatorRef, floor, cards[] }. Only provided fields are changed. Returns new buffers.
 * opts.areaCodeSlots limits where a new area code may go (see areaCodeLimit).
 * A name typed by a user: refused (400) when it has a character the files can't hold (one byte each, plain ASCII
 * 0x20-0x7E; "Œ" would otherwise be stored as "R"). Names already on the gate aren't checked.
 *
 * @param name - Display name or filename.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkName(name: unknown): void {
  const bad = [...String(name ?? '')].find((char) => char < ' ' || char > '~');
  if (bad) throw httpError(`Names can use only plain letters, digits, spaces and punctuation ("${bad}" can't be stored on the gate)`);
}

/**
 * Apply resident edit.
 *
 * @param buffers - Board file buffers (`names`, `phone`, `cards`).
 * @param edit - `ResidentEdit` value.
 * @param [opts] - Optional settings.
 * @returns `BoardBuffers` result.
 */
export function applyResidentEdit(buffers: BoardBuffers, edit: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  return withPointer(buffers.names, editBuffers(buffers, edit, opts));
}

function editBuffers(buffers: BoardBuffers, edit: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  const names = Buffer.from(buffers.names);
  let phone: Buffer = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  const code = dirCode(names, edit.directoryCode);
  const entry = findNamesEntry(names, code);
  if (entry === null) throw httpError(`No directory entry for code ${code}`, 404);
  if ('name' in edit) names.write(String(edit.name ?? '').slice(0, 15).padEnd(15, ' '), entry, 15, 'latin1');
  if ('vendor' in edit || 'hidden' in edit) names[entry + 15] = editedFlag(names[entry + 15], edit);
  let phoneOffset = findPhoneRecord(phone, code);
  const phoneValueGiven = PHONE_FIELDS.some((key) => key in edit && String(edit[key] ?? '') !== '');
  if (phoneOffset === null && !phoneValueGiven) {
    if ('cards' in edit) applyCards(cards, code, edit.cards, names);
    return { names, phone, cards };
  }
  if (phoneOffset === null) {
    phone = insertPhoneRecord(phone, code);
    phoneOffset = findPhoneRecord(phone, code)!;
  }
  if ('areaCode' in edit || 'phone' in edit) editPhoneNumber(names, phone, phoneOffset, edit, opts);
  if ('entryCode' in edit) editEntryCode(names, phone, phoneOffset, edit.entryCode);
  if ('securityLevel' in edit) phone[phoneOffset + 8] = (phone[phoneOffset + 8] & ~0x1f) | securityLevelOf(edit.securityLevel);
  if ('elevatorRef' in edit) phone[phoneOffset + 8] = (phone[phoneOffset + 8] & 0x1f) | ((elevatorRefOf(edit.elevatorRef) - 1) << 5);
  if ('floor' in edit) phone[phoneOffset + 9] = floorByteOf(edit.floor);
  if ('cards' in edit) applyCards(cards, code, edit.cards, names);
  return { names, phone, cards };
}

/**
 * The names entry flag byte with vendor (bit 0) and shown (bit 5) as edited: hidden clears bit 5, and vendors are never
 * shown, so it stays clear for them.
 *
 * @param flag - `number` value.
 * @param edit - `ResidentEdit` value.
 * @returns `number` result.
 */
function editedFlag(flag: number, edit: ResidentEdit): number {
  const withVendor = 'vendor' in edit ? (edit.vendor ? flag | 0x01 : flag & ~0x01) : flag;
  if (!('hidden' in edit)) return withVendor;
  const vendor = 'vendor' in edit ? edit.vendor : withVendor & 0x01;
  return edit.hidden || vendor ? withVendor & ~0x20 : withVendor | 0x20;
}

function editPhoneNumber(names: Buffer, phone: Buffer, phoneOffset: number, edit: ResidentEdit, opts: EditOptions): void {
  const mode = phoneMode(names);
  const fields = readPhoneFields(phone.subarray(phoneOffset, phoneOffset + PHONE_RECORD_SIZE), mode);
  if ('areaCode' in edit) {
    const index = areaCodeIndex(names, edit.areaCode, opts.areaCodeSlots);
    fields.areaCodeIndex = index === 0xff ? null : index;
  }
  if ('phone' in edit) fields.phone = localNumberOf(edit.phone);
  writePhoneFields(phone, phoneOffset, fields, mode);
}

function localNumberOf(value: unknown): string | null {
  const number = digits(value);
  if (number.length > 7) throw httpError('Phone number is the 7-digit local number (area code is separate)');
  return number ? number.padStart(7, '0') : null;
}

/**
 * Sets the entry code; a code another record already has is refused (409).
 *
 * @param names - Raw `names.bin` buffer.
 * @param phone - Gate system phone number (digits or formatted).
 * @param phoneOffset - `number` value.
 * @param entryCode - `unknown` value.
 * @throws HTTP 400 error on invalid input or conflict.
 */
function editEntryCode(names: Buffer, phone: Buffer, phoneOffset: number, entryCode: unknown): void {
  const bytes = encodeBcd(entryCode, 2);
  const changed = !bytes.equals(phone.subarray(phoneOffset + 6, phoneOffset + 8)) && digits(entryCode);
  const holder = changed ? entryCodeHolder(phone, bytes, phoneOffset) : null;
  if (holder !== null) {
    throw httpError(`Entry code ${digits(entryCode)} is already used by ${holderLabel(names, bcd(phone.subarray(holder, holder + 2)))}`, 409);
  }
  bytes.copy(phone, phoneOffset + 6);
}

/** Offset of another phone record with this entry code, or `null`. */
function entryCodeHolder(phone: Buffer, bytes: Buffer, skipOffset: number): number | null {
  for (let offset = 0; offset + PHONE_RECORD_SIZE <= phone.length; offset += PHONE_RECORD_SIZE) {
    const blank = phone[offset] === 0xff && phone[offset + 1] === 0xff;
    if (offset !== skipOffset && !blank && bytes.equals(phone.subarray(offset + 6, offset + 8))) return offset;
  }
  return null;
}

function securityLevelOf(value: unknown): number {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 0 || level > 30) throw httpError('Security level must be 0-30');
  return level;
}

function elevatorRefOf(value: unknown): number {
  const ref = Number(value);
  if (!Number.isInteger(ref) || ref < 1 || ref > 8) throw httpError('Elevator reference must be 1-8');
  return ref;
}

/**
 * Floor 1-64, or 0xFF for none (blank).
 *
 * @param value - Input value.
 * @returns `number` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
function floorByteOf(value: unknown): number {
  if (value === '' || value == null) return 0xff;
  const floor = Number(value);
  if (!Number.isInteger(floor) || floor < 1 || floor > 64) throw httpError('Floor must be 1-64 or blank');
  return floor;
}

/**
 * Sets whether a directory code is shown in the entry-panel directory: a resident is shown only with a name and a
 * phone number; a vendor never is. Applied to users' adds and edits, not to rebuilds from stored values.
 *
 * @param buffers - Board file buffers (`names`, `phone`, `cards`).
 * @param directoryCode - Directory code (with or without leading zeros).
 * @returns `BoardBuffers` result.
 */
export function applyShownRule(buffers: BoardBuffers, directoryCode: string): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const code = dirCode(names, directoryCode);
  const entry = findNamesEntry(names, code);
  const phoneOffset = findPhoneRecord(buffers.phone, code);
  if (entry === null || phoneOffset === null) return buffers;
  const { phone } = readPhoneFields(buffers.phone.subarray(phoneOffset, phoneOffset + PHONE_RECORD_SIZE), phoneMode(names));
  const shown = !(names[entry + 15] & 0x01) && names.toString('latin1', entry, entry + 15).trim() !== '' && phone != null;
  names[entry + 15] = shown ? names[entry + 15] | 0x20 : names[entry + 15] & ~0x20;
  return withPointer(buffers.names, { ...buffers, names });
}

export function deleteResident(buffers: BoardBuffers, directoryCode: string): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  const code = dirCode(names, directoryCode);
  const entry = findNamesEntry(names, code);
  if (entry === null) throw httpError(`No directory entry for code ${code}`, 404);
  names.fill(0x20, entry, entry + 15);
  names[entry + 15] = 0x00;
  const phoneOffset = findPhoneRecord(phone, code);
  if (phoneOffset !== null) {
    phone.fill(0xff, phoneOffset + 2, phoneOffset + 8);
    phone[phoneOffset + 8] = 0x01;
    phone[phoneOffset + 9] = 0xff;
  }
  applyCards(cards, code, []);
  return withPointer(buffers.names, { names, phone, cards });
}

export function removeDirectoryCode(buffers: BoardBuffers, directoryCode: string): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  const code = dirCode(names, directoryCode);
  const entry = findNamesEntry(names, code);
  if (entry === null) throw httpError(`No directory entry for code ${code}`, 404);
  const namesEnd = directoryEnd(names);
  names.copyWithin(entry, entry + NAMES_ENTRY_SIZE, namesEnd);
  names.fill(0xff, namesEnd - NAMES_ENTRY_SIZE, namesEnd);
  const phoneOffset = findPhoneRecord(phone, code);
  if (phoneOffset !== null) {
    const recordsEnd = phoneEnd(phone);
    phone.copyWithin(phoneOffset, phoneOffset + PHONE_RECORD_SIZE, recordsEnd);
    phone.fill(0xff, recordsEnd - PHONE_RECORD_SIZE, recordsEnd);
  }
  applyCards(cards, code, []);
  return withPointer(buffers.names, { names, phone, cards });
}

function memoryEntries(names: Buffer): number | null {
  const field = SYSTEM_MEMORY;
  const decoded = field ? field.type.decode(names.subarray(field.offset, field.offset + field.type.size)) : '';
  return /^\d+$/.test(decoded) ? Number(decoded) : null;
}
const SYSTEM_MEMORY = GATE_SETTING_FIELDS.find((field) => field.key === 'systemMemory');

/**
 * Inserts a new directory code: the names entry goes in DoorKing32's name order and the phone record
 * (fields blank, byte 8 = 0x01) in code order; later entries/records move down. Refused when the directory already
 * holds as many codes as the gate's System memory.
 *
 * @param buffers - Board file buffers (`names`, `phone`, `cards`).
 * @param code - Directory code, HTTP status code, or verification code.
 * @param name - Display name or filename.
 * @param flag - `number` value.
 * @returns `BoardBuffers` result.
 * @throws HTTP 400/409 error on invalid input or conflict.
 */
function insertDirectoryCode(buffers: BoardBuffers, code: string, name: string, flag: number): BoardBuffers {
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const nEnd = directoryEnd(names);
  const memory = memoryEntries(names);
  if (memory !== null && (nEnd - dirStart(names)) / NAMES_ENTRY_SIZE >= memory) {
    throw httpError(`The gate's memory holds ${memory} directory codes (System memory), and all are used. Remove one first.`, 409);
  }
  if (nEnd + NAMES_ENTRY_SIZE > names.length || !names.subarray(nEnd, nEnd + NAMES_ENTRY_SIZE).every((byte) => byte === 0xff)) {
    throw httpError('No room for another directory entry', 409);
  }
  const group = flag & 0x01 ? 2 : flag === 0 && !name.trim() ? 0 : 1;
  const key = nameKey(name);
  let at = dirStart(names);
  for (; at < nEnd; at += NAMES_ENTRY_SIZE) {
    const entryGroupAt = entryGroup(names, at);
    if (entryGroupAt > group || (entryGroupAt === group && nameKey(names.toString('latin1', at, at + 15)) > key)) break;
  }
  names.copyWithin(at + NAMES_ENTRY_SIZE, at, nEnd);
  names.write(name, at, 15, 'latin1');
  names[at + 15] = flag;
  names.write(code.padStart(4, ' '), at + 16, 4, 'latin1');

  return { names, phone: insertPhoneRecord(phone, code), cards: buffers.cards };
}

/**
 * A copy of phone.bin with a blank record for code (fields blank, byte 8 = 0x01) in code order; later records move down.
 *
 * @param buf - Binary board file buffer.
 * @param code - Directory code, HTTP status code, or verification code.
 * @returns `Buffer` result.
 * @throws HTTP 409 error on invalid input or conflict.
 */
function insertPhoneRecord(buf: Buffer, code: string): Buffer {
  const phone = Buffer.from(buf);
  const pEnd = phoneEnd(phone);
  if (pEnd + PHONE_RECORD_SIZE > phone.length) throw httpError('No room for another phone record', 409);
  let phoneOffset = 0;
  for (; phoneOffset < pEnd; phoneOffset += PHONE_RECORD_SIZE) {
    if (phone[phoneOffset] === 0xff && phone[phoneOffset + 1] === 0xff) continue;
    if (Number(bcd(phone.subarray(phoneOffset, phoneOffset + 2))) > Number(code)) break;
  }
  phone.copyWithin(phoneOffset + PHONE_RECORD_SIZE, phoneOffset, pEnd);
  Buffer.concat([encodeBcd(code, 2), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xff])]).copy(phone, phoneOffset);
  return phone;
}

/**
 * True when a directory slot is unused: blank name and flag 0x00 (no vendor/shown bits). A hidden resident
 * also has flag 0x00 but keeps its name, so the name check is what separates the two.
 *
 * @param names - Raw `names.bin` buffer.
 * @param offset - Byte offset.
 * @returns True when the condition holds.
 */
function isEmptySlot(names: Buffer, offset: number): boolean {
  return names[offset + 15] === 0x00 && names.toString('latin1', offset, offset + 15).trim() === '';
}

/**
 * Available (vacant) directory codes that a new resident/vendor can be assigned to.
 *
 * @param names - Raw `names.bin` buffer.
 * @returns `string[]` result.
 */
export function emptySlots(names: Buffer): string[] {
  const out: string[] = [];
  for (let offset = dirStart(names); isEntryAt(names, offset); offset += NAMES_ENTRY_SIZE) {
    if (isEmptySlot(names, offset)) out.push(namesEntryCode(names, offset)!);
  }
  return out;
}

export interface Duplicate { kind: 'directoryCode' | 'entryCode' | 'card'; value: string; holders: string[]; text: string }

/**
 * Values held by more than one entry: a directory code with more than one directory entry or phone record, an entry
 * code on more than one phone record, a card number assigned to more than one directory code. Edits refuse to
 * create these; this finds them in pulled data (another program may have written them) so the page can show them
 * and a send can refuse them.
 *
 * @param options - Options object.
 * @param options.names - Raw `names.bin` buffer.
 * @param options.phone - Gate system phone number (digits or formatted).
 * @param options.cards - Raw `cards.bin` buffer or list of card numbers.
 * @returns `Duplicate[]` result.
 */
export function findDuplicates({ names, phone, cards }: BoardBuffers): Duplicate[] {
  const out: Duplicate[] = [];
  const entries = new Map<string, string[]>();
  for (let offset = dirStart(names); isEntryAt(names, offset); offset += NAMES_ENTRY_SIZE) {
    const code = namesEntryCode(names, offset)!;
    entries.set(code, [...(entries.get(code) || []), names.toString('latin1', offset, offset + 15).trim() || '(empty)']);
  }
  const records = new Map<string, number>();
  const entryCodes = new Map<string, string[]>();
  for (let offset = 0; offset + PHONE_RECORD_SIZE <= phone.length; offset += PHONE_RECORD_SIZE) {
    if (phone[offset] === 0xff && phone[offset + 1] === 0xff) continue;
    const code = bcd(phone.subarray(offset, offset + 2)) || '?';
    records.set(code, (records.get(code) || 0) + 1);
    const entry = phone[offset + 6] === 0xff && phone[offset + 7] === 0xff ? null : bcd(phone.subarray(offset + 6, offset + 8));
    if (entry) entryCodes.set(entry, [...(entryCodes.get(entry) || []), holderLabel(names, code)]);
  }
  for (const code of new Set([...entries.keys(), ...records.keys()])) {
    const list = entries.get(code) || [];
    const recordCount = records.get(code) || 0;
    if (list.length < 2 && recordCount < 2) continue;
    const holders = list.length > 1 ? list : [`${recordCount} phone records`];
    out.push({ kind: 'directoryCode', value: code, holders, text: `Directory code ${code} is used ${Math.max(list.length, recordCount)} times (${holders.join('; ')})` });
  }
  for (const [value, holders] of entryCodes) {
    if (holders.length > 1) out.push({ kind: 'entryCode', value, holders, text: `Entry code ${value} is used by ${holders.join(' and ')}` });
  }
  const owners = new Map<string, Set<string>>();
  for (let offset = 0; offset + CARD_RECORD_SIZE <= cards.length; offset += CARD_RECORD_SIZE) {
    if (cards.subarray(offset, offset + CARD_RECORD_SIZE).every((byte) => byte === 0xff)) continue;
    const num = String(cards.readUInt16BE(offset)).padStart(5, '0');
    owners.set(num, (owners.get(num) || new Set()).add(bcd(cards.subarray(offset + 2, offset + 4)) || '?'));
  }
  for (const [value, codes] of owners) {
    if (codes.size < 2) continue;
    const holders = [...codes].map((code) => holderLabel(names, code));
    out.push({ kind: 'card', value, holders, text: `Card ${value} is assigned to ${holders.join(' and ')}` });
  }
  return out;
}

/**
 * Adds a resident/vendor. A vacant unit code is filled in place; a code that isn't on the gate yet is
 * inserted (see insertDirectoryCode). A name is required (an entry with no name is itself the "empty"
 * state). Fields are applied via the same encoder used for edits, so the byte layout is identical to the gate's.
 *
 * @param buffers - Board file buffers (`names`, `phone`, `cards`).
 * @param entry - Resident/vendor entry data or history entry.
 * @param [opts] - Optional settings.
 * @returns `BoardBuffers` result.
 * @throws HTTP 400/409 error on invalid input or conflict.
 */
export function addEntry(buffers: BoardBuffers, entry: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  const code = dirCode(buffers.names, entry && entry.directoryCode);
  if (!String(entry.name || '').trim()) throw httpError('A name is required');
  const slot = findNamesEntry(buffers.names, code);
  if (slot !== null && !isEmptySlot(buffers.names, slot)) throw httpError(`Directory code ${code} is already in use`, 409);
  if (slot === null && findPhoneRecord(buffers.phone, code) !== null) throw httpError(`Directory code ${code} has a phone record but no directory entry`, 409);
  return placeEntry(buffers, code, entry, opts, slot === null);
}

function placeEntry(buffers: BoardBuffers, code: string, entry: ResidentEdit, opts: EditOptions, insert: boolean): BoardBuffers {
  const vendor = Boolean(entry.vendor);
  const hidden = Boolean(entry.hidden);
  const name = String(entry.name ?? '').slice(0, 15).padEnd(15, ' ');
  const start = insert ? insertDirectoryCode(buffers, code, name, vendor ? 0x01 : hidden ? 0x00 : 0x20) : buffers;
  return withPointer(buffers.names, editBuffers(start, { ...entry, directoryCode: code, vendor, hidden }, opts));
}

export function addStoredEntry(buffers: BoardBuffers, entry: ResidentEdit, opts: EditOptions = {}): BoardBuffers {
  const code = dirCode(buffers.names, entry && entry.directoryCode);
  if (findNamesEntry(buffers.names, code) !== null || findPhoneRecord(buffers.phone, code) !== null) {
    throw httpError(`Directory code ${code} is already in use`, 409);
  }
  return placeEntry(buffers, code, entry, opts, true);
}

/**
 * Converts names.bin and phone.bin to the given area-code mode (255 or 10), as DoorKing32 does when the
 * "Area codes" setting changes (matched against DoorKing32 snapshots):
 *   255 -> 10: area codes no phone record uses are dropped and the rest keep their order (at most 10);
 *     the table moves from 0xA41 to 0x44, the directory from 0xF80 to 0xC00, and names.bin shrinks by 0x380.
 *   10 -> 255: the table moves back to 0xA41 (same indexes), the directory to 0xF80, and names.bin grows by 0x380.
 * phone.bin keeps its size; each record's area-code index and number are rewritten in the new layout.
 * The middle pointer is kept: it counts from 0xF80 in both modes.
 *
 * @param buffers - Board file buffers (`names`, `phone`, `cards`).
 * @param mode - Operation or layout mode.
 * @returns `BoardBuffers` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function convertAreaCodeMode(buffers: BoardBuffers, mode: number): BoardBuffers {
  const to = NAMES_LAYOUTS[mode as 255 | 10];
  if (!to) throw httpError(`Area-code mode must be 255 or 10 (got ${mode})`);
  const from = namesLayout(buffers.names);
  if (from === to) return { names: Buffer.from(buffers.names), phone: Buffer.from(buffers.phone), cards: buffers.cards };
  const usage = areaCodeUsage(buffers.names, buffers.phone);
  const kept = to.areaCodeMode === 10 ? usage.filter((areaCode) => areaCode.uses) : usage;
  if (kept.length > to.areaCodeSlots) {
    throw httpError(`The working copy uses ${kept.length} area codes (${kept.map((areaCode) => areaCode.code).join(', ')}). Reduce them to ${to.areaCodeSlots} or fewer first.`, 409);
  }
  const newIndex = new Map(kept.map((areaCode, i) => [areaCode.index, to.areaCodeMode === 10 ? i : areaCode.index]));

  const old = buffers.names;
  const shift = to.directoryOffset - from.directoryOffset;
  const names = Buffer.alloc(old.length + shift, 0xff);
  old.copy(names, 0, 0, NAMES_LAYOUTS[10].directoryOffset);
  old.copy(names, to.directoryOffset, from.directoryOffset);
  names.fill(0xff, from.areaCodeOffset, Math.min(from.areaCodeOffset + from.areaCodeSlots * 2, NAMES_LAYOUTS[10].directoryOffset));
  for (const areaCode of kept) encodeBcd(areaCode.code, 2).copy(names, to.areaCodeOffset + newIndex.get(areaCode.index)! * 2);

  const phone = Buffer.from(buffers.phone);
  const end = phoneEnd(phone);
  for (let phoneOffset = 0; phoneOffset + PHONE_RECORD_SIZE <= end; phoneOffset += PHONE_RECORD_SIZE) {
    if (phone[phoneOffset] === 0xff && phone[phoneOffset + 1] === 0xff) continue;
    const fields = readPhoneFields(phone.subarray(phoneOffset, phoneOffset + PHONE_RECORD_SIZE), from.areaCodeMode);
    const i = fields.areaCodeIndex == null ? undefined : newIndex.get(fields.areaCodeIndex);
    writePhoneFields(phone, phoneOffset, { ...fields, areaCodeIndex: i == null ? null : i }, to.areaCodeMode);
  }
  return { names, phone, cards: buffers.cards };
}

/**
 * Changes "Num of Digits in Dir Code" (1-4), as DoorKing32 does (3 <-> 4 matched against DoorKing32 snapshots):
 *   increase: every code in names.bin, phone.bin and cards.bin gets leading zeros (701 -> 0701); order is unchanged.
 *   decrease: all resident data is wiped: the directory, area-code table and middle pointer in names.bin, and
 *     every phone.bin and cards.bin record become 0xFF. The rest of the names.bin header is kept.
 *
 * @param buffers - Board file buffers (`names`, `phone`, `cards`).
 * @param digitCount - `unknown` value.
 * @returns `BoardBuffers` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function convertDirDigits(buffers: BoardBuffers, digitCount: unknown): BoardBuffers {
  const count = Number(digitCount);
  if (![1, 2, 3, 4].includes(count)) throw httpError('Directory code count must be 1, 2, 3 or 4');
  const from = namesDirDigits(buffers.names);
  const layout = namesLayout(buffers.names);
  const names = Buffer.from(buffers.names);
  const phone = Buffer.from(buffers.phone);
  const cards = Buffer.from(buffers.cards);
  names[NAMES_DIR_DIGITS_OFFSET] = count;
  if (count < from) {
    names.fill(0xff, layout.areaCodeOffset, Math.min(layout.areaCodeOffset + layout.areaCodeSlots * 2, layout.directoryOffset));
    names.fill(0xff, NAMES_MIDDLE_POINTER_OFFSET, NAMES_MIDDLE_POINTER_OFFSET + 3);
    names.fill(0xff, layout.directoryOffset);
    phone.fill(0xff);
    cards.fill(0xff);
  }
  if (count > from) {
    const pad = (code: string | null) => '0'.repeat(count - from) + code;
    for (let offset = layout.directoryOffset; isEntryAt(names, offset); offset += NAMES_ENTRY_SIZE) {
      names.write(pad(namesEntryCode(names, offset)).padStart(4, ' '), offset + 16, 4, 'latin1');
    }
    const end = phoneEnd(phone);
    for (let phoneOffset = 0; phoneOffset + PHONE_RECORD_SIZE <= end; phoneOffset += PHONE_RECORD_SIZE) {
      const code = bcd(phone.subarray(phoneOffset, phoneOffset + 2));
      if (code) encodeBcd(pad(code), 2).copy(phone, phoneOffset);
    }
    for (let offset = 0; offset + CARD_RECORD_SIZE <= cards.length; offset += CARD_RECORD_SIZE) {
      const code = bcd(cards.subarray(offset + 2, offset + 4));
      if (code) encodeBcd(pad(code), 2).copy(cards, offset + 2);
    }
  }
  return { names, phone, cards };
}
