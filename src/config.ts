// Server settings: config.json (by default in the project folder; --config or DOORKING_CONFIG for another path),
// over the built-in defaults. Environment variables and command-line flags override the file (see loadConfig).
// The file holds the database password, so it must be readable by its owner only (chmod 600), like the encryption
// key next to it (paths.keyFile). Relative paths in the file are relative to the file's folder.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_URL } from './dks-cloud.ts';
import { GATE_DEFAULTS } from './gate-pull.ts';

export interface DatabaseConfig {
  url: string; // a full postgres:// URL; when set, host/port/name/user/password are not used
  host: string; port: number; name: string; user: string; password: string;
  poolSize: number;
  testName: string; // database the tests use (one throwaway schema per test), same login
}
export interface ServerConfig {
  file: string | null; // the config file read, or null when there was none
  server: { port: number; publicHost: string };
  paths: { media: string; logs: string; keyFile: string }; // absolute
  database: DatabaseConfig;
  dks: { url: string };
  security: { sessionIdleMinutes: number; maxFailedSignIns: number; signInWindowMinutes: number };
  schedules: { checkSeconds: number };
  cameras: { ffmpeg: string; tidyMinutes: number }; // ffmpeg: '' = tools/bin, else ffmpeg on the PATH
  gateDefaults: typeof GATE_DEFAULTS;
}

const ROOT = path.join(import.meta.dirname, '..');
export const CONFIG_FILE = path.join(ROOT, 'config.json');

const DEFAULTS = {
  server: { port: 8080, publicHost: '' },
  paths: { media: 'media', logs: 'logs', keyFile: 'doorking.key' },
  database: { url: '', host: '127.0.0.1', port: 5432, name: 'doorking', user: 'doorking', password: '', poolSize: 5, testName: 'doorking_test' },
  dks: { url: DEFAULT_URL },
  security: { sessionIdleMinutes: 30, maxFailedSignIns: 5, signInWindowMinutes: 15 },
  schedules: { checkSeconds: 30 },
  cameras: { ffmpeg: '', tidyMinutes: 60 },
  gateDefaults: { ...GATE_DEFAULTS },
};
type Section = keyof typeof DEFAULTS;
// Whole numbers and their allowed range; every other setting is text.
const RANGES: Record<string, [number, number]> = {
  'server.port': [1, 65535], 'database.port': [1, 65535], 'database.poolSize': [1, 100],
  'security.sessionIdleMinutes': [1, 1440], 'security.maxFailedSignIns': [1, 100], 'security.signInWindowMinutes': [1, 1440],
  'schedules.checkSeconds': [5, 3600], 'cameras.tidyMinutes': [5, 1440],
};

const fail = (msg: string): never => { throw new Error(msg); };

// Checks one section of the file against the defaults; returns the merged section.
function section(name: Section, given: unknown, where: string): Record<string, unknown> {
  const def = DEFAULTS[name] as Record<string, unknown>;
  if (given === undefined) return { ...def };
  if (!given || typeof given !== 'object' || Array.isArray(given)) fail(`${where}: "${name}" must be an object`);
  const out: Record<string, unknown> = { ...def };
  for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
    const key = `${name}.${k}`;
    if (!(k in def)) fail(`${where}: unknown setting "${key}"`);
    const range = RANGES[key];
    if (range) {
      if (!Number.isInteger(v) || (v as number) < range[0] || (v as number) > range[1]) {
        fail(`${where}: "${key}" must be a whole number from ${range[0]} to ${range[1]}`);
      }
    } else if (typeof v !== 'string') fail(`${where}: "${key}" must be text (in quotes)`);
    out[k] = v;
  }
  return out;
}

// On Linux/macOS a file holding secrets must not be readable by other users.
export function checkPrivate(file: string): void {
  if (process.platform === 'win32' || !fs.existsSync(file)) return;
  if (fs.statSync(file).mode & 0o077) fail(`${file} can be read by other users. Run: chmod 600 ${file}`);
}

export interface LoadOptions { file?: string; env?: NodeJS.ProcessEnv; args?: string[] }

// The settings in effect: defaults < the config file < environment variables (PORT, PUBLIC_HOST, DATABASE_URL,
// DKS_URL) < flags (--port, --public-host, --media, --logs, and the gate defaults --site-name, --memory,
// --area-codes, --anti-passback, --interface-1816, --model). file: the config file (default --config,
// DOORKING_CONFIG, else config.json in the project folder); a missing default file means all defaults.
// Throws with a readable message on a bad file or value.
export function loadConfig({ file, env = process.env, args = process.argv.slice(2) }: LoadOptions = {}): ServerConfig {
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const chosen = file || flag('--config') || env.DOORKING_CONFIG;
  const f = path.resolve(chosen || CONFIG_FILE);
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(f)) {
    try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { fail(`${f} is not valid JSON: ${(e as Error).message}`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${f} must hold a JSON object`);
    checkPrivate(f);
  } else if (chosen) fail(`Config file ${f} not found`);
  for (const k of Object.keys(raw)) if (!(k in DEFAULTS)) fail(`${f}: unknown section "${k}"`);
  const s = Object.fromEntries((Object.keys(DEFAULTS) as Section[]).map((k) => [k, section(k, raw[k], f)])) as any;
  const dir = path.dirname(f);
  const number = (v: string, key: string) => { const n = Number(v); return Number.isInteger(n) ? n : fail(`${key} must be a whole number`); };
  if (env.PORT) s.server.port = number(env.PORT, 'PORT');
  if (env.PUBLIC_HOST !== undefined) s.server.publicHost = env.PUBLIC_HOST;
  if (env.DATABASE_URL) s.database.url = env.DATABASE_URL;
  if (env.DKS_URL) s.dks.url = env.DKS_URL;
  if (flag('--port')) s.server.port = number(flag('--port')!, '--port');
  if (flag('--public-host') !== undefined) s.server.publicHost = flag('--public-host');
  if (flag('--media')) s.paths.media = flag('--media');
  if (flag('--logs')) s.paths.logs = flag('--logs');
  for (const [name, key] of [['--site-name', 'siteName'], ['--memory', 'memorySize'], ['--area-codes', 'areaCodes'],
    ['--anti-passback', 'antiPassBack'], ['--interface-1816', 'interface1816'], ['--model', 'modelNumber']]) {
    if (flag(name)) s.gateDefaults[key] = flag(name);
  }
  s.server.publicHost = String(s.server.publicHost).trim().toLowerCase();
  for (const k of ['media', 'logs', 'keyFile'] as const) s.paths[k] = path.resolve(dir, s.paths[k]);
  return { file: fs.existsSync(f) ? f : null, ...s };
}

// pg connection settings for the configured database, or for database `name` (the tests' testName) with the same
// login. Throws when no password or URL is configured.
export function connectionSettings(db: DatabaseConfig, name = db.name): { connectionString: string } | Record<string, unknown> {
  if (db.url) {
    if (name === db.name) return { connectionString: db.url };
    const u = new URL(db.url);
    u.pathname = `/${name}`;
    return { connectionString: u.toString() };
  }
  if (!db.password) fail('No database password: set database.password in config.json (or DATABASE_URL)');
  return { host: db.host, port: db.port, user: db.user, password: db.password, database: name };
}

// The settings with passwords and URLs hidden, for --check-config and the debug log.
export function maskedConfig(c: ServerConfig): ServerConfig {
  return {
    ...c,
    database: { ...c.database, password: c.database.password ? '***' : '', url: c.database.url ? c.database.url.replace(/:[^:@/]*@/, ':***@') : '' },
  };
}
