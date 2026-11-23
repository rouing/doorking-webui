#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import promptPassword from '@inquirer/password';
import * as dk from './index.ts';

const csvCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const toCsv = (columns: [string, string][], rows: object[]): string => [columns.map((column) => column[0]),
  ...rows.map((row) => columns.map((column) => (row as Record<string, unknown>)[column[1]]))]
  .map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

/**
 * Area-code mode of a phone.bin, from the names.bin in the same folder (255 when there is none).
 *
 * @param file - File path or filename.
 * @returns Operation result.
 */
function phoneModeFor(file: string) {
  const dir = path.dirname(file);
  const names = fs.readdirSync(dir).find((name) => name.toLowerCase() === 'names.bin');
  return names ? dk.namesLayout(fs.readFileSync(path.join(dir, names))).areaCodeMode : 255;
}

function output(text: string, outFile?: string) {
  if (!outFile) {
    process.stdout.write(text);
    return;
  }
  fs.writeFileSync(outFile, text);
  console.error(`Wrote ${outFile}`);
}

function cloudClient() {
  return new dk.DksCloudClient({ url: process.env.DKS_URL || dk.DEFAULT_URL });
}

function credentials(): [string, string] {
  const { DKS_USER, DKS_PASSWORD } = process.env;
  if (!DKS_USER || !DKS_PASSWORD) throw new Error('Set DKS_USER and DKS_PASSWORD environment variables');
  return [DKS_USER, DKS_PASSWORD];
}

/**
 * Reads a line from the terminal without echoing it (`@inquirer/password`), or from stdin when piped.
 *
 * @param message - Prompt message.
 * @returns Promise resolving to the entered text.
 * @throws Error when cancelled or stdin fails.
 */
async function askHidden(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      process.stdin.on('error', reject);
    });
  }
  try {
    return await promptPassword({ message, mask: '*' }, { output: process.stderr });
  } catch (err) {
    if ((err as Error).name === 'ExitPromptError') throw new Error('Cancelled');
    throw err;
  }
}

/**
 * A new password, asked twice on a terminal.
 *
 * @returns Promise resolving to `string`.
 * @throws Error when validation or the underlying operation fails.
 */
async function newPassword(): Promise<string> {
  const password = await askHidden(`New password (at least ${dk.PASSWORD_MIN} characters):`);
  dk.checkPassword(password);
  if (process.stdin.isTTY && await askHidden('Again:') !== password) throw new Error('The two passwords differ');
  return password;
}

const program = new Command()
  .name('node cli.ts')
  .description('DoorKing Gate Manager CLI — local board parsers, DKS Cloud tools, database setup and account management')
  .option('--config <file>', 'Server config file (default config.json)')
  .option('--out <file>', 'Write command output to a file instead of stdout')
  .addHelpText('after', '\nWeb UI and REST API: node web/server.ts [--config config.json] [--check-config] [--port 8080] [--public-host <name>]\n'
    + '                           [--media media] [--logs logs] [--site-name <tag>] [--memory 1000|2000|3000]\n'
    + '                           [--area-codes "255 Area Codes"|"10 Area Codes"] [--anti-passback Y|N]\n'
    + '                           [--interface-1816 Y|N] [--model 1834]   (see docs/INSTALL.md)');

const serverConfig = () => {
  const cfgPath = program.opts<{ config?: string }>().config;
  return dk.loadConfig({ args: cfgPath ? ['--config', cfgPath] : [] });
};

const outOpt = () => program.opts<{ out?: string }>().out;

async function withDatabase(fn: (store: dk.Store) => Promise<void>): Promise<void> {
  const cfg = serverConfig();
  const store = await dk.openStore({ connection: dk.connectionSettings(cfg.database), keyFile: cfg.paths.keyFile, poolSize: 1 });
  try { await fn(store); } finally { await dk.closeStore(store); }
}

// Database & accounts
program.command('db-setup')
  .description('Create config.json login role, database(s), load sql/schema.sql and create doorking.key')
  .option('--test-db', 'Also create the test database (doorking_test)')
  .action(async (opts: { testDb?: boolean }) => {
    const cfg = serverConfig();
    const login = dk.databaseLogin(cfg.database);
    const admin = process.env.DATABASE_ADMIN_URL
      || await askHidden('PostgreSQL admin connection URL (for example postgres://postgres:<password>@127.0.0.1:5432/postgres):');
    if (!admin.trim()) throw new Error('No admin connection URL');
    const databases = [login.name, ...(opts.testDb ? [cfg.database.testName] : [])];
    for (const step of await dk.setupDatabase({ connectionString: admin.trim() }, { ...login, databases })) console.error(step);
    const hadKey = fs.existsSync(cfg.paths.keyFile);
    await withDatabase(async (store) => {
      const tables = await dk.all<{ n: number }>(store, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'");
      console.error(`Schema: ${path.relative(process.cwd(), dk.SCHEMA_FILE)} loaded into ${login.name} as ${login.user} (${tables[0].n} tables)`);
    });
    console.error(`Encryption key: ${cfg.paths.keyFile} (${hadKey ? 'already there' : 'created; back it up with the database'})`);
  });

program.command('create-admin <username>')
  .description('Create an account that becomes admin of every gate without an admin')
  .action((username: string) => withDatabase(async (store) => {
    dk.checkUsername(username);
    if (await dk.getUser(store, username)) throw new Error(`The username "${dk.userKey(username)}" already exists`);
    const user = await dk.createUser(store, { username, password: await newPassword(), createdBy: 'cli', mustChangePassword: false });
    const gates = await dk.adoptAdminlessGates(store, user.username);
    console.error(`Created ${user.username}; admin of ${gates.length} gate(s)${gates.length ? `: ${gates.join(', ')}` : ''}`);
  }));

program.command('reset-password <username>')
  .description('Set a temporary password (the user must choose a new one at sign-in)')
  .action((username: string) => withDatabase(async (store) => {
    const user = await dk.getUser(store, username);
    if (!user) throw new Error(`There is no user "${dk.userKey(username)}"`);
    await dk.setPassword(store, user.username, await newPassword(), { mustChange: true });
    console.error(`Password of ${user.username} reset; they must choose a new one at their next sign-in. Their sessions were ended.`);
  }));

program.command('grant <username> <gatePhone> <role>')
  .description('Give an account access to a gate (admin, editor or readonly), or change its role')
  .action((username: string, phone: string, role: string) => withDatabase(async (store) => {
    const checked = dk.checkRole(role);
    if (!await dk.getGate(store, phone)) throw new Error(`Gate ${phone} is not managed here`);
    await (await dk.accessOf(store, phone, username) ? dk.setRole(store, phone, username, checked) : dk.grantAccess(store, phone, username, checked, 'cli'));
    console.error(`${dk.userKey(username)} is now ${checked} of gate ${dk.checkPhone(phone)}`);
  }));

program.command('test-email <address>')
  .description('Send a test email now with config.json email settings')
  .action(async (to: string) => {
    const cfg = serverConfig();
    const mailer = dk.createMailer(cfg.email);
    if (!mailer) throw new Error('Email is off: set email.host (and from, user, password) in config.json');
    await mailer.sendMail({ from: cfg.email.from, to, subject: 'DoorKing Gate Manager test email',
      text: `This is a test from DoorKing Gate Manager (${cfg.email.appUrl}). Email is working.` });
    console.error(`Sent to ${to} through ${cfg.email.host}:${cfg.email.port} (${cfg.email.security})`);
  });

program.command('sso-check')
  .description('Contact each single sign-on provider in config.json and show its redirect address')
  .action(async () => {
    const cfg = serverConfig();
    if (!cfg.sso.providers.length) throw new Error('No single sign-on providers in config.json (sso.providers)');
    const origin = cfg.server.publicHost ? `https://${cfg.server.publicHost}` : `http://localhost:${cfg.server.port}`;
    let failed = 0;
    for (const provider of cfg.sso.providers) {
      console.log(`${provider.name} (${provider.id})`);
      console.log(`  redirect address to register: ${origin}/api/sso/${provider.id}/callback`);
      try {
        const metadata = await dk.discoverProvider(new dk.SsoFlows(), provider);
        console.log(`  issuer ${metadata.issuer}\n  sign-in page ${metadata.authorization}\n  token endpoint ${metadata.token}`);
        console.log(`  auth_time claim: ${metadata.authTime === null ? 'not listed (the provider lists no claims)' : metadata.authTime ? 'listed' : 'not listed in discovery (some providers still send it: check with a real sign-in)'}`
          + (provider.maxAgeHours ? `; sign-ins older than ${provider.maxAgeHours} hours are refused` : '; no session-age limit'));
      } catch (err) { failed++; console.log(`  NOT reachable: ${(err as Error).message}`); }
      console.log(`  allowed domains: ${provider.allowedDomains.join(', ') || 'none (invitations and linking only)'}; new accounts: ${provider.autoCreate ? 'yes' : 'no'}; passwords: ${provider.passwords ? 'allowed' : 'off'}`);
    }
    if (failed) process.exitCode = 1;
  });

program.command('emails')
  .description('Show the last 20 emails in the outbox')
  .action(() => withDatabase(async (store) => {
    for (const email of (await dk.listEmails(store, 20)).reverse()) {
      console.log(`${email.createdAt}  ${email.status.padEnd(6)}  ${email.kind.padEnd(8)}  ${email.to}  "${email.subject}"${email.error ? `  (${email.attempts} tries: ${email.error})` : ''}`);
    }
  }));

program.command('vapid-keys')
  .description('Generate a VAPID keypair for config.json push settings')
  .action(() => {
    const keys = dk.generateVapidKeys();
    console.log(JSON.stringify({ push: { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, subject: 'mailto:admin@example.com' } }, null, 2));
  });

// Local board file parsers (read-only)
program.command('transactions <file>')
  .description('Export a TRANSnnn.TRA transaction log as CSV')
  .action((file: string) => output(toCsv([
    ['Timestamp', 'timestamp'], ['Date', 'date'], ['Time', 'time'], ['Type', 'type'],
    ['Code / Card', 'code'], ['Name', 'name'], ['Result', 'result'], ['Relay', 'relay'],
  ], dk.readTraFile(file).transactions), outOpt()));

program.command('phones <file>')
  .description('Export phone.bin as CSV')
  .action((file: string) => output(toCsv([
    ['Directory Code', 'directoryCode'], ['Area Code Index', 'areaCodeIndex'], ['Phone', 'phone'],
    ['Entry Code', 'entryCode'], ['Security Level', 'securityLevel'],
  ], dk.parsePhoneBin(fs.readFileSync(file), phoneModeFor(file))), outOpt()));

program.command('cards <file>')
  .description('Export cards.bin as CSV')
  .action((file: string) => output(toCsv([
    ['Card', 'cardNumber'], ['Directory Code', 'directoryCode'],
  ], dk.parseCardsBin(fs.readFileSync(file))), outOpt()));

program.command('directory <file>')
  .description('Export names.bin directory as CSV')
  .action((file: string) => output(toCsv([
    ['Directory Code', 'directoryCode'], ['Name', 'name'], ['Flag', 'flag'],
  ], dk.parseNamesBin(fs.readFileSync(file)).directory), outOpt()));

program.command('rcvout <file>')
  .description('Export raw RCV_OUT.BIN transactions as CSV')
  .action((file: string) => output(toCsv([
    ['Month', 'month'], ['Day', 'day'], ['Hour', 'hour'], ['Minute', 'minute'], ['PM', 'pm'],
    ['Event Flags', 'eventFlags'], ['Code Type', 'codeType'], ['Code', 'code'], ['Raw', 'raw'],
  ], dk.parseRcvOut(fs.readFileSync(file))), outOpt()));

program.command('board [dir]')
  .description('Summary of names/phone/cards .bin and RCV_OUT.BIN in a folder')
  .action((dir = '.') => {
    const find = (name: string) => fs.readdirSync(dir).find((file) => file.toLowerCase() === name);
    const lines: string[] = [];
    const report = (name: string, fn: (b: Buffer) => string) => {
      const file = find(name);
      lines.push(file ? `${name.padEnd(12)} ${fn(fs.readFileSync(path.join(dir, file)))}` : `${name.padEnd(12)} (not found)`);
    };
    report('names.bin', (buffer) => `${dk.parseNamesBin(buffer).directory.length} directory entries`);
    report('phone.bin', (buffer) => `${dk.parsePhoneBin(buffer, phoneModeFor(path.join(dir, find('phone.bin')!))).filter((entry) => entry.phone).length} phone numbers`);
    report('cards.bin', (buffer) => `${dk.parseCardsBin(buffer).length} cards`);
    report('rcv_out.bin', (buffer) => `${dk.parseRcvOut(buffer).length} raw transactions`);
    for (const mapName of ['names.map', 'phone.map', 'cards.map']) {
      report(mapName, (buffer) => { const map = dk.parseMap(buffer); return `${map.changedBlocks.length} of ${map.blocks} blocks flagged`; });
    }
    output(`${lines.join('\r\n')}\r\n`, outOpt());
  });

// DKS Cloud commands (read-only)
program.command('cloud-login')
  .description('Check DKS_USER / DKS_PASSWORD login against DKS Cloud')
  .action(async () => output(`${await cloudClient().checkLogin(...credentials())}\n`, outOpt()));

program.command('cloud-status <sessionId>')
  .description('Show a DKS Cloud session status')
  .action(async (id: string) => output(`${await cloudClient().getSessionStatus(id)}\n`, outOpt()));

program.command('cloud-download <sessionId> <fileType>')
  .description('Download a session file (rcv_out.bin, names.bin, phone.bin, cards.bin)')
  .action(async (id: string, fileType: string) => {
    const data = await cloudClient().getDataFile(id, fileType);
    const out = outOpt() || fileType;
    fs.writeFileSync(out, data);
    console.error(`Wrote ${out} (${data.length} bytes)`);
  });

interface CloudPullOptions {
  dir?: string;
  phone?: string;
  siteName?: string;
  tag?: string;
  memory?: string;
  areaCodes?: string;
  model?: string;
  dialDelay?: string;
  antiPassback?: string;
  interface1816?: string;
  marker?: string;
  dryRun?: boolean;
}

program.command('cloud-pull <what>')
  .description('Start a DKS Cloud session (transactions or residents) and download the files')
  .option('--dir <dir>', 'Output folder', 'pulls')
  .option('--phone <phone>', 'System phone number (or DKS_PHONE)')
  .option('--site-name <tag>', 'Site name tag')
  .option('--tag <tag>', 'Alias for --site-name')
  .option('--memory <size>', 'Memory size (1000|2000|3000)')
  .option('--area-codes <mode>', 'Area codes (255|10)')
  .option('--model <model>', 'Model number (e.g. 1834)')
  .option('--dial-delay <sec>', 'Dial delay')
  .option('--anti-passback <yn>', 'Anti-passback (Y|N)')
  .option('--interface-1816 <yn>', 'Interface 1816 (Y|N)')
  .option('--marker <hex>', '24-hex transaction marker', dk.ZERO_MARKER)
  .option('--dry-run', 'Print the session request without calling DKS Cloud')
  .action(async (what: string, opts: CloudPullOptions) => {
    if (!['transactions', 'residents'].includes(what)) throw new Error('Expected "transactions" or "residents"');
    const [user, password] = credentials();
    const masterCode = process.env.DKS_MASTER_CODE;
    if (!masterCode) throw new Error('Set DKS_MASTER_CODE (the account/master code)');
    const phoneNumber = opts.phone || process.env.DKS_PHONE;
    if (!phoneNumber) throw new Error('Pass --phone <system phone> or set DKS_PHONE');
    const dir = opts.dir || 'pulls';
    const request = dk.buildSessionRequest(what, {
      user,
      password,
      masterCode,
      phoneNumber,
      siteName: opts.siteName || opts.tag,
      memorySize: opts.memory,
      areaCodes: opts.areaCodes,
      dialDelay: opts.dialDelay,
      interface1816: opts.interface1816,
      antiPassBack: opts.antiPassback,
      modelNumber: opts.model,
    });
    const marker = opts.marker || dk.ZERO_MARKER;
    console.error('StartSessionSeries30', JSON.stringify(dk.maskRequest(request, user), null, 2));
    if (what === 'transactions') console.error(`ReceiveTransactionData TransactionBytes=${marker}`);
    if (opts.dryRun) return;

    const { files } = await dk.pullFromGate(cloudClient(), what as dk.PullKind, request, {
      marker, onStatus: (message) => console.error(message),
    });
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), data);
      console.error(`Wrote ${path.join(dir, name)} (${data.length} bytes)`);
    }
  });

if (process.argv.length <= 2) {
  console.error(program.helpInformation());
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
