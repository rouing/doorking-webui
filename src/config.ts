/**
 * @module src/config
 *
 * Server settings: config.json (by default in the project folder; --config or DOORKING_CONFIG for another path),
 * over the built-in defaults, validated with Zod. Environment variables and command-line flags override the file.
 * The file holds the database password, so it must be readable by its owner only (chmod 600), like the encryption
 * key next to it (paths.keyFile). Relative paths in the file are relative to the file's folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_URL } from './dks-cloud.ts';
import { GATE_DEFAULTS } from './gate-pull.ts';

export interface DatabaseConfig {
  url: string; // a full postgres:// URL; when set, host/port/name/user/password are not used
  host: string; port: number; name: string; user: string; password: string;
  poolSize: number;
  testName: string; // database the tests use (one throwaway schema per test), same login
}
/**
 * A single sign-on provider (OpenID Connect: Entra ID, Google Workspace, Okta, …). id: in its redirect address
 * (/api/sso/<id>/callback); name: on the "Sign in with …" button. allowedDomains: email domains whose accounts may be
 * matched by email, linked or created ([] = none matched by email: only invitations and linking from User Settings).
 * autoCreate: unknown people from allowedDomains get an account (no gate access). passwords: false = accounts linked
 * to this provider can't sign in with a password. maxAgeHours: refuse sign-ins whose authentication at the provider
 * (auth_time) is older than this (0 = no limit).
 */
export interface SsoRoleMap {
  /** ID token claim holding group/role names (default `'groups'`). */
  claim?: string;
  /** Group/role name -> `{ "<gatePhone or *>": "admin" | "editor" | "readonly" }`. */
  map: Record<string, Record<string, 'admin' | 'editor' | 'readonly'>>;
}
export interface SsoProvider {
  id: string; name: string; issuer: string; clientId: string; clientSecret: string;
  allowedDomains: string[]; autoCreate: boolean; passwords: boolean; maxAgeHours: number;
  strongAcrs?: string[];
  roleMap?: SsoRoleMap;
}
export interface ServerConfig {
  file: string | null; // the config file read, or null when there was none
  server: { host: string; port: number; publicHost: string; trustProxy: boolean };
  paths: { media: string; logs: string; keyFile: string }; // absolute
  database: DatabaseConfig;
  dks: { url: string };
  /** stepUpMinutes: how long a passkey confirmation covers the sensitive actions (see STEP_UP in requests.ts). */
  security: { sessionIdleMinutes: number; sessionMaxHours: number; maxFailedSignIns: number; signInWindowMinutes: number; stepUpMinutes: number };
  schedules: { checkSeconds: number };
  cameras: { ffmpeg: string; tidyMinutes: number }; // ffmpeg: '' = tools/bin, else ffmpeg on the PATH; a path is absolute
  /**
   * SMTP for account emails and gate alerts; host '' = email off. security: 'starttls' (port 587), 'tls' (465) or
   * 'none'. appUrl: the address links in emails point to ('' = https://<server.publicHost>).
   */
  email: { host: string; port: number; security: string; user: string; password: string; from: string; appUrl: string };
  /** Optional VAPID keys for Web Push; when blank, keys are auto-generated and saved in PostgreSQL `meta`. */
  push: { vapidPublicKey: string; vapidPrivateKey: string; subject: string };
  /** Optional native Android app verification (`/.well-known/assetlinks.json`, WebAuthn `android:apk-key-hash:` origins, and `/download` APK path). */
  android: { packageName: string; sha256CertFingerprints: string[]; apkPath: string };
  sso: { providers: SsoProvider[] };
  gateDefaults: typeof GATE_DEFAULTS;
}

const ROOT = path.join(import.meta.dirname, '..');
export const CONFIG_FILE = path.join(ROOT, 'config.json');

function fail(msg: string): never { throw new Error(msg); }
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const textField = (def: string) => z.string({ error: 'must be text (in quotes)' }).default(def);
const requiredText = () => z.string({ error: 'must be text (required)' }).trim().min(1, { error: 'must be text (required)' });
const intRange = (min: number, max: number, def: number) =>
  z.int({ error: `must be a whole number from ${min} to ${max}` })
    .min(min, { error: `must be a whole number from ${min} to ${max}` })
    .max(max, { error: `must be a whole number from ${min} to ${max}` })
    .default(def);

const objError = { error: 'must be an object' };

const SsoProviderSchema = z.strictObject({
  id: requiredText().transform((value) => value.toLowerCase()).refine((value) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(value), {
    error: 'must be 1-32 lower-case letters, digits or dashes',
  }),
  name: requiredText(),
  issuer: requiredText().superRefine((value, ctx) => {
    let url: URL;
    try { url = new URL(value); } catch { ctx.addIssue({ code: 'custom', message: 'must be a URL' }); return; }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      ctx.addIssue({ code: 'custom', message: 'must be an https:// URL' });
      return;
    }
    if (url.hostname === 'login.microsoftonline.com' && /^\/(common|organizations|consumers)(\/|$)/i.test(url.pathname)) {
      ctx.addIssue({ code: 'custom', message: 'must name your Entra tenant (https://login.microsoftonline.com/<tenant ID>/v2.0), not common, organizations or consumers' });
    }
  }),
  clientId: requiredText(),
  clientSecret: z.string({ error: 'must be text' }).trim().default(''),
  allowedDomains: z.array(z.string().regex(DOMAIN_RE), { error: 'must be a list of domains such as ["example.com"]' })
    .default([])
    .transform((list) => list.map((domain) => domain.toLowerCase())),
  autoCreate: z.boolean({ error: 'must be true or false' }).default(false),
  passwords: z.boolean({ error: 'must be true or false' }).default(true),
  maxAgeHours: z.int({ error: 'must be a whole number of hours, 0-720 (0 = no limit)' })
    .min(0, { error: 'must be a whole number of hours, 0-720 (0 = no limit)' })
    .max(720, { error: 'must be a whole number of hours, 0-720 (0 = no limit)' })
    .default(0),
  strongAcrs: z.array(z.string().min(1)).optional(),
  roleMap: z.strictObject({
    claim: z.string().min(1).optional(),
    map: z.record(z.string(), z.record(z.string(), z.enum(['admin', 'editor', 'readonly']))),
  }, objError).optional(),
}, objError).superRefine((provider, ctx) => {
  if (provider.autoCreate && !provider.allowedDomains.length) {
    ctx.addIssue({ code: 'custom', path: ['autoCreate'], message: 'needs allowedDomains' });
  }
});

const SsoSectionSchema = z.strictObject({
  providers: z.array(SsoProviderSchema, { error: 'must be a list' }).default([]).superRefine((providers, ctx) => {
    const seen = new Set<string>();
    for (const provider of providers) {
      if (seen.has(provider.id)) ctx.addIssue({ code: 'custom', message: `two providers have the id "${provider.id}"` });
      seen.add(provider.id);
    }
  }),
}, objError).default({ providers: [] });

const ConfigSchema = z.strictObject({
  server: z.strictObject({
    host: textField('127.0.0.1'),
    port: intRange(1, 65535, 8080),
    publicHost: textField(''),
    trustProxy: z.boolean({ error: 'must be true or false' }).default(false),
  }, objError).prefault({}),
  paths: z.strictObject({
    media: textField('media'),
    logs: textField('logs'),
    keyFile: textField('doorking.key'),
  }, objError).prefault({}),
  database: z.strictObject({
    url: textField(''),
    host: textField('127.0.0.1'),
    port: intRange(1, 65535, 5432),
    name: textField('doorking'),
    user: textField('doorking'),
    password: textField(''),
    poolSize: intRange(1, 100, 5),
    testName: textField('doorking_test'),
  }, objError).prefault({}),
  dks: z.strictObject({
    url: textField(DEFAULT_URL),
  }, objError).prefault({}),
  security: z.strictObject({
    sessionIdleMinutes: intRange(1, 1440, 30),
    sessionMaxHours: intRange(1, 8760, 168),
    maxFailedSignIns: intRange(1, 100, 5),
    signInWindowMinutes: intRange(1, 1440, 15),
    stepUpMinutes: intRange(5, 1440, 180),
  }, objError).prefault({}),
  schedules: z.strictObject({
    checkSeconds: intRange(5, 3600, 30),
  }, objError).prefault({}),
  cameras: z.strictObject({
    ffmpeg: textField(''),
    tidyMinutes: intRange(5, 1440, 60),
  }, objError).prefault({}),
  email: z.strictObject({
    host: textField(''),
    port: intRange(1, 65535, 587),
    security: textField('starttls'),
    user: textField(''),
    password: textField(''),
    from: textField(''),
    appUrl: textField(''),
  }, objError).prefault({}),
  push: z.strictObject({
    vapidPublicKey: textField(''),
    vapidPrivateKey: textField(''),
    subject: textField(''),
  }, objError).prefault({}),
  android: z.strictObject({
    packageName: textField('').refine((value) => !value || /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value), {
      error: 'must be a valid Android applicationId such as "com.doorking.gate"',
    }),
    sha256CertFingerprints: z.array(
      z.string().trim().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/i, {
        error: 'must be colon-separated SHA-256 hex (32 bytes, e.g. "AA:BB:...")',
      }).transform((value) => value.toUpperCase()),
      { error: 'must be a list of SHA-256 certificate fingerprints' },
    ).default([]),
    apkPath: textField(''),
  }, objError).prefault({}),
  sso: SsoSectionSchema,
  gateDefaults: z.strictObject({
    siteName: textField(GATE_DEFAULTS.siteName),
    memorySize: textField(GATE_DEFAULTS.memorySize),
    areaCodes: textField(GATE_DEFAULTS.areaCodes),
    modelNumber: textField(GATE_DEFAULTS.modelNumber),
    antiPassBack: textField(GATE_DEFAULTS.antiPassBack),
    interface1816: textField(GATE_DEFAULTS.interface1816),
    dialDelay: textField(GATE_DEFAULTS.dialDelay),
  }, objError).prefault({}),
});

function formatPath(parts: PropertyKey[]): string {
  let out = '';
  for (const part of parts) {
    out += typeof part === 'number' ? `[${part}]` : out ? `.${String(part)}` : String(part);
  }
  return out;
}

function formatConfigError(error: z.ZodError, where: string): string {
  const issue = error.issues[0];
  const at = formatPath(issue.path);
  if (issue.code === 'unrecognized_keys') {
    const key = issue.keys[0];
    return at ? `${where}: unknown setting "${at}.${key}"` : `${where}: unknown section "${key}"`;
  }
  if (issue.path.includes('allowedDomains')) {
    const base = formatPath(issue.path.slice(0, issue.path.indexOf('allowedDomains') + 1));
    return `${where}: "${base}" must be a list of domains such as ["example.com"]`;
  }
  if (issue.message.startsWith('two providers')) return `${where}: ${issue.message}`;
  return at ? `${where}: "${at}" ${issue.message}` : `${where}: ${issue.message}`;
}

/**
 * On Linux/macOS a file holding secrets must not be readable by other users.
 *
 * @param file - File path or filename.
 */
export function checkPrivate(file: string): void {
  if (process.platform === 'win32' || !fs.existsSync(file)) return;
  if (fs.statSync(file).mode & 0o077) fail(`${file} can be read by other users. Run: chmod 600 ${file}`);
}

export interface LoadOptions { file?: string; env?: NodeJS.ProcessEnv; args?: string[] }

/**
 * Loads and validates the effective server configuration: defaults < config file < environment variables < CLI flags.
 *
 * @param [options] - Configuration loader options.
 * @param [options.file] - Explicit path to `config.json` (defaults to `--config`, `DOORKING_CONFIG`, or project `config.json`).
 * @param [options.env] - Environment variables map (defaults to `process.env`).
 * @param [options.args] - Command-line arguments (defaults to `process.argv.slice(2)`).
 * @returns Validated `ServerConfig`.
 * @throws Error when the config file, permissions, or any setting value is invalid.
 */
export function loadConfig({ file: given, env = process.env, args = process.argv.slice(2) }: LoadOptions = {}): ServerConfig {
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const chosen = given || flag('--config') || env.DOORKING_CONFIG;
  const configFile = path.resolve(chosen || CONFIG_FILE);
  let raw: unknown = {};
  if (!fs.existsSync(configFile) && chosen) fail(`Config file ${configFile} not found`);
  if (fs.existsSync(configFile)) {
    try { raw = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (err) { fail(`${configFile} is not valid JSON: ${(err as Error).message}`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${configFile} must hold a JSON object`);
    checkPrivate(configFile);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) fail(formatConfigError(parsed.error, configFile));
  const sections = parsed.data;
  const dir = path.dirname(configFile);
  const parsePort = (value: string, key: string) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`${key} must be a whole number from 0 to 65535`);
    return port;
  };
  const parseBool = (value: string, key: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0' || normalized === '') return false;
    fail(`${key} must be true or false`);
  };
  if (env.HOST !== undefined) sections.server.host = env.HOST;
  if (env.PORT) sections.server.port = parsePort(env.PORT, 'PORT');
  if (env.PUBLIC_HOST !== undefined) sections.server.publicHost = env.PUBLIC_HOST;
  if (env.TRUST_PROXY !== undefined) sections.server.trustProxy = parseBool(env.TRUST_PROXY, 'TRUST_PROXY');
  if (env.MEDIA_DIR) sections.paths.media = env.MEDIA_DIR;
  if (env.LOGS_DIR) sections.paths.logs = env.LOGS_DIR;
  if (env.KEY_FILE) sections.paths.keyFile = env.KEY_FILE;
  if (env.DATABASE_URL) sections.database.url = env.DATABASE_URL;
  if (env.DKS_URL) sections.dks.url = env.DKS_URL;
  if (flag('--host') !== undefined) sections.server.host = flag('--host')!;
  if (flag('--port')) sections.server.port = parsePort(flag('--port')!, '--port');
  if (flag('--public-host') !== undefined) sections.server.publicHost = flag('--public-host')!;
  if (flag('--media')) sections.paths.media = flag('--media')!;
  if (flag('--logs')) sections.paths.logs = flag('--logs')!;
  if (flag('--key-file')) sections.paths.keyFile = flag('--key-file')!;
  const gateFlags: [string, keyof ServerConfig['gateDefaults']][] = [['--site-name', 'siteName'], ['--memory', 'memorySize'],
    ['--area-codes', 'areaCodes'], ['--anti-passback', 'antiPassBack'], ['--interface-1816', 'interface1816'], ['--model', 'modelNumber']];
  for (const [name, key] of gateFlags) {
    if (flag(name)) sections.gateDefaults[key] = flag(name)!;
  }
  sections.server.host = String(sections.server.host).trim();
  if (!sections.server.host) fail(`${configFile}: "server.host" must not be empty`);
  sections.server.publicHost = String(sections.server.publicHost).trim().toLowerCase();
  for (const key of ['media', 'logs', 'keyFile'] as const) sections.paths[key] = path.resolve(dir, sections.paths[key]);
  if (!['starttls', 'tls', 'none'].includes(sections.email.security)) fail(`${configFile}: "email.security" must be starttls, tls or none`);
  if (sections.email.host && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$|<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(sections.email.from)) {
    fail(`${configFile}: "email.from" must be an address such as "DoorKing Gate Manager <gate@example.com>" when email.host is set`);
  }
  sections.email.appUrl = String(sections.email.appUrl || (sections.server.publicHost ? `https://${sections.server.publicHost}` : `http://localhost:${sections.server.port}`)).replace(/\/+$/, '');
  // A path (with a folder) is relative to the config file's folder; a bare name such as "ffmpeg" is looked up on the PATH.
  if (/[\\/]/.test(sections.cameras.ffmpeg)) sections.cameras.ffmpeg = path.resolve(dir, sections.cameras.ffmpeg);
  if (sections.android.apkPath.trim()) sections.android.apkPath = path.resolve(dir, sections.android.apkPath.trim());
  return { file: fs.existsSync(configFile) ? configFile : null, ...sections };
}

/**
 * pg connection settings for the configured database, or for database `name` (the tests' testName) with the same
 * login. Throws when no password or URL is configured.
 *
 * @param db - Database configuration.
 * @param [name] - Display name or filename.
 * @returns `{ connectionString: string } | Record<string, unknown>` result.
 */
export function connectionSettings(db: DatabaseConfig, name = db.name): { connectionString: string } | Record<string, unknown> {
  if (db.url) {
    if (name === db.name) return { connectionString: db.url };
    const url = new URL(db.url);
    url.pathname = `/${name}`;
    return { connectionString: url.toString() };
  }
  if (!db.password) fail('No database password: set database.password in config.json (or DATABASE_URL)');
  return { host: db.host, port: db.port, user: db.user, password: db.password, database: name };
}

/**
 * The app's login and database name, from database.url when set, else the separate fields.
 *
 * @param db - Database configuration.
 * @returns `{ user: string; password: string; name: string }` result.
 */
export function databaseLogin(db: DatabaseConfig): { user: string; password: string; name: string } {
  if (!db.url) return { user: db.user, password: db.password, name: db.name };
  const url = new URL(db.url);
  return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), name: decodeURIComponent(url.pathname.slice(1)) };
}

/**
 * The settings with passwords and URLs hidden, for --check-config and the server log.
 *
 * @param config - Validated server configuration.
 * @returns `ServerConfig` result.
 */
export function maskedConfig(config: ServerConfig): ServerConfig {
  return {
    ...config,
    database: { ...config.database, password: config.database.password ? '***' : '', url: config.database.url ? config.database.url.replace(/:[^:@/]*@/, ':***@') : '' },
    email: { ...config.email, password: config.email.password ? '***' : '' },
    push: { ...config.push, vapidPrivateKey: config.push.vapidPrivateKey ? '***' : '' },
    sso: { providers: config.sso.providers.map((provider) => ({ ...provider, clientSecret: provider.clientSecret ? '***' : '' })) },
  };
}
