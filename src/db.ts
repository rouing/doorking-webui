// Database: PostgreSQL through the pg driver, connected as config.json says (config.ts), with the encryption key in
// its own file (paths.keyFile, created on first use). The database holds the gate lists, gate-scoped prefs,
// sign-ins, history, saved DKS passwords, scheduled transfers, camera settings, the snapshot log, resident/vendor
// notes, the transaction history and the gate files. Master codes, passwords and the gate files are encrypted with
// AES-256-GCM using the key; anyone with the key and the database can decrypt them, so the key file must stay
// private and never be committed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { checkPrivate } from './config.ts';

// Timestamps come back as ISO strings (as stored before), bigints (COUNT, identities) as numbers.
const parseTimestamptz = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v: string) => (parseTimestamptz(v) as Date).toISOString());
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export interface Queryable { query(text: string, values?: unknown[]): Promise<pg.QueryResult> }
// db: the pool, or inside transaction() the transaction's client.
export interface Store { id: string; pool: pg.Pool; db: Queryable; key: Buffer; schema: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS gates (username TEXT NOT NULL, phone TEXT NOT NULL, master_code TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL, verified_at TIMESTAMPTZ, PRIMARY KEY (username, phone));
CREATE INDEX IF NOT EXISTS gates_phone ON gates (phone);
CREATE TABLE IF NOT EXISTS prefs (phone TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS sign_ins (username TEXT PRIMARY KEY, last TIMESTAMPTZ NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS history (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS history_phone ON history (phone, seq);
CREATE TABLE IF NOT EXISTS credentials (username TEXT PRIMARY KEY, login TEXT NOT NULL, password TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, phone TEXT NOT NULL, username TEXT NOT NULL,
  data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, last_due TIMESTAMPTZ, last_run TIMESTAMPTZ, last_result TEXT,
  last_error TEXT);
CREATE INDEX IF NOT EXISTS schedules_phone ON schedules (phone);
CREATE TABLE IF NOT EXISTS cameras (phone TEXT PRIMARY KEY, data JSONB NOT NULL, password TEXT NOT NULL,
  saved_by TEXT NOT NULL, saved_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (phone TEXT NOT NULL, minute TEXT NOT NULL, status TEXT NOT NULL,
  files JSONB NOT NULL, error TEXT, attempts INTEGER NOT NULL, at TIMESTAMPTZ NOT NULL, shifts JSONB,
  video_attempts INTEGER NOT NULL DEFAULT 0, short JSONB, PRIMARY KEY (phone, minute));
CREATE TABLE IF NOT EXISTS notes (phone TEXT NOT NULL, code TEXT NOT NULL, note TEXT NOT NULL,
  saved_by TEXT NOT NULL, saved_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, code));
CREATE TABLE IF NOT EXISTS tx_history (phone TEXT NOT NULL, seq INTEGER NOT NULL, raw TEXT NOT NULL,
  year INTEGER NOT NULL, added_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, seq));
CREATE TABLE IF NOT EXISTS gate_files (phone TEXT NOT NULL, copy TEXT NOT NULL CHECK (copy IN ('pulled', 'base', 'working')),
  name TEXT NOT NULL, data BYTEA NOT NULL, saved_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, copy, name));
CREATE TABLE IF NOT EXISTS gate_residents (phone TEXT NOT NULL, seq INTEGER NOT NULL, directory_code TEXT NOT NULL,
  type TEXT NOT NULL, name TEXT NOT NULL, hidden BOOLEAN NOT NULL, area_code TEXT NOT NULL, phone_number TEXT NOT NULL,
  entry_code TEXT NOT NULL, security_level INTEGER, floor INTEGER, elevator_ref INTEGER, entry_offset INTEGER,
  record_offset INTEGER, PRIMARY KEY (phone, seq));
CREATE TABLE IF NOT EXISTS gate_cards (phone TEXT NOT NULL, slot INTEGER NOT NULL, card_number TEXT NOT NULL,
  directory_code TEXT, PRIMARY KEY (phone, slot));
CREATE TABLE IF NOT EXISTS gate_settings (phone TEXT NOT NULL, key TEXT NOT NULL, grp TEXT NOT NULL, name TEXT NOT NULL,
  value TEXT NOT NULL, PRIMARY KEY (phone, key));
CREATE TABLE IF NOT EXISTS gate_state (phone TEXT PRIMARY KEY, pulled_at TIMESTAMPTZ NOT NULL, checked_at TIMESTAMPTZ NOT NULL,
  round_trip_ok BOOLEAN NOT NULL, problems JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS gate_working (phone TEXT PRIMARY KEY, dir_digits INTEGER NOT NULL, area_code_mode INTEGER NOT NULL,
  area_codes JSONB NOT NULL, middle_pointer TEXT NOT NULL, base_ok BOOLEAN NOT NULL, saved_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, email TEXT UNIQUE,
  dark BOOLEAN NOT NULL, must_change BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by TEXT NOT NULL,
  last_sign_in TIMESTAMPTZ, sign_ins INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL, last_seen TIMESTAMPTZ NOT NULL, gate TEXT);
CREATE INDEX IF NOT EXISTS sessions_username ON sessions (username);
CREATE TABLE IF NOT EXISTS managed_gates (phone TEXT PRIMARY KEY, master_code TEXT NOT NULL, dks_user TEXT NOT NULL,
  dks_password TEXT NOT NULL, added_by TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS gate_access (phone TEXT NOT NULL REFERENCES managed_gates ON DELETE CASCADE,
  username TEXT NOT NULL REFERENCES users ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('admin', 'readonly')),
  granted_by TEXT NOT NULL, granted_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (phone, username));
CREATE INDEX IF NOT EXISTS gate_access_username ON gate_access (username);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, phone TEXT NOT NULL REFERENCES managed_gates ON DELETE CASCADE,
  name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin', 'readonly')), secret_hash TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS api_keys_phone ON api_keys (phone);
ALTER TABLE gate_cards ADD COLUMN IF NOT EXISTS raw_code TEXT;
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS area_codes JSONB NOT NULL DEFAULT '[]';
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS middle_pointer TEXT NOT NULL DEFAULT 'ffffff';
`;

const stores = new Map<string, Promise<Store>>(); // key file + connection + schema -> store

// The key from keyFile (64 hex digits), created when missing.
function readKey(file: string): Buffer {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  checkPrivate(file);
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error(`${file} is not a valid key (64 hex digits)`);
  return key;
}

export interface StoreOptions {
  connection: pg.PoolConfig; // from connectionSettings (config.ts)
  keyFile: string;
  schema?: string; // a separate schema (tests use one per store)
  poolSize?: number;
}

async function connect(id: string, { connection, keyFile, schema = 'public', poolSize = 5 }: StoreOptions): Promise<Store> {
  const key = readKey(keyFile);
  const pool = new pg.Pool({ ...connection, max: poolSize, ...(schema !== 'public' && { options: `-c search_path=${schema}` }) });
  try {
    if (schema !== 'public') await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(SCHEMA);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  return { id, pool, db: pool, key, schema };
}

// Opens the database (creating the key and the tables when missing). The same key file, connection and schema
// always return the same store.
export function openStore(opts: StoreOptions): Promise<Store> {
  const schema = opts.schema || 'public';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name ${schema}`);
  const keyFile = path.resolve(opts.keyFile);
  const id = `${keyFile}|${JSON.stringify(opts.connection)}|${schema}`;
  if (!stores.has(id)) {
    const p = connect(id, { ...opts, keyFile, schema });
    p.catch(() => stores.delete(id));
    stores.set(id, p);
  }
  return stores.get(id)!;
}

export async function closeStore(store: Store): Promise<void> {
  stores.delete(store.id);
  await store.pool.end();
}

export async function all<T>(store: Store, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await store.db.query(sql, params)).rows as T[];
}

export async function one<T>(store: Store, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await store.db.query(sql, params)).rows[0] as T | undefined;
}

// Runs a statement; returns the number of rows it changed.
export async function run(store: Store, sql: string, params: unknown[] = []): Promise<number> {
  return (await store.db.query(sql, params)).rowCount ?? 0;
}

// Runs fn inside one transaction; fn gets a store whose queries use the transaction.
export async function transaction<T>(store: Store, fn: (tx: Store) => Promise<T>): Promise<T> {
  if (store.db !== store.pool) return fn(store);
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn({ ...store, db: client });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// "v1:<iv>:<tag>:<ciphertext>", base64 parts.
export function encrypt(store: Store, text: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', store.key, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64') : p)).join(':');
}

// Bytes: 12-byte IV, 16-byte tag, then the ciphertext.
export function encryptBytes(store: Store, data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', store.key, iv);
  const out = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]);
}

export function decryptBytes(store: Store, data: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', store.key, data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]);
}

export function decrypt(store: Store, value: unknown): string {
  const [v, iv, tag, data] = String(value).split(':');
  if (v !== 'v1' || data === undefined) throw new Error('Not an encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', store.key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export async function getMeta(store: Store, key: string): Promise<string | null> {
  const row = await one<{ value: string }>(store, 'SELECT value FROM meta WHERE key = $1', [key]);
  return row ? row.value : null;
}

export async function setMeta(store: Store, key: string, value: unknown): Promise<void> {
  await run(store, 'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, String(value)]);
}
