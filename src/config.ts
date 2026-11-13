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
// A single sign-on provider (OpenID Connect: Entra ID, Google Workspace, Okta, …). id: in its redirect address
// (/api/sso/<id>/callback); name: on the "Sign in with …" button. allowedDomains: email domains whose accounts may be
// matched by email, linked or created ([] = none matched by email: only invitations and linking from User Settings).
// autoCreate: unknown people from allowedDomains get an account (no gate access). passwords: false = accounts linked
// to this provider can't sign in with a password.
export interface SsoProvider {
  id: string; name: string; issuer: string; clientId: string; clientSecret: string;
  allowedDomains: string[]; autoCreate: boolean; passwords: boolean;
}
export interface ServerConfig {
  file: string | null; // the config file read, or null when there was none
  server: { port: number; publicHost: string };
  paths: { media: string; logs: string; keyFile: string }; // absolute
  database: DatabaseConfig;
  dks: { url: string };
  security: { sessionIdleMinutes: number; maxFailedSignIns: number; signInWindowMinutes: number };
  schedules: { checkSeconds: number };
  cameras: { ffmpeg: string; tidyMinutes: number }; // ffmpeg: '' = tools/bin, else ffmpeg on the PATH; a path is absolute
  // SMTP for account emails and gate alerts; host '' = email off. security: 'starttls' (port 587), 'tls' (465) or
  // 'none'. appUrl: the address links in emails point to ('' = https://<server.publicHost>).
  email: { host: string; port: number; security: string; user: string; password: string; from: string; appUrl: string };
  sso: { providers: SsoProvider[] };
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
  email: { host: '', port: 587, security: 'starttls', user: '', password: '', from: '', appUrl: '' },
  sso: { providers: [] as SsoProvider[] },
  gateDefaults: { ...GATE_DEFAULTS },
};
type Section = keyof typeof DEFAULTS;
// Whole numbers and their allowed range; every other setting is text.
const RANGES: Record<string, [number, number]> = {
  'server.port': [1, 65535], 'database.port': [1, 65535], 'database.poolSize': [1, 100],
  'security.sessionIdleMinutes': [1, 1440], 'security.maxFailedSignIns': [1, 100], 'security.signInWindowMinutes': [1, 1440],
  'schedules.checkSeconds': [5, 3600], 'cameras.tidyMinutes': [5, 1440], 'email.port': [1, 65535],
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

const PROVIDER_KEYS = ['id', 'name', 'issuer', 'clientId', 'clientSecret', 'allowedDomains', 'autoCreate', 'passwords'];
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Checks the sso section: { providers: [SsoProvider, …] }.
function ssoSection(given: unknown, where: string): { providers: SsoProvider[] } {
  if (given === undefined) return { providers: [] };
  if (!isObject(given)) fail(`${where}: "sso" must be an object`);
  const g = given as Record<string, unknown>;
  for (const k of Object.keys(g)) if (k !== 'providers') fail(`${where}: unknown setting "sso.${k}"`);
  const list = g.providers ?? [];
  if (!Array.isArray(list)) fail(`${where}: "sso.providers" must be a list`);
  const ids = new Set<string>();
  return { providers: (list as unknown[]).map((item, i): SsoProvider => {
    const at = `sso.providers[${i}]`;
    if (!isObject(item)) return fail(`${where}: "${at}" must be an object`);
    const p = item;
    for (const k of Object.keys(p)) if (!PROVIDER_KEYS.includes(k)) fail(`${where}: unknown setting "${at}.${k}"`);
    const text = (k: string, required = true): string => {
      const v = p[k];
      if (v === undefined && !required) return '';
      if (typeof v !== 'string' || (required && !v.trim())) fail(`${where}: "${at}.${k}" must be text${required ? ' (required)' : ''}`);
      return (v as string).trim();
    };
    const flag = (k: string, def: boolean): boolean => {
      if (p[k] === undefined) return def;
      if (typeof p[k] !== 'boolean') fail(`${where}: "${at}.${k}" must be true or false`);
      return p[k] as boolean;
    };
    const id = text('id').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) fail(`${where}: "${at}.id" must be 1-32 lower-case letters, digits or dashes`);
    if (ids.has(id)) fail(`${where}: two providers have the id "${id}"`);
    ids.add(id);
    const issuer = text('issuer');
    let u: URL | null = null;
    try { u = new URL(issuer); } catch { fail(`${where}: "${at}.issuer" must be a URL`); }
    const local = u!.hostname === 'localhost' || u!.hostname === '127.0.0.1';
    if (u!.protocol !== 'https:' && !(u!.protocol === 'http:' && local)) fail(`${where}: "${at}.issuer" must be an https:// URL`);
    if (u!.hostname === 'login.microsoftonline.com' && /^\/(common|organizations|consumers)(\/|$)/i.test(u!.pathname)) {
      fail(`${where}: "${at}.issuer" must name your Entra tenant (https://login.microsoftonline.com/<tenant ID>/v2.0), not common, organizations or consumers`);
    }
    const domains = p.allowedDomains ?? [];
    if (!Array.isArray(domains) || domains.some((d) => typeof d !== 'string' || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d))) {
      fail(`${where}: "${at}.allowedDomains" must be a list of domains such as ["example.com"]`);
    }
    const autoCreate = flag('autoCreate', false);
    if (autoCreate && !(domains as string[]).length) fail(`${where}: "${at}.autoCreate" needs allowedDomains`);
    return { id, name: text('name'), issuer, clientId: text('clientId'), clientSecret: text('clientSecret', false),
      allowedDomains: (domains as string[]).map((d) => d.toLowerCase()), autoCreate, passwords: flag('passwords', true) };
  }) };
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
  const s = Object.fromEntries((Object.keys(DEFAULTS) as Section[]).map((k) => [k, k === 'sso' ? ssoSection(raw[k], f) : section(k, raw[k], f)])) as any;
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
  if (!['starttls', 'tls', 'none'].includes(s.email.security)) fail(`${f}: "email.security" must be starttls, tls or none`);
  if (s.email.host && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$|<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(s.email.from)) {
    fail(`${f}: "email.from" must be an address such as "DoorKing Gate Manager <gate@example.com>" when email.host is set`);
  }
  s.email.appUrl = String(s.email.appUrl || (s.server.publicHost ? `https://${s.server.publicHost}` : `http://localhost:${s.server.port}`)).replace(/\/+$/, '');
  // A path (with a folder) is relative to the file's folder; a bare name such as "ffmpeg" is looked up on the PATH.
  if (/[\\/]/.test(s.cameras.ffmpeg)) s.cameras.ffmpeg = path.resolve(dir, s.cameras.ffmpeg);
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

// The app's login and database name, from database.url when set, else the separate fields.
export function databaseLogin(db: DatabaseConfig): { user: string; password: string; name: string } {
  if (!db.url) return { user: db.user, password: db.password, name: db.name };
  const u = new URL(db.url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), name: decodeURIComponent(u.pathname.slice(1)) };
}

// The settings with passwords and URLs hidden, for --check-config and the debug log.
export function maskedConfig(c: ServerConfig): ServerConfig {
  return {
    ...c,
    database: { ...c.database, password: c.database.password ? '***' : '', url: c.database.url ? c.database.url.replace(/:[^:@/]*@/, ':***@') : '' },
    email: { ...c.email, password: c.email.password ? '***' : '' },
    sso: { providers: c.sso.providers.map((p) => ({ ...p, clientSecret: p.clientSecret ? '***' : '' })) },
  };
}
