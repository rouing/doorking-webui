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
  cloud-pull <transactions|residents> [--dir pulls] [--phone <sys phone>] [--site-name <tag>]
             [--memory 1000|2000|3000] [--area-codes 255|10] [--model 1834] [--marker <24 hex>]
             [--anti-passback Y|N] [--interface-1816 Y|N] [--dry-run]
                                    Start a session, read from the gate, download the files
                                    (master code from DKS_MASTER_CODE, system phone from --phone or DKS_PHONE)

Database (for whoever runs the server):
  db-setup [--test-db]              Create config.json's login role and database (and the tests' database with
                                    --test-db) through a PostgreSQL admin connection, then load sql/schema.sql and
                                    create the encryption key. Asks (hidden) for the admin connection URL, or reads
                                    DATABASE_ADMIN_URL. Safe to run again: existing roles, databases, tables are kept.

Accounts (for whoever runs the server; uses config.json's database; the password is asked for, not typed on the
command line):
  create-admin <username>           Create an account that becomes admin of every gate without an admin
  reset-password <username>         Set a temporary password (the user must choose a new one at sign-in)
  grant <username> <gate phone> <admin|readonly>   Give an account access to a gate (or change its role)
  test-email <address>              Send a test email now with config.json's email settings (shows the SMTP error, if any)
  emails                            The last 20 emails in the outbox (to, subject, status, error)

Web UI and REST API: node web/server.ts [--config config.json] [--check-config] [--port 8080] [--public-host <name>]
                           [--media media] [--logs logs]
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

const serverConfig = () => dk.loadConfig({ args: process.argv.slice(2).filter((a, i, all) => a === '--config' || all[i - 1] === '--config') });

// The server's database (config.json).
async function openDatabase(): Promise<dk.Store> {
  const cfg = serverConfig();
  return dk.openStore({ connection: dk.connectionSettings(cfg.database), keyFile: cfg.paths.keyFile, poolSize: 1 });
}

// Reads a line from the terminal without showing it (or from standard input when that is not a terminal).
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (c) => { data += c; });
      input.on('end', () => resolve(data.split(/\r?\n/)[0]));
      input.on('error', reject);
      return;
    }
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.setEncoding('utf8');
    let text = '';
    const done = (value: string | null) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      if (value === null) reject(new Error('Cancelled')); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(text);
        if (ch === '\u0003') return done(null);
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

// A new password, asked twice on a terminal.
async function newPassword(): Promise<string> {
  const pw = await askHidden(`New password (at least ${dk.PASSWORD_MIN} characters): `);
  dk.checkPassword(pw);
  if (process.stdin.isTTY && await askHidden('Again: ') !== pw) throw new Error('The two passwords differ');
  return pw;
}

async function withDatabase(fn: (store: dk.Store) => Promise<void>): Promise<void> {
  const store = await openDatabase();
  try { await fn(store); } finally { await dk.closeStore(store); }
}

const COMMANDS: Record<string, (positional: string[], args: string[]) => void | Promise<void>> = {
  'db-setup': async (_, args) => {
    const cfg = serverConfig();
    const login = dk.databaseLogin(cfg.database);
    const admin = process.env.DATABASE_ADMIN_URL
      || await askHidden('PostgreSQL admin connection URL (for example postgres://postgres:<password>@127.0.0.1:5432/postgres): ');
    if (!admin.trim()) throw new Error('No admin connection URL');
    const databases = [login.name, ...(args.includes('--test-db') ? [cfg.database.testName] : [])];
    for (const step of await dk.setupDatabase({ connectionString: admin.trim() }, { ...login, databases })) console.error(step);
    const hadKey = fs.existsSync(cfg.paths.keyFile);
    await withDatabase(async (store) => {
      const tables = await dk.all<{ n: number }>(store, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'");
      console.error(`Schema: ${path.relative(process.cwd(), dk.SCHEMA_FILE)} loaded into ${login.name} as ${login.user} (${tables[0].n} tables)`);
    });
    console.error(`Encryption key: ${cfg.paths.keyFile} (${hadKey ? 'already there' : 'created; back it up with the database'})`);
  },

  'create-admin': ([username]) => withDatabase(async (store) => {
    if (!username) throw new Error('Usage: create-admin <username>');
    dk.checkUsername(username);
    if (await dk.getUser(store, username)) throw new Error(`The username "${dk.userKey(username)}" already exists`);
    const u = await dk.createUser(store, { username, password: await newPassword(), createdBy: 'cli', mustChangePassword: false });
    const gates = await dk.adoptAdminlessGates(store, u.username);
    console.error(`Created ${u.username}; admin of ${gates.length} gate(s)${gates.length ? `: ${gates.join(', ')}` : ''}`);
  }),

  'reset-password': ([username]) => withDatabase(async (store) => {
    if (!username) throw new Error('Usage: reset-password <username>');
    const u = await dk.getUser(store, username);
    if (!u) throw new Error(`There is no user "${dk.userKey(username)}"`);
    await dk.setPassword(store, u.username, await newPassword(), { mustChange: true });
    console.error(`Password of ${u.username} reset; they must choose a new one at their next sign-in. Their sessions were ended.`);
  }),

  'test-email': async ([to]) => {
    if (!to) throw new Error('Usage: test-email <address>');
    const cfg = dk.loadConfig({ args: process.argv.slice(2).filter((a, i, all) => a === '--config' || all[i - 1] === '--config') });
    const mailer = dk.createMailer(cfg.email);
    if (!mailer) throw new Error('Email is off: set email.host (and from, user, password) in config.json');
    await mailer.sendMail({ from: cfg.email.from, to, subject: 'DoorKing Gate Manager test email',
      text: `This is a test from DoorKing Gate Manager (${cfg.email.appUrl}). Email is working.` });
    console.error(`Sent to ${to} through ${cfg.email.host}:${cfg.email.port} (${cfg.email.security})`);
  },

  emails: () => withDatabase(async (store) => {
    for (const e of (await dk.listEmails(store, 20)).reverse()) {
      console.log(`${e.createdAt}  ${e.status.padEnd(6)}  ${e.kind.padEnd(8)}  ${e.to}  "${e.subject}"${e.error ? `  (${e.attempts} tries: ${e.error})` : ''}`);
    }
  }),

  grant: ([username, phone, role]) => withDatabase(async (store) => {
    if (!username || !phone || !role) throw new Error('Usage: grant <username> <gate phone> <admin|readonly>');
    const r = dk.checkRole(role);
    if (!await dk.getGate(store, phone)) throw new Error(`Gate ${phone} is not managed here`);
    if (await dk.accessOf(store, phone, username)) await dk.setRole(store, phone, username, r);
    else await dk.grantAccess(store, phone, username, r, 'cli');
    console.error(`${dk.userKey(username)} is now ${r} of gate ${dk.checkPhone(phone)}`);
  }),

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
    const dir = opt('--dir', 'pulls')!;
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
  const positional = rest.filter((a, i) => !['--out', '--config'].includes(a) && !['--out', '--config'].includes(rest[i - 1]));
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
