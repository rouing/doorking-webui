/**
 * @module web/ui/csv
 *
 * Client-side CSV builders and browser file download helpers (DoorKing 62-column export + generic table CSV).
 */
import type { ResidentRow } from '../../src/types.ts';

/** Triggers a browser file download from plain text. */
export function downloadText(name: string, text: string, type = 'text/csv') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** Downloads rows as a RFC 4180 CSV file. */
export function downloadCsv(name: string, header: string[], rows: string[][]) {
  const esc = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  downloadText(name, [header, ...rows].map((row) => row.map(esc).join(',')).join('\r\n') + '\r\n');
}

/**
 * Formats the whole directory as DoorKing's 62-column `ResidentsExport.csv` (matched against DKS Cloud exports).
 */
export function doorKingCsv(account: string, rows: ResidentRow[], unassignedCards: string[] = []): string {
  const quoted = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const plain = (value: unknown) => String(value ?? '').replace(/[",\r\n]/g, ' ');
  const devices = [''].concat(Array.from({ length: 24 }, (_, i) => String(i + 2)));
  const header = ['ACCOUNT', 'Resident', 'H', 'AAC', 'PHONE', 'Dir', 'ENT', 'SL', 'Device', 'FL', 'ER', 'NOTES', 'Vendor',
    ...devices.slice(1).flatMap((device) => [`DEVICE${device}`, `NOTES${device}`]), 'RESIDENTNOTES'];
  const ordered = [...rows].sort((a, b) => (a.entryOffset ?? Infinity) - (b.entryOffset ?? Infinity) || a.directoryCode.localeCompare(b.directoryCode));
  const lines = ordered.map((resident) => {
    const vendor = resident.type === 'Vendor';
    const own = /^0+$/.test(resident.directoryCode) ? [...resident.cards, ...unassignedCards] : resident.cards;
    const cards = [...new Set(own.map((card) => Number(card)))].filter((card) => card > 0).sort((x, y) => x - y).slice(0, 25).map((card) => String(card).padStart(5, '0'));
    const dev = (i: number) => plain(cards[i] || '');
    return [quoted(account), quoted(resident.name), resident.hidden && !vendor ? 'Y' : 'N', plain(resident.areaCode), plain(resident.phone), plain(resident.directoryCode), plain(resident.entryCode),
      plain(resident.securityLevel), dev(0), plain(resident.floor), plain(resident.elevatorRef), quoted(''), vendor ? 'Y' : 'N',
      ...devices.slice(1).flatMap((_, i) => [dev(i + 1), quoted('')]), quoted(resident.note || '')].join(',');
  });
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
