/**
 * @module src/shared
 *
 * Constants, defaults, and browser-safe helpers shared by the server and web UI (no Node imports).
 * Re-exports phone helpers (`src/phone.ts`) and entry-code helpers (`src/entry-codes.ts`).
 */
import type { DeviceRange, GateConfig, ResidentPortalPrefs, ScheduleAction } from './types.ts';

export { fmtPhone, parseNanpPhone, type NanpPhoneParts } from './phone.ts';
export { buildWelcomeMessage, generateSafeEntryCode, isWeakEntryCode, type WelcomeMessageInput } from './entry-codes.ts';

export const PASSWORD_MIN = 12; // characters in an account password
export const NOTE_MAX = 500; // characters in a directory code's local note
/**
 * Cards (device numbers) one directory code may hold: DoorKing32 refuses more ("You can only add up to 25 additional
 * device numbers"; its export has 25 device columns).
 */
export const MAX_CARDS_PER_ENTRY = 25;
/** The gate configuration fields kept in prefs (PUT /prefs gateConfig), in the order the page shows them. */
export const GATE_CONFIG_KEYS: (keyof GateConfig)[] = ['siteName', 'memorySize', 'areaCodes', 'modelNumber', 'antiPassBack', 'interface1816'];
/** A schedule's transfers, in the order they run. */
export const SCHEDULE_ACTIONS: ScheduleAction[] = ['send', 'residents', 'transactions', 'snapshots'];
/** Device Association until a gate's ranges are saved: every card number is a "Cards" event. */
export const DEFAULT_DEVICE_ASSOCIATION: DeviceRange[] = [{ name: 'Cards', from: '00001', to: '65407' }];

/** Default per-gate Resident Portal preferences shared by server normalization and the admin UI. */
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

/**
 * Device name for a card number, as DoorKing32 shows it in a card transaction's Event Type: the first row whose
 * From-To range holds the number, else '' (DoorKing32 shows a blank).
 *
 * @param rows - Device association ranges.
 * @param card - Card number.
 * @returns Device label or empty string.
 */
export function deviceNameFor(rows: DeviceRange[] | null | undefined, card: number | string): string {
  const number = Number(card);
  const device = (rows || []).find((range) => number >= Number(range.from) && number <= Number(range.to));
  return device ? device.name : '';
}
