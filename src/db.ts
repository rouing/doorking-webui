// Database: PostgreSQL through the pg driver. One folder, by default DB/ in the project, holds the connection URL
// (postgres.url, unless DATABASE_URL is set) and the encryption key (key, created on first use). The database holds
// the gate lists, gate-scoped prefs, sign-ins, history, saved DKS passwords, scheduled transfers, camera settings,
// the snapshot log, resident/vendor notes and the transaction history. Master codes and passwords are encrypted
// with AES-256-GCM using the key; anyone with the key and the database can decrypt them, so the folder must stay
// local and never be committed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

// Timestamps come back as ISO strings (as stored before), bigints (COUNT, identities) as numbers.
const parseTimestamptz = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v: string) => (parseTimestamptz(v) as Date).toISOString());
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export interface Queryable { query(text: string, values?: unknown[]): Promise<pg.QueryResult> }
// db: the pool, or inside transaction() the transaction's client.
export interface Store { dir: string; pool: pg.Pool; db: Queryable; key: Buffer; schema: string }

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
ALTER TABLE gate_cards ADD COLUMN IF NOT EXISTS raw_code TEXT;
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS area_codes JSONB NOT NULL DEFAULT '[]';
ALTER TABLE gate_working ADD COLUMN IF NOT EXISTS middle_pointer TEXT NOT NULL DEFAULT 'ffffff';
`;

const URL_FILE = 'postgres.url';
const KEY_FILE = 'key';
const stores = new Map<string, Promise<Store>>(); // folder + schema -> store

function readKey(dir: string): Buffer {
  const file = path.join(dir, KEY_FILE);
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error(`${file} is not a valid key (64 hex digits)`);
  return key;
}

// The connection URL: url, else DATABASE_URL, else <dir>/postgres.url.
function connectionUrl(dir: string, url?: string): string {
  const file = path.join(dir, URL_FILE);
  const u = url || process.env.DATABASE_URL || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
  if (!u) throw new Error(`No database configured: put the PostgreSQL connection URL in ${file} or set DATABASE_URL`);
  return u;
}

async function connect(d: string, url: string | undefined, schema: string): Promise<Store> {
  const key = readKey(d);
  const pool = new pg.Pool({
    connectionString: connectionUrl(d, url), max: 5,
    ...(schema !== 'public' && { options: `-c search_path=${schema}` }),
  });
  try {
    if (schema !== 'public') await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(SCHEMA);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
  return { dir: d, pool, db: pool, key, schema };
}

// Opens the database configured in `dir` (creating the key and the tables when missing). The same folder and
// schema always return the same store. schema: a separate schema (tests use one per store).
export function openStore(dir: string, { url, schema = 'public' }: { url?: string; schema?: string } = {}): Promise<Store> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name ${schema}`);
  const d = path.resolve(dir);
  const id = `${d}|${schema}`;
  if (!stores.has(id)) {
    fs.mkdirSync(d, { recursive: true });
    const p = connect(d, url, schema);
    p.catch(() => stores.delete(id));
    stores.set(id, p);
  }
  return stores.get(id)!;
}

export async function closeStore(store: Store): Promise<void> {
  stores.delete(`${store.dir}|${store.schema}`);
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

const readJsonFile = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export interface ImportCounts { gates: number; prefs: number; signIns: number; history: number }

// One-time import of the JSON files used before the database: gates.json, prefs.json, <root>/sign-ins.json
// and <root>/<phone>/history.jsonl. Returns the counts, or null when the import already ran.
// The JSON files are left in place.
export async function importJson(
  store: Store,
  { gatesFile, prefsFile, root }: { gatesFile?: string; prefsFile?: string; root?: string } = {},
): Promise<ImportCounts | null> {
  if (await getMeta(store, 'jsonImported')) return null;
  const counts: ImportCounts = { gates: 0, prefs: 0, signIns: 0, history: 0 };
  const now = new Date().toISOString();
  await transaction(store, async (tx) => {
    for (const [user, list] of Object.entries((gatesFile && readJsonFile(gatesFile)) || {})) {
      for (const g of Array.isArray(list) ? list : []) {
        if (!g || !g.phoneNumber || !g.masterCode) continue;
        await run(tx, `INSERT INTO gates (username, phone, master_code, added_at) VALUES ($1, $2, $3, $4)
          ON CONFLICT (username, phone) DO UPDATE SET master_code = excluded.master_code, added_at = excluded.added_at`,
        [String(user).trim().toLowerCase(), String(g.phoneNumber), encrypt(tx, g.masterCode), g.addedAt || now]);
        counts.gates++;
      }
    }
    for (const [phone, prefs] of Object.entries((prefsFile && readJsonFile(prefsFile)) || {})) {
      await run(tx, 'INSERT INTO prefs (phone, data) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET data = excluded.data',
        [phone, JSON.stringify(prefs || {})]);
      counts.prefs++;
    }
    if (root && fs.existsSync(root)) {
      const signIns: Record<string, { last?: string; count?: number }> = readJsonFile(path.join(root, 'sign-ins.json')) || {};
      for (const [user, v] of Object.entries(signIns)) {
        await run(tx, `INSERT INTO sign_ins (username, last, count) VALUES ($1, $2, $3)
          ON CONFLICT (username) DO UPDATE SET last = excluded.last, count = excluded.count`,
        [user, String(v.last || now), Number(v.count) || 0]);
        counts.signIns++;
      }
      for (const phone of fs.readdirSync(root).filter((n) => /^\d+$/.test(n))) {
        const file = path.join(root, phone, 'history.jsonl');
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          let e: { id?: string } | null;
          try { e = JSON.parse(line); } catch { continue; } // blank or damaged line
          if (!e || !e.id) continue;
          await run(tx, 'INSERT INTO history (id, phone, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
            [e.id, phone, JSON.stringify(e)]);
          counts.history++;
        }
      }
    }
    await setMeta(tx, 'jsonImported', now);
  });
  return counts;
}
