/**
 * @module src/phone
 *
 * North American phone parsing and display formatting shared by the server and browser UI (no Node imports).
 */

export interface NanpPhoneParts {
  areaCode: string;
  phone: string;
}

/**
 * Parses a 7-, 10-, or 11-digit (leading `1`) North American phone number into DoorKing board fields (`areaCode` + 7-digit
 * local `phone`). Returns `null` when the digit count is not a valid NANP number.
 *
 * @param raw - Raw phone string (digits, formatted, or `+1` E.164).
 * @param [options] - `{ keepLeadingOne?: boolean }`: keep leading `1` in `areaCode` (4-digit DoorKing long-distance code).
 * @returns `{ areaCode, phone } | null`.
 */
export function parseNanpPhone(raw: string, { keepLeadingOne = false }: { keepLeadingOne?: boolean } = {}): NanpPhoneParts | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    return { areaCode: keepLeadingOne ? digits.slice(0, 4) : digits.slice(1, 4), phone: digits.slice(4) };
  }
  if (digits.length === 10) return { areaCode: digits.slice(0, 3), phone: digits.slice(3) };
  if (digits.length === 7) return { areaCode: '', phone: digits };
  return null;
}

/**
 * Formats 7-, 10-, or 11-digit North American phone numbers cleanly (`(214) 555-0142` or `555-0142`).
 *
 * @param raw - Raw phone string.
 * @returns Formatted phone string.
 */
export function fmtPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return raw;
}
