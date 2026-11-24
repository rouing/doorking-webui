/**
 * @module lib/shared
 *
 * Browser-only UI helpers, formatting utilities, and DoorKing constants (zero backend imports).
 */
import type { CameraSettings, DeviceRange, GateConfig, ResidentPortalPrefs, ScheduleAction } from '../types.ts';

export const PASSWORD_MIN = 12;
export const NOTE_MAX = 500;
export const MAX_CARDS_PER_ENTRY = 25;
export const GATE_CONFIG_KEYS: (keyof GateConfig)[] = ['siteName', 'memorySize', 'areaCodes', 'modelNumber', 'antiPassBack', 'interface1816'];
export const SCHEDULE_ACTIONS: ScheduleAction[] = ['send', 'residents', 'transactions', 'snapshots'];
export const DEFAULT_DEVICE_ASSOCIATION: DeviceRange[] = [{ name: 'Cards', from: '00001', to: '65407' }];

export const DEFAULT_RESIDENT_PORTAL_PREFS: ResidentPortalPrefs = {
  enabled: false,
  buzzEnabled: false,
  buzzRelays: [0],
  pulseSeconds: 4,
  maxRerollsPerDay: 2,
  autoSendReroll: false,
  showSnapshots: false,
  allowRequests: true,
  requirePasskeyForBuzz: false,
};

export function deviceNameFor(rows: DeviceRange[] | null | undefined, card: number | string): string {
  const number = Number(card);
  const device = (rows || []).find((range) => number >= Number(range.from) && number <= Number(range.to));
  return device ? device.name : '';
}

export interface NanpPhoneParts { areaCode: string; phone: string }

export function parseNanpPhone(raw: string, { keepLeadingOne = false }: { keepLeadingOne?: boolean } = {}): NanpPhoneParts | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    return { areaCode: keepLeadingOne ? digits.slice(0, 4) : digits.slice(1, 4), phone: digits.slice(4) };
  }
  if (digits.length === 10) return { areaCode: digits.slice(0, 3), phone: digits.slice(3) };
  if (digits.length === 7) return { areaCode: '', phone: digits };
  return null;
}

export function fmtPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return raw;
}

const WEAK_ENTRY_CODES = new Set(['0001', '1000', '2000', '2580', '0852', '1999', '1230', '4321', '1357', '2468']);

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

export interface Holiday { name: string; month: number; day: number }

export const FIXED_HOLIDAYS: Holiday[] = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: 'Valentine’s Day', month: 2, day: 14 },
  { name: "St. Patrick's Day", month: 3, day: 17 },
  { name: 'Juneteenth', month: 6, day: 19 },
  { name: 'Independence Day', month: 7, day: 4 },
  { name: 'Halloween', month: 10, day: 31 },
  { name: 'Veterans Day', month: 11, day: 11 },
  { name: 'Christmas Eve', month: 12, day: 24 },
  { name: 'Christmas Day', month: 12, day: 25 },
  { name: "New Year's Eve", month: 12, day: 31 },
];

function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  const diff = (last.getUTCDay() - weekday + 7) % 7;
  return last.getUTCDate() - diff;
}

export function usHolidaysForYear(year: number): Holiday[] {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const floating: Holiday[] = [
    { name: 'Martin Luther King Jr. Day', month: 1, day: nthWeekday(year, 1, 1, 3) },
    { name: "Presidents' Day", month: 2, day: nthWeekday(year, 2, 1, 3) },
    { name: 'Memorial Day', month: 5, day: lastWeekday(year, 5, 1) },
    { name: 'Labor Day', month: 9, day: nthWeekday(year, 9, 1, 1) },
    { name: 'Columbus Day', month: 10, day: nthWeekday(year, 10, 1, 2) },
    { name: 'Thanksgiving', month: 11, day: thanksgiving },
    { name: 'Day after Thanksgiving', month: 11, day: thanksgiving + 1 },
  ];
  return [...FIXED_HOLIDAYS, ...floating].sort((first, second) => first.month - second.month || first.day - second.day);
}

export interface FrameJob { channel: number; off: number; file: string; video?: boolean }
const pad = (value: number): string => String(value).padStart(2, '0');
export const frameOffsets = (count: number): number[] => Array.from({ length: count }, (_, i) => Math.floor((i * 60) / count));
export const posterFile = (file: string): string => String(file).replace(/\.mp4$/, '.jpg');
export const NO_FOOTAGE_EVENTS = ['RS232', 'Modem-to-Modem', 'Modem', 'Hold Begin', 'Hold End', 'APB Re-Sync', 'APB Counter'];

export const frameJobs = (cfg: Pick<CameraSettings, 'mode' | 'channels' | 'frames' | 'framesAfter'>): FrameJob[] => (cfg.mode === 'video'
  ? cfg.channels.map(({ channel }) => ({ channel, off: 0, file: `ch${channel}.mp4`, video: true }))
  : cfg.channels.flatMap(({ channel }) => [
    ...frameOffsets(cfg.frames).map((second) => ({ channel, off: second, file: `ch${channel}-${pad(second)}.jpg` })),
    ...frameOffsets(cfg.framesAfter || 0).map((second) => ({ channel, off: 60 + second, file: `ch${channel}-a${pad(second)}.jpg` })),
  ]));
