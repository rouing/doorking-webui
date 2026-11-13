#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import * as dk from './index.ts';

const USAGE = `Usage: node cli.ts <command> [args] [--out <file>]

Local files (read-only):
  transactions <TRANSnnn.TRA>       Transaction log as CSV
  board <folder>                    Summary of names/phone/cards .bin and RCV_OUT.BIN
  phones <phone.bin>                phone.bin as CSV
  cards <cards.bin>                 cards.bin as CSV
  directory <names.bin>             names.bin directory as CSV
  rcvout <RCV_OUT.BIN>              Raw board transactions as CSV

DKS Cloud (read-only; credentials from DKS_USER / DKS_PASSWORD, URL from DKS_URL):
  cloud-login                       Check the login
  cloud-status <sessionId>          Show a session's status
  cloud-download <sessionId> <rcv_out.bin|names.bin|phone.bin|cards.bin>   Save a session file
  cloud-pull <transactions|residents> [--dir DOWNLOADED] [--phone <sys phone>] [--site-name <tag>]
             [--memory 1000|2000|3000] [--area-codes 255|10] [--model 1834] [--marker <24 hex>]
             [--anti-passback Y|N] [--interface-1816 Y|N] [--dry-run]
                                    Start a session, read from the gate, download the files
                                    (master code from DKS_MASTER_CODE, system phone from --phone or DKS_PHONE)

Web UI and REST API: node web/server.ts [--port 8080] [--dir DOWNLOADED] [--db DB]
                           [--site-name <tag>] [--memory 1000|2000|3000] [--area-codes "255 Area Codes"|"10 Area Codes"]
                           [--anti-passback Y|N] [--interface-1816 Y|N] [--model 1834]   (see README.md)`;

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (columns: [string, string][], rows: object[]): string => [columns.map((c) => c[0]),
  ...rows.map((r) => columns.map((c) => (r as Record<string, unknown>)[c[1]]))]
  .map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

// Area-code mode of a phone.bin, from the names.bin in the same folder (255 when there is none).
function phoneModeFor(file: string) {
  const dir = path.dirname(file);
  const names = fs.readdirSync(dir).find((f) => f.toLowerCase() === 'names.bin');
  return names ? dk.namesLayout(fs.readFileSync(path.join(dir, names))).areaCodeMode : 255;
}

function output(text: string, args: string[]) {
  const i = args.indexOf('--out');
  if (i >= 0 && args[i + 1]) {
    fs.writeFileSync(args[i + 1], text);
    console.error(`Wrote ${args[i + 1]}`);
  } else {
    process.stdout.write(text);
  }
}

function cloudClient() {
  return new dk.DksCloudClient({ url: process.env.DKS_URL || dk.DEFAULT_URL });
}

function credentials(): [string, string] {
  const { DKS_USER, DKS_PASSWORD } = process.env;
  if (!DKS_USER || !DKS_PASSWORD) throw new Error('Set DKS_USER and DKS_PASSWORD environment variables');
  return [DKS_USER, DKS_PASSWORD];
}

const COMMANDS: Record<string, (positional: string[], args: string[]) => void | Promise<void>> = {
  transactions: ([file], args) => output(toCsv([
    ['Timestamp', 'timestamp'], ['Date', 'date'], ['Time', 'time'], ['Type', 'type'],
    ['Code / Card', 'code'], ['Name', 'name'], ['Result', 'result'], ['Relay', 'relay'],
  ], dk.readTraFile(file).transactions), args),

  phones: ([file], args) => output(toCsv([
    ['Directory Code', 'directoryCode'], ['Area Code Index', 'areaCodeIndex'], ['Phone', 'phone'],
    ['Entry Code', 'entryCode'], ['Security Level', 'securityLevel'],
  ], dk.parsePhoneBin(fs.readFileSync(file), phoneModeFor(file))), args),

  cards: ([file], args) => output(toCsv([
    ['Card', 'cardNumber'], ['Directory Code', 'directoryCode'],
  ], dk.parseCardsBin(fs.readFileSync(file))), args),

  directory: ([file], args) => output(toCsv([
    ['Directory Code', 'directoryCode'], ['Name', 'name'], ['Flag', 'flag'],
  ], dk.parseNamesBin(fs.readFileSync(file)).directory), args),

  rcvout: ([file], args) => output(toCsv([
    ['Month', 'month'], ['Day', 'day'], ['Hour', 'hour'], ['Minute', 'minute'], ['PM', 'pm'],
    ['Event Flags', 'eventFlags'], ['Code Type', 'codeType'], ['Code', 'code'], ['Raw', 'raw'],
  ], dk.parseRcvOut(fs.readFileSync(file))), args),

  board: ([dir = '.'], args) => {
    const find = (name: string) => fs.readdirSync(dir).find((f) => f.toLowerCase() === name);
    const lines: string[] = [];
    const report = (name: string, fn: (b: Buffer) => string) => {
      const f = find(name);
      lines.push(f ? `${name.padEnd(12)} ${fn(fs.readFileSync(path.join(dir, f)))}` : `${name.padEnd(12)} (not found)`);
    };
    report('names.bin', (b) => `${dk.parseNamesBin(b).directory.length} directory entries`);
    report('phone.bin', (b) => {
      const n = find('names.bin');
      const mode = n ? dk.namesLayout(fs.readFileSync(path.join(dir, n))).areaCodeMode : 255;
      return `${dk.parsePhoneBin(b, mode).filter((e) => e.phone).length} phone numbers`;
    });
    report('cards.bin', (b) => `${dk.parseCardsBin(b).length} cards`);
    report('rcv_out.bin', (b) => `${dk.parseRcvOut(b).length} raw transactions`);
    for (const m of ['names.map', 'phone.map', 'cards.map']) {
      report(m, (b) => { const r = dk.parseMap(b); return `${r.changedBlocks.length} of ${r.blocks} blocks flagged`; });
    }
    output(`${lines.join('\r\n')}\r\n`, args);
  },

  'cloud-login': async (_, args) => output(`${await cloudClient().checkLogin(...credentials())}\n`, args),

  'cloud-status': async ([id], args) => output(`${await cloudClient().getSessionStatus(id)}\n`, args),

  'cloud-pull': async ([what], args) => {
    if (!['transactions', 'residents'].includes(what)) throw new Error(USAGE);
    const opt = (name: string, def?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
    const [user, password] = credentials();
    const masterCode = process.env.DKS_MASTER_CODE;
    if (!masterCode) throw new Error('Set DKS_MASTER_CODE (the account/master code)');
    const phoneNumber = opt('--phone', process.env.DKS_PHONE);
    if (!phoneNumber) throw new Error('Pass --phone <system phone> or set DKS_PHONE');
    const dir = opt('--dir', 'DOWNLOADED')!;
    const request = dk.buildSessionRequest(what, {
      user,
      password,
      masterCode,
      phoneNumber,
      siteName: opt('--site-name', opt('--tag')),
      memorySize: opt('--memory'),
      areaCodes: opt('--area-codes'),
      dialDelay: opt('--dial-delay'),
      interface1816: opt('--interface-1816'),
      antiPassBack: opt('--anti-passback'),
      modelNumber: opt('--model'),
    });
    const marker = opt('--marker', dk.ZERO_MARKER);
    console.error('StartSessionSeries30', JSON.stringify(dk.maskRequest(request, user), null, 2));
    if (what === 'transactions') console.error(`ReceiveTransactionData TransactionBytes=${marker}`);
    if (args.includes('--dry-run')) return;

    const { files } = await dk.pullFromGate(cloudClient(), what as dk.PullKind, request, {
      marker, onStatus: (s) => console.error(s),
    });
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, f), data);
      console.error(`Wrote ${path.join(dir, f)} (${data.length} bytes)`);
    }
  },

  'cloud-download': async ([id, fileType], args) => {
    const data = await cloudClient().getDataFile(id, fileType);
    const i = args.indexOf('--out');
    const out = i >= 0 ? args[i + 1] : fileType;
    fs.writeFileSync(out, data);
    console.error(`Wrote ${out} (${data.length} bytes)`);
  },
};

async function main() {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  const positional = rest.filter((a, i) => a !== '--out' && rest[i - 1] !== '--out');
  if (!COMMANDS[command]) {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
  await COMMANDS[command](positional, args);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
