/**
 * @module src/entry-codes
 *
 * Safe 4-digit keypad entry code generation and copy-paste resident welcome message formatting (no Node imports).
 */
import { fmtPhone } from './phone.ts';

const WEAK_ENTRY_CODES = new Set(['0001', '1000', '2000', '2580', '0852', '1999', '1230', '4321', '1357', '2468']);

/**
 * True when a 4-digit entry code is considered weak/predictable (all same digit, sequential run, repeated pair,
 * year 2000–2035, or common keypad column pattern).
 *
 * @param code - 4-digit string.
 * @returns True if the code should be avoided when auto-generating.
 */
export function isWeakEntryCode(code: string): boolean {
  if (!/^\d{4}$/.test(code)) return true;
  if (WEAK_ENTRY_CODES.has(code)) return true;
  if (code[0] === code[1] && code[1] === code[2] && code[2] === code[3]) return true;
  if (code.slice(0, 2) === code.slice(2)) return true;
  if (code[0] === code[1] && code[2] === code[3]) return true;
  if (code[0] === code[3] && code[1] === code[2]) return true;
  const digits = [...code].map(Number);
  const ascending = digits[1] === digits[0] + 1 && digits[2] === digits[1] + 1 && digits[3] === digits[2] + 1;
  const descending = digits[1] === digits[0] - 1 && digits[2] === digits[1] - 1 && digits[3] === digits[2] - 1;
  if (ascending || descending) return true;
  const numeric = Number(code);
  return numeric >= 2000 && numeric <= 2035;
}

/**
 * Generates a cryptographically random 4-digit entry code that does not collide with `usedCodes` and avoids
 * trivial/predictable patterns.
 *
 * @param usedCodes - Existing entry codes (and optionally directory codes) to avoid.
 * @returns Non-colliding 4-digit entry code string.
 */
export function generateSafeEntryCode(usedCodes: Iterable<string>): string {
  const taken = new Set<string>();
  for (const raw of usedCodes) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits) taken.add(digits.padStart(4, '0'));
  }
  const buf = new Uint32Array(1);
  for (let attempt = 0; attempt < 500; attempt++) {
    globalThis.crypto.getRandomValues(buf);
    const candidate = String(buf[0] % 10000).padStart(4, '0');
    if (!taken.has(candidate) && !isWeakEntryCode(candidate)) return candidate;
  }
  for (let n = 0; n < 10000; n++) {
    const candidate = String(n).padStart(4, '0');
    if (!taken.has(candidate) && !isWeakEntryCode(candidate)) return candidate;
  }
  for (let n = 0; n < 10000; n++) {
    const candidate = String(n).padStart(4, '0');
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('No unused 4-digit entry codes remain.');
}

export interface WelcomeMessageInput {
  siteName?: string;
  residentName?: string;
  directoryCode?: string;
  entryCode?: string;
  grantAccessDigit?: string;
  adminPhone?: string;
  hidden?: boolean;
  cards?: string[];
}

/**
 * Builds a copy-paste-ready resident welcome message explaining directory calling, touch-tone grant access,
 * keypad entry code, assigned remotes/cards, and manager contact info.
 *
 * @param info - Resident and gate information.
 * @returns Plain-text welcome message ready for email or SMS.
 */
export function buildWelcomeMessage(info: WelcomeMessageInput): string {
  const site = (info.siteName || '').trim() || 'our community';
  const greeting = (info.residentName || '').trim() ? `Hi ${info.residentName!.trim()},` : 'Hello,';
  const dirCode = (info.directoryCode || '').trim();
  const entryCode = (info.entryCode || '').trim();
  const grantDigit = (info.grantAccessDigit || '9').trim() || '9';
  const adminPhone = (info.adminPhone || '').trim();
  const cards = (info.cards || []).map((card) => String(card).trim()).filter(Boolean);

  const lines: string[] = [greeting, '', `Here are your gate access instructions for ${site}:`, ''];
  if (dirCode) {
    lines.push(`• Directory Code: ${dirCode}${info.hidden ? ' (unlisted — visitors must dial your code directly)' : ''}`);
    lines.push(`  Visitors can dial ${dirCode} at the call box (or look up your name) to ring your phone. Press ${grantDigit} to open the gate.`);
  }
  if (entryCode) {
    lines.push(`• Personal Entry Code: #${entryCode}`);
    lines.push(`  Enter # followed by ${entryCode} on the keypad to open the gate without a remote.`);
  }
  if (cards.length) {
    lines.push(`• Assigned Remote / Card Number${cards.length === 1 ? '' : 's'}: ${cards.join(', ')}`);
  }
  lines.push('');
  lines.push(adminPhone
    ? `Questions or need to update your phone number or remotes? Contact management at ${fmtPhone(adminPhone)}.`
    : 'Questions or need to update your phone number or remotes? Contact community management.');
  return lines.join('\n');
}
