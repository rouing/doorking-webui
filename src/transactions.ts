import fs from 'node:fs';
import { ArchiveReader } from './carchive.ts';

export interface TraTransaction {
  date: string;
  time: string;
  timestamp: string;
  type: string;
  code: string;
  name: string;
  result: string;
  relay: string;
}

export interface TraFile { lastMarker: string; version: string; transactions: TraTransaction[] }

// TRANS*.TRA ("VERSION 54"): transaction log of CTran54Record objects, newest first.
// The first 12 bytes are the "last received" marker that is sent back to DKS Cloud
// as TransactionBytes so only newer transactions are downloaded.
export function parseTraFile(buffer: Buffer): TraFile {
  const r = new ArchiveReader(buffer);
  const lastMarker = r.bytes(12).toString('hex');
  const version = r.string();
  const count = r.u16();
  const transactions: TraTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const className = r.classTag();
    if (className !== 'CTran54Record') {
      throw new Error(`Unexpected class ${className} in transaction file`);
    }
    const date = r.string().trim();
    const time = r.string().trim();
    const t = {
      date,
      time,
      timestamp: toIsoTimestamp(date, time),
      type: r.string(),
      code: r.string(),
      name: r.string().trimEnd(),
      result: r.string(),
      relay: r.string(),
    };
    r.string();
    r.i16();
    r.u8();
    transactions.push(t);
  }
  if (!r.eof) {
    throw new Error(`Transaction file has ${buffer.length - r.pos} unread bytes`);
  }
  return { lastMarker, version, transactions };
}

// "6/22/26" + "11:39PM" -> "2026-06-22 23:39"
export function toIsoTimestamp(date: string, time: string): string {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(time);
  if (!d || !t) return '';
  let hour = Number(t[1]) % 12;
  if (t[3].toUpperCase() === 'P') hour += 12;
  const pad = (n: number | string) => String(n).padStart(2, '0');
  return `20${d[3]}-${pad(d[1])}-${pad(d[2])} ${pad(hour)}:${t[2]}`;
}

export function readTraFile(path: string): TraFile {
  return parseTraFile(fs.readFileSync(path));
}
