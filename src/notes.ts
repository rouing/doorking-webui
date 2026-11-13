// Resident/vendor notes: free text per gate and directory code, kept only in the local database (the gate has no
// field for them). Keyed by the gate's system phone number, so every account that manages the gate shares them,
// and by the directory code without leading zeros, so notes survive a change of "Num of Digits in Dir Code".
import { all, one, run, type Store } from './db.ts';

export const NOTE_MAX = 500;

const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');

// The notes key of a directory code: "0701" and "701" share a note.
export const noteKey = (code: unknown): string => String(code ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');

// { [noteKey(directoryCode)]: note } for the gate.
export async function getNotes(store: Store, phone: unknown): Promise<Record<string, string>> {
  const rows = await all<{ code: string; note: string }>(store, 'SELECT code, note FROM notes WHERE phone = $1', [phoneDigits(phone)]);
  return Object.fromEntries(rows.map((r) => [r.code, r.note]));
}

export async function getNote(store: Store, phone: unknown, code: unknown): Promise<string> {
  const row = await one<{ note: string }>(store, 'SELECT note FROM notes WHERE phone = $1 AND code = $2', [phoneDigits(phone), noteKey(code)]);
  return row ? row.note : '';
}

// Saves the note for a directory code (trimmed; blank deletes it). Returns the saved note.
export async function setNote(store: Store, phone: unknown, code: unknown, note: unknown, user: unknown): Promise<string> {
  const text = String(note ?? '').trim();
  if (text.length > NOTE_MAX) throw Object.assign(new Error(`A note is at most ${NOTE_MAX} characters`), { status: 400 });
  if (!text) {
    await run(store, 'DELETE FROM notes WHERE phone = $1 AND code = $2', [phoneDigits(phone), noteKey(code)]);
    return '';
  }
  await run(store, `INSERT INTO notes (phone, code, note, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone, code) DO UPDATE SET note = excluded.note, saved_by = excluded.saved_by, saved_at = excluded.saved_at`,
  [phoneDigits(phone), noteKey(code), text, String(user), new Date().toISOString()]);
  return text;
}
