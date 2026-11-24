/** The gate's pages, in sidebar order. */
export const NAV = [
  { key: 'residents', label: 'Residents' }, { key: 'vendors', label: 'Vendors' }, { key: 'transactions', label: 'Transactions' },
  { key: 'audit', label: 'Insights' },
  { section: 'System' },
  { key: 'display', label: 'Display' }, { key: 'relays', label: 'Live Relays' }, { key: 'holdOpen', label: 'Hold Open' },
  { key: 'holidays', label: 'Holidays' }, { key: 'security', label: 'Security Levels' }, { key: 'facility', label: 'Facility Codes' },
  { key: 'elevator', label: 'Elevator Reference' }, { key: 'relayElevator', label: 'Relay / Elevator' }, { key: 'apb', label: 'Anti-Pass Back' },
] as const;
/** Pinned at the bottom of the sidebar, above Gate connection. */
export const PINNED_NAV = [
  { key: 'history', label: 'History' }, { key: 'schedules', label: 'Scheduled Transfers' }, { key: 'prefs', label: 'System Settings' },
] as const;
export type NavKey = Extract<(typeof NAV)[number], { key: string }>['key'] | (typeof PINNED_NAV)[number]['key'] | 'relays' | 'user';
// Pages that only edit gate settings: shown with every control disabled for read-only users.

/**
 * The elevator pages show only when the gate's Elevators feature is on (System Settings → Gate configuration).
 *
 * @param key - Lookup key, API key, or setting key.
 * @param elevators - `boolean` value.
 * @returns Computed result.
 */
export const pageShown = (key: NavKey, elevators: boolean) => (key !== 'elevator' && key !== 'relayElevator') || elevators;
