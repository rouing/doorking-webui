// Debug log: errors and other issues appended to a text file (by default logs/debug.log in the project) while turned on
// (System Settings → Debug logs; saved in the database's meta table as debugLogs). The file is moved to
// debug.log.1 once it passes maxBytes. Callers mask secrets before writing.
import fs from 'node:fs';
import path from 'node:path';
import { getMeta, setMeta, type Store } from './db.ts';
import type { DebugLogInfo } from './types.ts';

export const DEBUG_LOG_META = 'debugLogs';

export const debugLogEnabled = async (store: Store): Promise<boolean> => (await getMeta(store, DEBUG_LOG_META)) === '1';
export const setDebugLogEnabled = (store: Store, on: boolean): Promise<void> => setMeta(store, DEBUG_LOG_META, on ? '1' : '0');

export interface DebugLog {
  write(area: string, message: unknown): void;
  read(): string;
  info(): DebugLogInfo;
  file: string;
}

// Returns { write(area, message), read(), info(), file }. enabled() decides on every write.
export function createDebugLog(
  file: string,
  { enabled = () => false, maxBytes = 5 * 1024 * 1024 }: { enabled?: () => boolean; maxBytes?: number } = {},
): DebugLog {
  function write(area: string, message: unknown): void {
    if (!enabled()) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
      const lines = String(message).split(/\r?\n/).filter((l) => l.trim()).join(' | ');
      fs.appendFileSync(file, `${new Date().toISOString()} [${area}] ${lines}\n`);
    } catch (e) { console.error(`Debug log not written: ${(e as Error).message}`); }
  }
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const info = () => ({ enabled: enabled(), file, size: fs.existsSync(file) ? fs.statSync(file).size : 0 });
  return { write, read, info, file };
}
