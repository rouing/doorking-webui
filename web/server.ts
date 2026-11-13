#!/usr/bin/env node

// Localhost-only web UI and REST API for gate pulls (and confirmed sends of the working copy) through DKS Cloud.
// DKS credentials are kept in memory for the browser session; a user's password is written to disk (encrypted)
// only when they save a scheduled transfer. Gate lists, prefs, sign-ins, history, saved passwords and schedules
// are kept in the local database (see src/db.ts). Gate routes are scoped by path (/api/gates/<phone>/...); a
// gate's saved data opens to a user after their first successful connection to it (see the route scopes).
// Scheduled transfers run here, unattended. After each transactions pull, camera snapshots are saved for gates
// with camera settings (see src/cameras.ts). The REST API is documented in docs/API.md.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as dk from '../index.ts';
import { loadData, residents, residentRows, type GateFiles } from './data.ts';
import { helpPage } from '../src/markdown.ts';
import type { BoardBuffers } from '../src/residents-edit.ts';
import type { GateEntry } from '../src/gate-list.ts';
import type { Patch, RecordChange } from '../src/audit.ts';
import type { ValuesPatch } from '../src/gate-state.ts';
import type { CacheStatus } from '../src/gate-cache.ts';
import type { SnapshotProgress, SnapshotResult } from '../src/cameras.ts';
import type { GateSetting } from '../src/gate-settings.ts';
import type { CameraChannel, DeviceRange, GateConfig, GateFeatures, GatePrefs, GateTracker, ResidentRow, Schedule } from '../src/types.ts';

type Body = Record<string, any>; // request JSON, checked by each handler
type Reply = readonly [number, unknown];
interface SessionData { user: string; password: string; lastSeen: number; gate?: string }
interface Session { token: string; raw: SessionData; user: string; password: string }
type Gate = GateEntry & { verified: boolean; user: string; password: string; dir: string };
interface JobState {
  state: 'idle' | 'running' | 'done' | 'failed'; what?: string; phoneNumber?: string; user?: string;
  startedAt?: Date; finishedAt?: Date; log: string[]; error?: string;
}
interface JobInfo { scheduled?: boolean; details?: RecordChange[] }
interface SnapRun {
  state: 'running' | 'done' | 'stopped' | 'failed'; startedAt: Date; finishedAt?: Date; log: string[]; minute?: string;
  progress?: SnapshotProgress; result?: SnapshotResult | null; error?: string; again?: boolean; stopping?: boolean;
  done: Promise<SnapRun>;
}
interface PrefsChange { before: Record<string, unknown>; after: Record<string, unknown> }

const HERE = import.meta.dirname;
// Settings: config.json, environment variables and flags (src/config.ts). --check-config prints them and exits.
let CONFIG: dk.ServerConfig;
try { CONFIG = dk.loadConfig(); } catch (e) {
  console.error(`Configuration error: ${(e as Error).message}`);
  process.exit(1);
}
if (process.argv.includes('--check-config')) {
  console.log(JSON.stringify(dk.maskedConfig(CONFIG), null, 2));
  process.exit(0);
}
const HOST = '127.0.0.1';
const PORT = CONFIG.server.port;
// Public name served by an HTTPS reverse proxy (Caddy) in front of this server, e.g. gate.example.com. Empty = local only.
const PUBLIC_HOST = CONFIG.server.publicHost;
const ROOT = CONFIG.paths.media; // one folder per gate: media/<phone digits>
const LOG_DIR = CONFIG.paths.logs; // debug.log
let STORE: dk.Store;
try {
  STORE = await dk.openStore({ connection: dk.connectionSettings(CONFIG.database), keyFile: CONFIG.paths.keyFile, poolSize: CONFIG.database.poolSize });
} catch (e) {
  console.error(`Database not available: ${(e as Error).message}`);
  process.exit(1);
}
// The Debug logs setting, kept in memory so writing a line never waits for the database.
let debugOn = await dk.debugLogEnabled(STORE);
const DEBUG = dk.createDebugLog(path.join(LOG_DIR, 'debug.log'), { enabled: () => debugOn });
const backfilled = await dk.backfillGateVerified(STORE);
if (backfilled) {
  console.log(`Marked ${backfilled} gate(s) as connected from history`);
  DEBUG.write('server', `Marked ${backfilled} gate(s) as connected from history`);
}
const DIST = path.join(HERE, 'dist'); // the web page, built from web/ui by `npm run build`
const IDLE_MS = CONFIG.security.sessionIdleMinutes * 60000;
const MAX_BODY_BYTES = 10000;
// Failed sign-ins per user name: after MAX_FAILED_SIGN_INS within SIGN_IN_WINDOW_MS, sign-in is refused for the
// rest of the window without asking DKS Cloud, so a guessing script cannot get the DKS account locked.
const MAX_FAILED_SIGN_INS = CONFIG.security.maxFailedSignIns;
const SIGN_IN_WINDOW_MS = CONFIG.security.signInWindowMinutes * 60000;
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};
const NOT_BUILT = 'The web page is not built yet. Run `npm run build` in the project folder, then reload.';

// [file, content type] for the page or an asset URL, or null (for / when the page isn't built).
function staticFile(pathname: string): [string, string] | null {
  if (pathname === '/') {
    const built = path.join(DIST, 'index.html');
    return fs.existsSync(built) ? [built, 'text/html'] : null;
  }
  const m = /^\/assets\/([\w.-]+)$/.exec(pathname);
  const type = m && ASSET_TYPES[path.extname(m[1])];
  if (!m || !type) return null;
  const file = path.join(DIST, 'assets', m[1]);
  return fs.existsSync(file) ? [file, type] : null;
}

// Gate-match defaults for the login form; the browser can override them in the Connect panel.
const defaults = CONFIG.gateDefaults;
const client = () => new dk.DksCloudClient({ url: CONFIG.dks.url, log: (m) => DEBUG.write('dks', m) });
const CAMERAS = dk.createCameraRunner({ ffmpegPath: CONFIG.cameras.ffmpeg, log: (m) => DEBUG.write('camera', m) });

// token -> { user, password, lastSeen, gate? }; gate is the phone number the web UI has open.
const sessions = new Map<string, SessionData>();
const failedSignIns = new Map<string, number[]>(); // user (lower case) -> times of recent failed sign-ins
let job: JobState = { state: 'idle', log: [] }; // one gate connection at a time, across all gates

const recentFailures = (user: string): number[] => (failedSignIns.get(user) || []).filter((t) => Date.now() - t < SIGN_IN_WINDOW_MS);

// Ends idle sessions, so a DKS password does not stay in memory once its session has expired.
function sweepSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.lastSeen <= IDLE_MS) continue;
    sessions.delete(token);
    DEBUG.write('session', `${s.user} signed out after ${IDLE_MS / 60000} minutes idle`);
  }
  for (const user of failedSignIns.keys()) if (!recentFailures(user).length) failedSignIns.delete(user);
}

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Inline styles only: Radix dialogs add a <style> element that stops the page scrolling behind them.
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body as string | Buffer);
}

// The request's JSON object body. Over MAX_BODY_BYTES: 413 (the rest of the body is read and dropped, so the
// reply still reaches the client). Anything but a JSON object: 400.
function readJson(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return reject(new Error('Bad JSON')); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new Error('The body must be a JSON object'));
      return resolve(body as Body);
    });
    req.on('error', reject);
  });
}

function currentSession(req: IncomingMessage): Session | null {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.lastSeen > IDLE_MS) {
    sessions.delete(m[1]);
    DEBUG.write('session', `${s.user} signed out after ${IDLE_MS / 60000} minutes idle`);
    return null;
  }
  s.lastSeen = Date.now();
  return { token: m[1], raw: s, user: s.user, password: s.password };
}

// The gate named in the URL, from the signed-in user's list, with the session's DKS credentials. verified: this
// user has connected to the gate successfully with the master code in their list (see the route scopes).
async function gateFor(s: { user: string; password: string }, phone: unknown): Promise<Gate> {
  const g = await dk.findGate(STORE, s.user, phone);
  if (!g) throw Object.assign(new Error('Gate not in your list'), { status: 404 });
  return { ...g, verified: Boolean(g.verifiedAt), user: s.user, password: s.password, dir: path.join(ROOT, g.phoneNumber) };
}

const prefsOf = (phone: unknown): Promise<GatePrefs> => dk.getPrefs(STORE, phone);
const siteNameOf = async (phone: unknown): Promise<string> => ((await prefsOf(phone)).gateConfig || {}).siteName || '';
// The site name is shown only once the user has connected to the gate.
const gateInfo = async (g: GateEntry) => ({ phoneNumber: g.phoneNumber, siteName: g.verifiedAt ? await siteNameOf(g.phoneNumber) : '',
  addedAt: g.addedAt, verified: Boolean(g.verifiedAt) });

// Runs fn after the gate's earlier queued work: changes to a gate's working copy and prefs run one at a time, so
// each History entry holds exactly its own change.
const gateQueues = new Map<string, Promise<unknown>>();
function serial<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const p = (gateQueues.get(phone) || Promise.resolve()).catch(() => {}).then(fn);
  gateQueues.set(phone, p);
  p.catch(() => {}).finally(() => { if (gateQueues.get(phone) === p) gateQueues.delete(phone); });
  return p;
}
const NOT_CONNECTED = 'Pull residents or transactions from this gate first. Its saved data opens after your first successful connection with this master code.';

const GATE_CONFIG_KEYS: (keyof GateConfig)[] = ['siteName', 'memorySize', 'areaCodes', 'modelNumber', 'antiPassBack', 'interface1816'];
const AREA_CODE_SETTINGS = ['10 Area Codes', '255 Area Codes'];

type SessionRequest = ReturnType<typeof dk.buildSessionRequest>;

// The gate-match config lives in the gate-scoped prefs (keyed by phone number), set under System Settings.
async function sessionRequest(g: Gate, what: string, extra: Record<string, unknown> = {}): Promise<SessionRequest> {
  const cfg: Partial<GateConfig> = (await prefsOf(g.phoneNumber)).gateConfig || {};
  const chosen = Object.fromEntries(GATE_CONFIG_KEYS
    .filter((k) => typeof cfg[k] === 'string' && cfg[k].trim())
    .map((k) => [k, (cfg[k] as string).trim()]));
  return dk.buildSessionRequest(what, {
    ...defaults,
    ...chosen,
    ...extra,
    user: g.user, password: g.password, phoneNumber: g.phoneNumber, masterCode: g.masterCode,
  });
}

// Starts the one gate connection: the job is claimed at once, then makeRequest() builds the DKS session request and
// run(log, request) does the work. The job's state and log are read via GET .../job.
// When it ends, it is recorded in the gate's history (info adds fields to that entry; scheduled: true marks a
// scheduled transfer). Returns a promise of the finished job.
function startJob(g: Gate, what: string, makeRequest: () => Promise<SessionRequest>,
  run: (log: (line: string) => void, request: SessionRequest) => Promise<void>, info: JobInfo = {}): Promise<JobState> {
  const startedAt = new Date();
  const j: JobState = { state: 'running', what, phoneNumber: g.phoneNumber, user: g.user, startedAt, log: [] };
  job = j;
  // Each job line also goes to the debug log, except a status repeated while the gate is polled.
  let lastLine = '';
  const log = (line: string) => {
    j.log.push(`${new Date().toLocaleTimeString('en-US')}  ${line}`);
    if (line !== lastLine) DEBUG.write('gate', `Gate ${g.phoneNumber}: ${line}`);
    lastLine = line;
  };
  return (async () => {
    const request = await makeRequest();
    log(`Starting ${info.scheduled ? 'scheduled ' : ''}${what === 'send' ? 'send' : `${what} pull`} by ${g.user}: ${JSON.stringify(dk.maskRequest(request, g.user))}`);
    await run(log, request);
  })()
    .then(() => { j.state = 'done'; })
    .catch((e) => { log(`Error: ${e.message}`); j.state = 'failed'; j.error = e.message; })
    .then(async () => {
      const finishedAt = new Date();
      j.finishedAt = finishedAt;
      DEBUG.write('gate', `Gate ${g.phoneNumber}: ${what} ${info.scheduled ? '(scheduled) ' : ''}${j.state} after ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)} s`);
      if (j.state === 'done') {
        try {
          const cur = await dk.findGate(STORE, g.user, g.phoneNumber);
          if (cur && cur.masterCode === g.masterCode) await dk.markGateVerified(STORE, g.user, g.phoneNumber);
        } catch (e) { console.error(`Gate connection not recorded: ${(e as Error).message}`); DEBUG.write('server', `Gate connection not recorded: ${(e as Error).message}`); }
      }
      const action = what === 'send' ? 'send' : 'pull';
      const summary = `${what === 'send' ? 'Sent working copy to gate' : `Pulled ${what}`}${info.scheduled ? ' (scheduled)' : ''}`;
      try {
        await dk.addEvent(STORE, g.phoneNumber, { user: g.user, action, what, summary, result: j.state, ...(j.error && { error: j.error }), ...info });
      } catch (e) { console.error(`History not saved: ${(e as Error).message}`); DEBUG.write('server', `History not saved: ${(e as Error).message}`); }
      return j;
    });
}

// Camera snapshots: one run at a time per gate, separate from the gate connection. A run asked for while one
// is running starts again when it ends. stopSnapshots ends a run after killing the frame in progress.
const snapRuns = new Map<string, SnapRun>(); // phone -> { state, startedAt, finishedAt?, log, progress?, result?, error?, again?, stopping? }
const snapAborts = new Map<string, AbortController>(); // phone -> AbortController of the running run
const snapRefreshes = new Map<string, Promise<unknown>>(); // phone -> Promise of the last single-picture refresh (they run one at a time)

// Fetches one picture again (refresh button), after the gate's earlier refreshes.
function refreshSnapshot(phone: string, dir: string, minute: string, file: string) {
  const p = (snapRefreshes.get(phone) || Promise.resolve()).catch(() => {}).then(() =>
    dk.refreshSnapshot(STORE, CAMERAS, phone, dir, minute, file, { log: (m) => DEBUG.write('camera', m) }));
  snapRefreshes.set(phone, p);
  p.catch(() => {}).finally(() => { if (snapRefreshes.get(phone) === p) snapRefreshes.delete(phone); });
  return p;
}

const SNAPSHOT_TIDY_MS = CONFIG.cameras.tidyMinutes * 60000;
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
// Tidies a gate's saved snapshots (dk.tidySnapshots with its keepDays) and logs what was deleted. inRun: called by
// the gate's snapshot run, which waited for refreshes; otherwise skipped while a run or refresh is going.
async function tidyGateSnapshots(phone: string, dir: string, inRun = false): Promise<void> {
  const cur = snapRuns.get(phone);
  if (!inRun && ((cur && cur.state === 'running') || snapRefreshes.has(phone))) return;
  const cfg = await dk.getCameraSettings(STORE, phone);
  const keep = (cfg && cfg.keepDays) || 0;
  const r = await dk.tidySnapshots(STORE, phone, dir, keep);
  if (r.minutes) {
    await dk.addEvent(STORE, phone, { user: 'app', action: 'camera',
      summary: `Deleted camera snapshots older than ${keep} days (${r.files} pictures and videos, ${r.minutes} minutes, ${mb(r.bytes)})` });
    DEBUG.write('camera', `Gate ${phone}: deleted ${r.minutes} snapshot minutes older than ${keep} days (${r.files} files, ${mb(r.bytes)})`);
  }
  if (r.leftovers) DEBUG.write('camera', `Gate ${phone}: deleted ${r.leftovers} leftover video pieces (${mb(r.leftoverBytes)})`);
  if (r.missing) DEBUG.write('camera', `Gate ${phone}: ${r.missing} snapshot log entries marked removed (their files are no longer on disk)`);
}
// Every gate with camera settings or a snapshots folder.
async function tidyAllSnapshots(): Promise<void> {
  const phones = new Set((await dk.all<{ phone: string }>(STORE, 'SELECT phone FROM cameras')).map((r) => r.phone));
  if (fs.existsSync(ROOT)) for (const d of fs.readdirSync(ROOT)) if (fs.existsSync(path.join(ROOT, d, 'snapshots'))) phones.add(d);
  for (const phone of phones) {
    try { await tidyGateSnapshots(phone, path.join(ROOT, phone)); } catch (e) {
      DEBUG.write('camera', `Gate ${phone}: snapshot clean-up failed: ${(e as Error).message}`);
    }
  }
}

// minute: snapshot only that transaction minute (callers refuse it while a run is going). Returns a promise of
// the finished run (the follow-up run when one was already running).
function queueSnapshots(phone: string, dir: string, minute?: string): Promise<SnapRun> {
  const cur = snapRuns.get(phone);
  if (cur && cur.state === 'running') {
    cur.again = true;
    return cur.done.then(() => (snapRuns.get(phone) === cur ? cur : snapRuns.get(phone)!.done));
  }
  const r = { state: 'running', startedAt: new Date(), log: [], ...(minute ? { minute } : {}) } as Omit<SnapRun, 'done'> as SnapRun;
  const ac = new AbortController();
  snapRuns.set(phone, r);
  snapAborts.set(phone, ac);
  Object.defineProperty(r, 'done', { enumerable: false, value: (async () => {
    DEBUG.write('camera', `Gate ${phone}: snapshot run started${minute ? ` for ${minute}` : ''}`);
    try {
      await (snapRefreshes.get(phone) || Promise.resolve()).catch(() => {});
      await tidyGateSnapshots(phone, dir, true);
      const tx = (await gateData(phone)).transactions;
      r.result = await dk.runSnapshots(STORE, CAMERAS, phone, dir, tx ? tx.rows : [], {
        onStatus: (line) => { r.log.push(line); if (r.log.length > 200) r.log.shift(); },
        onProgress: (p) => { r.progress = p; },
        signal: ac.signal,
        log: (m) => DEBUG.write('camera', m),
        minute,
      });
      r.state = r.result && r.result.stopped ? 'stopped' : 'done';
      const counts = r.result ? `: ${r.result.done} saved, ${r.result.partial || 0} missing some frames, ${r.result.failed} without a picture`
        : ': camera settings not saved or off';
      DEBUG.write('camera', `Gate ${phone}: snapshot run ${r.state}${counts}`);
    } catch (e) {
      const { message } = e as Error;
      r.state = 'failed';
      r.error = message;
      console.error(`Snapshots for ${phone} failed: ${message}`);
      DEBUG.write('camera', `Gate ${phone}: snapshot run failed: ${message}`);
    }
    r.finishedAt = new Date();
    if (snapAborts.get(phone) === ac) snapAborts.delete(phone);
    if (r.again && !ac.signal.aborted) queueSnapshots(phone, dir);
    return r;
  })() });
  return r.done;
}

// Scheduled snapshots: waits for a run started since `since` (the one a scheduled transactions pull queues),
// else queues one. Returns { error } or { note }.
async function scheduledSnapshots(phone: string, dir: string, since: Date): Promise<{ error?: string; note?: string }> {
  const cfg = await dk.getCameraSettings(STORE, phone);
  if (!cfg || !cfg.enabled) return { note: 'Snapshots skipped: camera settings not saved or off' };
  const cur = snapRuns.get(phone);
  const r = await (cur && cur.state === 'running' && cur.startedAt >= since ? cur.done : queueSnapshots(phone, dir));
  if (r.state === 'failed') return { error: r.error };
  if (!r.result) return { note: 'Snapshots skipped: camera settings not saved or off' };
  const counts = `${r.result.done} saved, ${r.result.partial || 0} missing some frames, ${r.result.failed} without a picture`;
  if (r.state === 'stopped') return { error: `stopped (${counts})` };
  if (r.result.error) return { error: `${r.result.error} (${counts})` };
  return { note: `Snapshots: ${counts}` };
}

function stopSnapshots(phone: string): boolean {
  const ac = snapAborts.get(phone);
  if (!ac) return false;
  snapRuns.get(phone)!.stopping = true;
  ac.abort();
  return true;
}

const CAMERA_LABELS: Record<string, string> = {
  enabled: 'Enabled', serial: 'Recorder serial', username: 'Username', channels: 'Channels', clockOffset: 'Clock offset (s)',
  mode: 'Save', frames: 'Frames per transaction', framesAfter: 'Frames after the minute', clipTries: 'Video tries', events: 'Transactions', backfillHours: 'Look back (hours)',
  keepDays: 'Keep pictures',
};
const cameraText = (k: string, v: unknown): string => (k === 'keepDays' ? (v ? `${v} days` : 'Forever') : v == null ? '' : k === 'channels'
  ? (v as CameraChannel[]).map((c) => `${c.channel}${c.name ? ` ${c.name}` : ''}`).join(', ') : String(v));

// Saves the gate's camera settings and records the change (never the password) in the gate's history.
async function saveCameras(s: Session, g: Gate, body: Body): Promise<Reply> {
  const was: Record<string, unknown> = { ...await dk.getCameraSettings(STORE, g.phoneNumber) };
  const out = await dk.saveCameraSettings(STORE, g.phoneNumber, s.user, body);
  const now: Record<string, unknown> = { ...out };
  const fields = Object.keys(CAMERA_LABELS).map((k) => ({ field: CAMERA_LABELS[k], from: cameraText(k, was[k]), to: cameraText(k, now[k]) }))
    .filter((f) => f.from !== f.to);
  if (body.password) fields.push({ field: 'Password', from: '', to: 'changed' });
  if (fields.length) {
    await dk.addEvent(STORE, g.phoneNumber, { user: s.user, action: 'camera', summary: 'Changed camera settings',
      details: [{ key: 'cameras', label: 'Camera settings', change: 'changed', fields }] });
    DEBUG.write('camera', `Gate ${g.phoneNumber}: camera settings changed by ${s.user} (${fields.map((f) => f.field).join(', ')})`);
  }
  if (out && (out.keepDays || 0) !== ((was.keepDays as number) || 0)) await tidyGateSnapshots(g.phoneNumber, g.dir);
  return [200, out];
}

function sendImage(res: ServerResponse, file: string) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end(fs.readFileSync(file));
}

// Sends an .mp4, honouring a single "Range: bytes=start-end" request (needed to seek, and by Safari to play).
function sendVideo(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || (!m[1] && !m[2])) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    return fs.createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  return fs.createReadStream(file, { start, end }).pipe(res);
}

// The gate's transaction history (tx-history.ts). The first time, the last pulled rcv_out.bin is imported.
async function seedTxHistory(phone: string): Promise<void> {
  if (await dk.txHistoryCount(STORE, phone)) return;
  const rcv = await dk.readPulledFile(STORE, phone, 'rcv_out.bin');
  if (rcv) await dk.mergeTransactions(STORE, phone, rcv.data, rcv.savedAt);
}
async function txHistory(phone: string) {
  await seedTxHistory(phone);
  return dk.readTransactions(STORE, phone);
}
// The transaction list, with names from the working copy's values.
const gateData = async (phone: string) => {
  const [prefs, tx, rcv, w] = await Promise.all([prefsOf(phone), txHistory(phone),
    dk.readPulledFile(STORE, phone, 'rcv_out.bin'), dk.loadWorkingState(STORE, phone)]);
  return loadData(rcv && { data: rcv.data, mtime: rcv.savedAt }, w && w.state, prefs.deviceAssociation, tx);
};

// Runs the round-trip check on the gate's latest pull (gate-state.ts) and records it. Returns a line for the job log.
async function recordGateState(phone: string): Promise<string> {
  const pulled = await dk.readPulledFiles(STORE, phone, dk.CACHE_FILES);
  if (dk.CACHE_FILES.some((n) => !pulled[n])) return 'Round-trip check skipped: the pull is missing a file';
  const prefs = await prefsOf(phone);
  const check = await dk.checkPull(STORE, phone,
    { names: pulled['names.bin'].data, phone: pulled['phone.bin'].data, cards: pulled['cards.bin'].data },
    pulled['names.bin'].savedAt, { areaCodeSlots: dk.areaCodeLimit((prefs.gateConfig || {}).areaCodes || defaults.areaCodes) });
  const line = check.ok ? 'Round-trip check passed: the files rebuild byte for byte from their values'
    : `Round-trip check FAILED (editing stays locked after Reset to gate): ${JSON.stringify(check.problems).slice(0, 500)}`;
  DEBUG.write('gate', `Gate ${phone}: ${line}`);
  return line;
}

function startPull(g: Gate, what: dk.PullKind, info: JobInfo = {}): Promise<JobState> {
  const pulled = (j: JobState) => { if (what === 'transactions' && j.state === 'done') queueSnapshots(g.phoneNumber, g.dir); return j; };
  return startJob(g, what, () => sessionRequest(g, what), async (log, request) => {
    const { files } = await dk.pullFromGate(client(), what, request, { onStatus: log });
    if (what === 'transactions') await seedTxHistory(g.phoneNumber);
    await dk.savePulledFiles(STORE, g.phoneNumber, files);
    for (const [f, data] of Object.entries(files)) log(`Saved ${f} (${data.length} bytes)`);
    if (files['rcv_out.bin']) {
      const m = await dk.mergeTransactions(STORE, g.phoneNumber, files['rcv_out.bin']);
      log(`Transaction history: ${m.added} new event${m.added === 1 ? '' : 's'}, ${m.kept} already saved`);
      if (m.gap) log('No overlap with the saved history: events may be missing since the last pull, or the gate\'s buffer was cleared');
    }
    if (what === 'residents') {
      log(await recordGateState(g.phoneNumber));
      const { refreshed } = await dk.syncCacheAfterPull(STORE, g.phoneNumber);
      log(refreshed ? 'Working copy refreshed from this pull'
        : 'Working copy has saved changes and was kept; use Reset to gate to start from this pull');
    }
  }, info).then(pulled);
}

// Resident counts for the send session's UserID (DoorKing32 FUN_004f7320: records with FL 0, FL 2).
// Derived from the working copy's names.bin directory, so no RESIDENT.DAT is needed.
async function residentCounts(phone: string) {
  const { data } = await dk.readCacheFile(STORE, phone, 'names.bin'); // throws 404 "pull residents" if there is no working copy
  return dk.namesResidentCounts(data);
}

type PreparedSend = Awaited<ReturnType<typeof dk.prepareSend>> & { counts: Awaited<ReturnType<typeof residentCounts>> };
// Everything a send needs from the working copy; throws (409/404) when it can't be sent.
async function prepareGateSend(g: Gate): Promise<PreparedSend> {
  await refuseDuplicates(g.phoneNumber);
  return { ...await dk.prepareSend(STORE, g.phoneNumber), counts: await residentCounts(g.phoneNumber) };
}

// Sends the working copy, then pulls residents again to check the gate now holds it.
// Match: the pull becomes the new base. Mismatch: the working copy is kept and the differing blocks are logged.
// prepared: from prepareGateSend, awaited before the busy check so the job is claimed without a gap.
function startSend(g: Gate, prepared: PreparedSend, info: JobInfo = {}): Promise<JobState> {
  return startJob(g, 'send', () => sessionRequest(g, 'send', { residentCounts: prepared.counts }), async (log, request) => {
    const pullRequest = await sessionRequest(g, 'residents');
    log(`Changed blocks: ${Object.entries(prepared.changedBlocks).map(([f, b]) => `${f} [${b.join(', ')}]`).join('; ')}`);
    await dk.pushToGate(client(), request, { files: prepared.files, maps: prepared.maps, onStatus: log });
    log('Send finished; pulling residents to check');
    const { files } = await dk.pullFromGate(client(), 'residents', pullRequest, { onStatus: log });
    await dk.savePulledFiles(STORE, g.phoneNumber, files);
    log(await recordGateState(g.phoneNumber));
    const check = await dk.verifySend(STORE, g.phoneNumber, files);
    if (!check.matches) {
      throw new Error(`Check pull differs from the working copy: ${JSON.stringify(check.differentBlocks)}. Working copy kept.`);
    }
    await dk.resetCache(STORE, g.phoneNumber);
    log('Check passed: the gate holds the working copy. The working copy base now matches the gate.');
  }, {
    ...info,
    details: Object.entries(prepared.changedBlocks).filter(([, b]) => b.length)
      .map(([f, b]) => ({ key: f, label: f, change: 'sent' as RecordChange['change'], fields: [{ field: 'Blocks', from: '', to: b.join(', ') }] })),
  });
}

// Gate settings are read from and saved to the working copy (see gate-cache.ts); the base copy stays as the
// gate's values. Nothing is sent to the gate.
async function gateSettings(phone: string): Promise<Reply> {
  const status = await dk.ensureCache(STORE, phone);
  const names = await dk.readCacheFile(STORE, phone, 'names.bin');
  const hide = (v: string) => '•'.repeat(v.length);
  const gate = dk.decodeGateSettings(names.base);
  const fields = dk.decodeGateSettings(names.data).map((s, i) => (s.secret
    ? { ...s, value: hide(s.value), gate: hide(gate[i].value) } : { ...s, gate: gate[i].value }));
  return [200, { pulled: names.baseTime, saved: names.savedTime, cache: status, fields }];
}

// A save that changes a tone-open digit is refused while two tones share a digit.
async function saveSettings(g: Gate, changes: Body, cmd: number[]): Promise<Reply> {
  const names = await dk.readCacheFile(STORE, g.phoneNumber, 'names.bin');
  const { buffer, changed } = dk.applyGateSettings(names.data, changes);
  if (!changed.length) return [400, { error: 'No changes to save' }];
  if (Object.keys(changes).some((k) => /^relay\dTone/.test(k))) {
    const clash = toneConflicts(dk.decodeGateSettings(buffer), cmd);
    if (clash.length) return [400, { error: `Each tone-open digit can be used only once. Used more than once: ${clash.join('; ')}` }];
  }
  const { changedBlocks } = await dk.writeCacheFile(STORE, g.phoneNumber, 'names.bin', buffer);
  return [200, { changed, changedBlocks }];
}

const TONE_NAMES: Record<string, string> = { ToneMomentary: 'Momentary', ToneHold: 'Hold', ToneRelease: 'Release', ToneHold1Hr: 'Hold 1 Hr' };

// Tracker command relays: relay 1 with Tracker 1, relay 2 with Tracker 2 (their row is locked on the Relays page).
async function commandRelays(phone: string): Promise<number[]> {
  const t = (await prefsOf(phone)).tracker;
  return t && t.enabled ? [...(t.tracker1 ? [1] : []), ...(t.tracker2 ? [2] : [])] : [];
}

// Relays live control may set: 0-2 except Tracker command relays, plus 3-10 with Tracker 2 and 11-18 with Tracker 1.
function liveRelays(cmd: number[]): number[] {
  const range = (from: number) => Array.from({ length: 8 }, (_, i) => from + i);
  return [...[0, 1, 2].filter((r) => !cmd.includes(r)), ...(cmd.includes(2) ? range(3) : []), ...(cmd.includes(1) ? range(11) : [])];
}

// Tone-open digits used by more than one tone of relays 0-2, e.g. "3 (Relay 0 Momentary, Relay 1 Hold)".
// Relays in `skip` are left out.
function toneConflicts(settings: GateSetting[], skip: number[]): string[] {
  const uses = new Map<string, string[]>();
  for (const s of settings) {
    const m = /^relay(\d)(Tone\w+)$/.exec(s.key);
    if (!m || !s.value || skip.includes(Number(m[1]))) continue;
    uses.set(s.value, [...(uses.get(s.value) || []), `Relay ${m[1]} ${TONE_NAMES[m[2]] || m[2]}`]);
  }
  return [...uses].filter(([, list]) => list.length > 1).map(([d, list]) => `${d} (${list.join(', ')})`);
}

// Refuses (409) a send while the working copy has a directory code, entry code or card held by more than one entry.
async function refuseDuplicates(phone: string): Promise<void> {
  const dups = dk.findDuplicates(await readBuffers(phone));
  if (dups.length) {
    throw Object.assign(new Error(`Fix these before sending: ${dups.map((d) => d.text).join('; ')}`), { status: 409 });
  }
}

// Residents/vendors read from and saved to the working copy (never the gate). The editor keys on the
// directory code; the area-code table lets the UI offer existing area codes. Each row carries its local note.
async function editorResidents(g: Gate) {
  const notes = await dk.getNotes(STORE, g.phoneNumber);
  const cache = await dk.ensureCache(STORE, g.phoneNumber);
  const work = await dk.readCacheFiles(STORE, g.phoneNumber);
  const updated = new Date(Math.max(...Object.values(work).map((f) => f.savedTime.getTime())));
  const files = Object.fromEntries(Object.entries(work).map(([n, f]) => [n, { data: f.data, mtime: updated }])) as GateFiles;
  const res = residents(files);
  const rows = res?.rows?.map((r) => ({ ...r, note: notes[dk.noteKey(r.directoryCode)] || '' }));
  const names = work['names.bin'];
  const areaCodes = dk.areaCodeUsage(names.data, work['phone.bin'].data);
  const emptyCodes = dk.emptySlots(names.data);
  const dirDigits = dk.namesDirDigits(names.data);
  const duplicates = dk.findDuplicates({ names: names.data, phone: work['phone.bin'].data, cards: work['cards.bin'].data });
  return [200, { ...res, rows, areaCodes, emptyCodes, dirDigits, duplicates, cache, pulled: names.baseTime, saved: names.savedTime }] as const;
}

// Saves (or, blank, clears) the local note of a directory code and records the change in history.
async function saveNote(s: Session, g: Gate, code: string, note: unknown, why = ''): Promise<string> {
  const before = await dk.getNote(STORE, g.phoneNumber, code);
  const after = await dk.setNote(STORE, g.phoneNumber, code, note, s.user);
  if (before !== after) {
    const summary = `${after ? 'Changed' : 'Cleared'} the note for directory code ${code}${why}`;
    await dk.addEvent(STORE, g.phoneNumber, {
      user: s.user, action: 'note', summary,
      details: [{ key: code, label: `Directory code ${code}`, change: 'changed', fields: [{ field: 'Note', from: before, to: after }] }],
    });
    DEBUG.write('change', `Gate ${g.phoneNumber}: ${summary} by ${s.user}`);
  }
  return after;
}

// After an entry is deleted or its code removed, its note goes too.
async function dropNote(s: Session, g: Gate, code: string, out: Reply): Promise<Reply> {
  if (out[0] < 300) await saveNote(s, g, code, '', ' (entry deleted)');
  return out;
}

const WORK_FILES: (keyof BoardBuffers)[] = ['names', 'phone', 'cards'];

// The three working-copy buffers (throws when there is no working copy).
async function readBuffers(phone: string): Promise<BoardBuffers> {
  const work = await dk.readCacheFiles(STORE, phone);
  return Object.fromEntries(WORK_FILES.map((n) => [n, work[`${n}.bin`].data])) as unknown as BoardBuffers;
}

// Reads the three working-copy buffers, runs a transform, and writes back only the files it changed.
async function applyToCache(phone: string, transform: (bufs: BoardBuffers) => BoardBuffers):
  Promise<[number, { changed: Record<string, number[]>; cache: CacheStatus }]> {
  const bufs = await readBuffers(phone);
  const out = transform(bufs);
  const files = Object.fromEntries(WORK_FILES.filter((n) => !out[n].equals(bufs[n])).map((n) => [`${n}.bin`, out[n]]));
  const blocks = Object.keys(files).length ? await dk.writeCacheFiles(STORE, phone, files) : {};
  const changed = Object.fromEntries(Object.keys(files).map((n) => [n, blocks[n]]));
  return [200, { changed, cache: await dk.cacheStatus(STORE, phone) }];
}

const RES_FIELDS: Record<string, string> = {
  name: 'Name', type: 'Type', hidden: 'Hidden', areaCode: 'Area code', phone: 'Phone', entryCode: 'Entry code',
  securityLevel: 'Security', floor: 'Floor', elevatorRef: 'Elevator', cards: 'Cards',
};
const PREF_LABELS: Record<string, string> = { relayLabels: 'Relay names', deviceAssociation: 'Device Association', gateConfig: 'Gate configuration',
  features: 'Floors and elevators shown', tracker: 'Tracker' };
const MAX_DETAILS = 200;

// The working-copy buffers, or null when there is no working copy yet.
async function workingBuffers(phone: string): Promise<BoardBuffers | null> {
  try {
    return await readBuffers(phone);
  } catch { return null; }
}

// What changed between two working copies, for the history page: residents/vendors by directory code and
// gate settings by field. Secret settings show as changed without their values.
function changeDetails(before: BoardBuffers, after: BoardBuffers): RecordChange[] {
  const rows = (bufs: BoardBuffers) => { try { return residentRows(bufs).rows; } catch { return []; } };
  const label = (r: ResidentRow) => `${r.type} ${r.directoryCode}${r.name ? ` (${r.name})` : ''}`;
  const out = dk.diffRecords(rows(before), rows(after), 'directoryCode', Object.keys(RES_FIELDS), label)
    .map((d) => ({ ...d, fields: d.fields.map((f) => ({ ...f, field: RES_FIELDS[f.field] })) }));
  if (!before.names.equals(after.names)) {
    const settings = (buf: Buffer): GateSetting[] => { try { return dk.decodeGateSettings(buf); } catch { return []; } };
    const changed = dk.diffRecords(settings(before.names), settings(after.names), 'key', ['value'], (f) => f);
    for (const c of changed) {
      const f = c.label;
      const mask = (v: string) => (f.secret && v ? '••••' : v);
      out.push({ key: c.key, label: `Gate setting: ${f.group}`, change: 'changed',
        fields: c.fields.map((x) => ({ field: f.name, from: mask(x.from), to: mask(x.to) })) });
    }
  }
  if (!out.length) {
    for (const n of WORK_FILES) {
      if (before[n].equals(after[n])) continue;
      const p = dk.diffBuffers(before[n], after[n]);
      const bytes = p.whole ? 'layout changed' : `${p.runs.reduce((t, r) => t + r[1].length / 2, 0)} bytes changed`;
      out.push({ key: n, label: `${n}.bin`, change: 'changed', fields: [{ field: 'Other data', from: '', to: bytes }] });
    }
  }
  if (out.length > MAX_DETAILS) {
    const more = out.length - MAX_DETAILS;
    out.length = MAX_DETAILS;
    out.push({ key: 'more', label: `…and ${more} more`, change: 'changed', fields: [] });
  }
  return out;
}

// Prefs changes as detail rows. Device Association rows are listed as "Row n".
function prefsDetails({ before, after }: PrefsChange): RecordChange[] {
  const flat = (v: unknown): Record<string, unknown> => (Array.isArray(v)
    ? Object.fromEntries((v as DeviceRange[]).map((r, i) => [`Row ${i + 1}`, `${r.name} ${r.from}-${r.to}`]))
    : v && typeof v === 'object' ? v as Record<string, unknown> : {});
  return Object.keys(after).map((k) => {
    const a = flat(before[k]);
    const b = flat(after[k]);
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .map((field) => ({ field, from: String(a[field] ?? ''), to: String(b[field] ?? '') }))
      .filter((f) => f.from !== f.to);
    return { key: k, label: PREF_LABELS[k] || k, change: 'changed' as const, fields };
  });
}

// Records a working-copy and/or prefs change in the gate's history, with the patch Revert needs.
// Nothing is recorded when nothing changed.
// The working copy's change is stored as values (dk.diffStates: residents, cards, settings and layout, before and
// after), which Revert undoes.
async function logChange(s: Session, g: Gate, entry: Record<string, unknown>, before: BoardBuffers | null, prefs: PrefsChange | null = null) {
  const after = await workingBuffers(g.phoneNumber);
  const changed = Boolean(before && after && WORK_FILES.some((n) => !before[n].equals(after[n])));
  const values = changed ? dk.diffStates(dk.decodeWorking(before!), dk.decodeWorking(after!)) : null;
  if (!values && !prefs) return null;
  const details = [...(changed ? changeDetails(before!, after!) : []), ...(prefs ? prefsDetails(prefs) : [])];
  const event = await dk.addEvent(STORE, g.phoneNumber, {
    user: s.user, action: 'change', ...entry, details, ...(values && { values }), ...(prefs && { prefs }),
  });
  DEBUG.write('change', `Gate ${g.phoneNumber}: ${String(entry.summary || entry.action || 'change')} by ${s.user}`
    + `${values ? ` (${Object.keys(values).join(', ')})` : ''}`);
  return event;
}

// Runs fn (returning [status, body]) after the gate's earlier changes and records what it changed in the working copy.
function withHistory(s: Session, g: Gate, entry: Record<string, unknown>, fn: () => Reply | Promise<Reply>): Promise<Reply> {
  return serial(g.phoneNumber, async () => {
    const before = await workingBuffers(g.phoneNumber);
    const out = await fn();
    if (out[0] < 300) await logChange(s, g, entry, before);
    return out;
  });
}

const pick = (obj: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Undoes one history entry in the working copy (and prefs) only; the gate changes on the next Send.
// Refused when a later change touched the same bytes or prefs.
async function revertEvent(s: Session, g: Gate, id: string): Promise<Reply> {
  const events = await dk.readHistory(STORE, g.phoneNumber);
  const e = events.find((x) => x.id === id);
  if (!e) return [404, { error: 'History entry not found' }];
  if (!e.values && !e.files && !e.prefs) return [400, { error: 'This entry has nothing to revert' }];
  const done = events.find((x) => x.revertOf === id);
  if (done) return [409, { error: `Already reverted by ${done.user}` }];
  const later = 'a later change touched the same data. Revert that change first.';
  const before = await workingBuffers(g.phoneNumber);
  const restored: Record<string, Buffer> = {};
  if (e.values) {
    if (!before) return [409, { error: 'There is no working copy. Pull residents from the gate.' }];
    const undone = dk.undoValues(dk.decodeWorking(before), e.values as ValuesPatch);
    if (!undone) return [409, { error: `Cannot revert: ${later}` }];
    const work = await dk.readCacheFiles(STORE, g.phoneNumber);
    let built: BoardBuffers;
    try {
      built = dk.buildFiles({ names: work['names.bin'].base, phone: work['phone.bin'].base, cards: work['cards.bin'].base }, undone);
    } catch (err) { return [409, { error: `Cannot revert: ${(err as Error).message}` }]; }
    for (const n of WORK_FILES) if (!built[n].equals(before[n])) restored[`${n}.bin`] = built[n];
  }
  // Entries from before 2026-11-12 carry byte patches of the files instead.
  for (const [name, patch] of Object.entries((e.files || {}) as Record<string, Patch>)) {
    if (!before) return [409, { error: 'There is no working copy. Pull residents from the gate.' }];
    const buf = dk.undoPatch(before[name.replace(/\.bin$/, '') as keyof BoardBuffers], patch);
    if (!buf) return [409, { error: `Cannot revert ${name}: ${later}` }];
    restored[name] = buf;
  }
  let prefs: PrefsChange | null = null;
  const ep = e.prefs as PrefsChange | undefined;
  if (ep) {
    const now: Record<string, unknown> = { ...await prefsOf(g.phoneNumber) };
    const keys = Object.keys(ep.after);
    if (keys.some((k) => !same(now[k], ep.after[k]))) {
      return [409, { error: `Cannot revert ${keys.map((k) => PREF_LABELS[k] || k).join(', ')}: ${later}` }];
    }
    prefs = { before: ep.after, after: ep.before };
  }
  if (Object.keys(restored).length) await dk.writeCacheFiles(STORE, g.phoneNumber, restored);
  if (prefs) {
    await dk.setPrefs(STORE, g.phoneNumber, Object.fromEntries(Object.entries(prefs.after).map(([k, v]) => [k, v ?? undefined])));
  }
  const event = await logChange(s, g, { action: 'revert', revertOf: id, summary: `Reverted: ${e.summary}` }, before, prefs);
  return [200, { id: event && event.id, cache: await dk.cacheStatus(STORE, g.phoneNumber) }];
}

// Validates and saves gate-scoped prefs. was: the saved prefs. Returns [status, merged prefs].
async function savePrefs(g: Gate, body: Body, was: GatePrefs): Promise<Reply> {
  const prefs: { relayLabels?: Record<string, string>; deviceAssociation?: DeviceRange[]; gateConfig?: Record<string, string>;
    features?: GateFeatures; tracker?: GateTracker } = {};
  if (body.features && typeof body.features === 'object') {
    prefs.features = { floors: body.features.floors !== false, elevators: body.features.elevators !== false };
  }
  if (body.tracker && typeof body.tracker === 'object') {
    const t = body.tracker;
    const time = (v: unknown) => (/^\d{1,3}$/.test(String(v)) && Number(v) <= 255 ? String(Number(v)) : undefined);
    prefs.tracker = { enabled: t.enabled === true, tracker1: t.tracker1 === true, tracker2: t.tracker2 === true,
      prevTime1: time(t.prevTime1), prevTime2: time(t.prevTime2) };
  }
  // Only the relays given change (the Relays page saves one name at a time). Relays 0-2 always; Tracker relays
  // 3-18 only when named.
  if (body.relayLabels && typeof body.relayLabels === 'object') {
    const merged: Record<string, unknown> = { ...(was.relayLabels || {}), ...body.relayLabels };
    prefs.relayLabels = Object.fromEntries(Array.from({ length: 19 }, (_, r) => String(r))
      .map((k) => [k, String(merged[k] ?? '').trim().slice(0, 24)])
      .filter(([k, v]) => Number(k) <= 2 || v));
  }
  if (body.deviceAssociation !== undefined) {
    const da = dk.normalizeDeviceAssociation(body.deviceAssociation);
    if (da.error !== undefined) return [400, { error: da.error }];
    prefs.deviceAssociation = da.rows;
  }
  if (body.gateConfig && typeof body.gateConfig === 'object') {
    prefs.gateConfig = Object.fromEntries(GATE_CONFIG_KEYS
      .map((k) => [k, String(body.gateConfig[k] ?? '').slice(0, 40)]));
    if (prefs.gateConfig.areaCodes && !AREA_CODE_SETTINGS.includes(prefs.gateConfig.areaCodes)) {
      return [400, { error: `Area codes must be ${AREA_CODE_SETTINGS.join(' or ')}` }];
    }
    const problem = await applyAreaCodeSetting(g.phoneNumber, prefs.gateConfig.areaCodes || defaults.areaCodes);
    if (problem) return [409, { error: problem }];
  }
  return [200, await dk.setPrefs(STORE, g.phoneNumber, prefs)];
}

// Area-code slot limit from the gate's saved "Area codes" setting.
const editOpts = async (g: Gate) => ({
  areaCodeSlots: dk.areaCodeLimit(((await prefsOf(g.phoneNumber)).gateConfig || {}).areaCodes || defaults.areaCodes),
});

// Converts the working copy to the names.bin/phone.bin layout of the "Area codes" setting (see
// convertAreaCodeMode). Returns an error message, or null. "10 Area Codes" needs 10 or fewer area codes in use.
async function applyAreaCodeSetting(phone: string, setting: string): Promise<string | null> {
  if (!await workingBuffers(phone)) return null; // no working copy yet
  try {
    await applyToCache(phone, (bufs) => dk.convertAreaCodeMode(bufs, dk.areaCodeLimit(setting)));
  } catch (e) { return (e as Error).message; }
  return null;
}

// Downloads a working-copy file (.bin, or its change map as .map), built from the database.
async function sendFile(res: ServerResponse, phone: string, name: string) {
  const data = await dk.cacheFileData(STORE, phone, name);
  if (!data) return send(res, 404, { error: 'File not available' });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.end(data);
}

// Route table. scope: 'public' (no session), 'user' (signed in), 'gate-open' (signed in; :phone must be in the
// user's gate list), 'gate' (also: the user has connected to the gate successfully with the master code in
// their list, else 403), 'gate-setup' (like 'gate', but also open while no account has connected to the gate).
// Handlers get { s, g, params, body, req, res } and return [status, body], or answer themselves (file
// downloads) and return nothing.
type Scope = 'public' | 'user' | 'gate-open' | 'gate' | 'gate-setup';
interface Ctx<S extends Scope> {
  s: S extends 'public' ? Session | null : Session;
  g: S extends `gate${string}` ? Gate : null;
  params: Record<string, string>; body: Body; req: IncomingMessage; res: ServerResponse;
}
type Handler<S extends Scope> = (ctx: Ctx<S>) => Reply | undefined | void | Promise<Reply | undefined | void>;
interface Route { method: string; re: RegExp; keys: string[]; scope: Scope; handler: Handler<Scope> }

function route<S extends Scope>(method: string, pattern: string, scope: S, handler: Handler<S>): Route {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; })}$`);
  return { method, re, keys, scope, handler: handler as unknown as Handler<Scope> };
}

const G = '/api/gates/:phone';
// Checked and acted on without awaiting in between, so two requests can't both start a connection.
const busy = (g: Gate): Promise<Reply> | null => (job.state === 'running'
  ? busyMessage(g).then((error): Reply => [409, { error }]) : null);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const scheduleText = (x: Schedule) => `${x.enabled ? '' : 'off, '}${x.days.map((d) => DAY_NAMES[d]).join(' ')} ${x.time}: ${x.actions.join(', ')}`;

const MANUAL = path.join(HERE, '..', 'docs', 'MANUAL.md');

const ROUTES = [
  // The user guide (docs/MANUAL.md) as a page, read on each request so edits show at once. Public: it holds no gate data.
  route('GET', '/help', 'public', ({ res }) => { send(res, 200, helpPage(fs.readFileSync(MANUAL, 'utf8')), 'text/html'); return undefined; }),

  // Session: sign in with the DKS Cloud account; the sid cookie authenticates every later call.
  route('GET', '/api/session', 'public', async ({ s }) => {
    if (!s) return [200, { loggedIn: false }];
    const open = s.raw.gate ? await dk.findGate(STORE, s.user, s.raw.gate) : null;
    return [200, { loggedIn: true, user: s.user, gate: open ? await gateInfo(open) : null, defaults, holidayList: dk.FIXED_HOLIDAYS }];
  }),

  route('POST', '/api/session', 'public', async ({ body, req, res }) => {
    const f = Object.fromEntries(['user', 'password'].map((k) => [k, String(body[k] || '').trim()])) as { user: string; password: string };
    if (Object.values(f).some((v) => !v)) return [400, { error: 'User and password are required' }];
    const key = f.user.toLowerCase();
    if (recentFailures(key).length >= MAX_FAILED_SIGN_INS) {
      DEBUG.write('session', `${f.user}: sign-in refused after ${MAX_FAILED_SIGN_INS} failed tries`);
      return [429, { error: `Too many failed sign-ins. Try again in ${SIGN_IN_WINDOW_MS / 60000} minutes.` }];
    }
    let reply;
    try { reply = String(await client().checkLogin(f.user, f.password)).trim(); } catch (e) {
      return [502, { error: `DKS Cloud: ${(e as Error).message}` }];
    }
    if (reply !== 'OK') {
      failedSignIns.set(key, [...recentFailures(key), Date.now()]);
      return [401, { error: `Login refused: ${reply || 'no reply'}` }];
    }
    failedSignIns.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { ...f, lastSeen: Date.now() });
    DEBUG.write('session', `${f.user} signed in`);
    try { await dk.recordSignIn(STORE, f.user); } catch (e) { console.error(`Sign-in not recorded: ${(e as Error).message}`); DEBUG.write('session', `Sign-in not recorded: ${(e as Error).message}`); }
    // A saved password (for scheduled transfers) follows password changes.
    if (await dk.hasCredential(STORE, f.user)) await dk.saveCredential(STORE, f.user, f.password);
    res.setHeader('Set-Cookie', `sid=${token}${cookieAttrs(req)}`);
    return [200, { ok: true }];
  }),

  route('DELETE', '/api/session', 'public', ({ s, req, res }) => {
    if (s) { sessions.delete(s.token); DEBUG.write('session', `${s.user} signed out`); }
    res.setHeader('Set-Cookie', `sid=${cookieAttrs(req)}; Max-Age=0`);
    return [200, { ok: true }];
  }),

  // The gate the web UI has open (restored on page reload). API clients can ignore it.
  route('PUT', '/api/session/gate', 'user', async ({ s, body }) => {
    const g = await gateFor(s, body.phoneNumber);
    if (s.raw.gate !== g.phoneNumber) DEBUG.write('session', `${s.user} opened gate ${g.phoneNumber}`);
    s.raw.gate = g.phoneNumber;
    return [200, { gate: await gateInfo(g) }];
  }),

  route('DELETE', '/api/session/gate', 'user', ({ s }) => { delete s.raw.gate; return [200, { ok: true }]; }),

  // The signed-in user's gates (never includes master codes). DKS Cloud has no call that lists them.
  route('GET', '/api/gates', 'user', async ({ s }) => [200, { gates: await Promise.all((await dk.listGates(STORE, s.user)).map(gateInfo)) }]),

  // Adds a gate, or updates the master code of one already in the list.
  route('POST', '/api/gates', 'user', async ({ s, body }) => {
    const existed = !!await dk.findGate(STORE, s.user, body.phoneNumber);
    await dk.addGate(STORE, s.user, { phoneNumber: body.phoneNumber, masterCode: body.masterCode });
    const g = (await dk.findGate(STORE, s.user, body.phoneNumber))!;
    DEBUG.write('gates', `${s.user} ${existed ? 'updated the master code of' : 'added'} gate ${g.phoneNumber}`);
    return [existed ? 200 : 201, await gateInfo(g)];
  }),

  route('GET', G, 'gate-open', async ({ g }) => [200, await gateInfo(g)]),

  // A changed master code needs a new successful connection before the gate's saved data opens again.
  route('PUT', G, 'gate-open', async ({ s, g, body }) => {
    await dk.addGate(STORE, s.user, { phoneNumber: g.phoneNumber, masterCode: body.masterCode });
    DEBUG.write('gates', `${s.user} updated the master code of gate ${g.phoneNumber}`);
    return [200, await gateInfo((await dk.findGate(STORE, s.user, g.phoneNumber))!)];
  }),

  // Removes the gate from the user's list. Its downloaded files, prefs, history and schedules are kept.
  route('DELETE', G, 'gate-open', async ({ s, g }) => {
    await dk.removeGate(STORE, s.user, g.phoneNumber);
    if (s.raw.gate === g.phoneNumber) delete s.raw.gate;
    DEBUG.write('gates', `${s.user} removed gate ${g.phoneNumber} from their list`);
    return [200, { ok: true }];
  }),

  // Gate connections (one at a time across all gates). A job for another gate, or another user's job while this
  // user has not connected to the gate, shows as idle with busyElsewhere.
  route('GET', `${G}/job`, 'gate-open', ({ s, g }) => [200, job.phoneNumber === g.phoneNumber
    && (g.verified || String(job.user || '').toLowerCase() === String(s.user).toLowerCase())
    ? job : { state: 'idle', log: [], busyElsewhere: job.state === 'running' }]),

  // Allowed before the first successful connection: a successful pull is what opens the gate's saved data.
  route('POST', `${G}/pull`, 'gate-open', ({ g, body }) => {
    if (!dk.PULL_FILES[body.what as dk.PullKind]) return [400, { error: 'what must be transactions or residents' }];
    return busy(g) || (startPull(g, body.what), [202, { ok: true }]);
  }),

  route('GET', `${G}/send`, 'gate', async ({ g }) => {
    const { changedBlocks, counts } = await prepareGateSend(g);
    return [200, { changedBlocks, residentCounts: counts }];
  }),

  route('POST', `${G}/send`, 'gate', async ({ g, body }) => {
    if (body.confirm !== true) return [400, { error: 'Send must be confirmed' }];
    const prepared = await prepareGateSend(g);
    return busy(g) || (startSend(g, prepared), [202, { ok: true }]);
  }),

  // Transactions and settings views from the pulled files.
  route('GET', `${G}/data`, 'gate', async ({ g }) => [200, await gateData(g.phoneNumber)]),

  // Residents/vendors in the working copy, keyed by directory code.
  route('GET', `${G}/residents`, 'gate', ({ g }) => editorResidents(g)),

  route('POST', `${G}/residents`, 'gate', ({ s, g, body }) => withHistory(s, g,
    { summary: `Added ${body.vendor ? 'vendor' : 'resident'} ${body.directoryCode}` }, async () => {
      const opts = await editOpts(g);
      const [, out] = await applyToCache(g.phoneNumber, (bufs) => dk.addEntry(bufs, body, opts));
      return [201, out];
    })),

  route('GET', `${G}/residents/:code`, 'gate', async ({ g, params }) => {
    const [, list] = await editorResidents(g);
    const want = params.code.padStart(list.dirDigits, '0');
    const row = list.rows!.find((r) => r.directoryCode === want);
    return row ? [200, row] : [404, { error: 'Directory code not found' }];
  }),

  route('PUT', `${G}/residents/:code`, 'gate', ({ s, g, params, body }) => withHistory(s, g,
    { summary: `Edited directory code ${params.code}` }, async () => {
      const opts = await editOpts(g);
      return applyToCache(g.phoneNumber, (bufs) => dk.applyResidentEdit(bufs, { ...body, directoryCode: params.code }, opts));
    })),

  // The local note of a directory code (never sent to the gate). Body: { note } (blank clears it).
  route('PUT', `${G}/residents/:code/note`, 'gate', async ({ s, g, params, body }) => {
    const [, list] = await editorResidents(g);
    const want = params.code.padStart(list.dirDigits, '0');
    if (!list.rows!.some((r) => r.directoryCode === want)) return [404, { error: 'Directory code not found' }];
    return [200, { note: await saveNote(s, g, want, body.note) }];
  }),

  // Blanks the slot (the code stays on the gate as an empty unit).
  route('DELETE', `${G}/residents/:code`, 'gate', async ({ s, g, params }) => dropNote(s, g, params.code, await withHistory(s, g,
    { summary: `Deleted the entry at directory code ${params.code}` }, () => applyToCache(g.phoneNumber,
      (bufs) => dk.deleteResident(bufs, params.code))))),

  // Takes the directory code off the gate entirely.
  route('DELETE', `${G}/directory-codes/:code`, 'gate', async ({ s, g, params }) => dropNote(s, g, params.code, await withHistory(s, g,
    { summary: `Removed directory code ${params.code}` }, () => applyToCache(g.phoneNumber,
      (bufs) => dk.removeDirectoryCode(bufs, params.code))))),

  // "Num of Digits in Dir Code". Decreasing wipes all resident data, so it needs confirm: true.
  route('PUT', `${G}/dir-digits`, 'gate', async ({ s, g, body }) => {
    const from = dk.namesDirDigits((await dk.readCacheFile(STORE, g.phoneNumber, 'names.bin')).data);
    if (Number(body.digits) < from && body.confirm !== true) {
      return [400, { error: 'Decreasing the directory code digits destroys all resident data; confirm is required' }];
    }
    return withHistory(s, g, { summary: `Changed directory code digits from ${from} to ${body.digits}` },
      () => applyToCache(g.phoneNumber, (bufs) => dk.convertDirDigits(bufs, body.digits)));
  }),

  // Gate settings in the working copy's names.bin. PUT body: { <field key>: value, ... }.
  route('GET', `${G}/settings`, 'gate', ({ g }) => gateSettings(g.phoneNumber)),
  route('PUT', `${G}/settings`, 'gate', ({ s, g, body }) => withHistory(s, g,
    { summary: 'Changed gate settings' }, async () => saveSettings(g, body, await commandRelays(g.phoneNumber)))),

  // The working copy: status, reset to the last pull, and file downloads (.bin / .map).
  route('GET', `${G}/working-copy`, 'gate', async ({ g }) => [200, await dk.cacheStatus(STORE, g.phoneNumber)]),
  route('DELETE', `${G}/working-copy`, 'gate', ({ s, g }) => withHistory(s, g,
    { summary: 'Reset the working copy to the last pull' }, async () => [200, await dk.resetCache(STORE, g.phoneNumber)])),
  route('GET', `${G}/files/:name`, 'gate', async ({ g, params, res }) => { await sendFile(res, g.phoneNumber, params.name); }),

  // Gate-scoped local preferences (relay labels, Device Association, gate config), keyed by phone number.
  // Open before the first connection only while no account has connected to the gate (to set it up for the
  // first pull).
  route('GET', `${G}/prefs`, 'gate-setup', async ({ g }) => [200, await prefsOf(g.phoneNumber)]),

  // Changing the area-code setting also converts the working copy; both are one history entry.
  route('PUT', `${G}/prefs`, 'gate-setup', ({ s, g, body }) => serial(g.phoneNumber, async () => {
    const saved = await prefsOf(g.phoneNumber);
    const before = await workingBuffers(g.phoneNumber);
    const was: Record<string, unknown> = { ...saved };
    const out = await savePrefs(g, body, saved);
    if (out[0] < 300) {
      const merged: Record<string, unknown> = { ...(out[1] as GatePrefs) };
      const keys = Object.keys(PREF_LABELS).filter((k) => !same(was[k], merged[k]));
      const prefs = keys.length ? { before: pick(was, keys), after: pick(merged, keys) } : null;
      const summary = `Changed ${keys.map((k) => PREF_LABELS[k]).join(', ') || PREF_LABELS.gateConfig}`;
      await logChange(s, g, { summary }, before, prefs);
    }
    return out;
  })),

  // History: this gate's events (newest first) and every user's last sign-in.
  route('GET', `${G}/history`, 'gate', async ({ g }) => [200, {
    events: await dk.listHistory(STORE, g.phoneNumber), signIns: await dk.signIns(STORE),
  }]),
  route('POST', `${G}/history/:id/revert`, 'gate', ({ s, g, params }) => serial(g.phoneNumber, () => revertEvent(s, g, params.id))),

  // Deletes everything stored about the gate: its database rows (every user's gate-list entry, prefs, history,
  // schedules, camera settings, snapshot log, notes, transaction history) and its folder (pulled files, working
  // copy, camera pictures). Nothing on the gate changes. Body: { confirm: true }.
  route('POST', `${G}/delete-data`, 'gate', async ({ s, g, body }) => {
    if (body.confirm !== true) return [400, { error: 'Deleting the gate\'s data must be confirmed' }];
    if (job.state === 'running' && job.phoneNumber === g.phoneNumber) return [409, { error: 'Wait for the gate connection to finish' }];
    if (snapRuns.get(g.phoneNumber)?.state === 'running') return [409, { error: 'Stop the snapshot run first' }];
    if (scheduleRunning && scheduleQueue[0]?.phoneNumber === g.phoneNumber) return [409, { error: 'Wait for the scheduled transfer to finish' }];
    for (let i = scheduleQueue.length - 1; i > 0; i--) if (scheduleQueue[i].phoneNumber === g.phoneNumber) scheduleQueue.splice(i, 1);
    const removed = await dk.deleteGateData(STORE, g.phoneNumber);
    snapRuns.delete(g.phoneNumber);
    if (job.phoneNumber === g.phoneNumber) job = { state: 'idle', log: [] };
    for (const x of sessions.values()) if (x.gate === g.phoneNumber) delete x.gate;
    let files = '';
    try { fs.rmSync(g.dir, { recursive: true, force: true }); } catch (e) { files = (e as Error).message; }
    DEBUG.write('gates', `${s.user} deleted all stored data of gate ${g.phoneNumber}: ${JSON.stringify(removed)}${files ? `; files not all deleted: ${files}` : ''}`);
    return [200, { removed, ...(files && { filesError: files }) }];
  }),

  // Live relays: GET reads the current state (GetRelays); PUT { '0'|'1'|'2': boolean } sets relays 0-2
  // Active/Inactive (SetRelays). Active holds the gate open. PUT changes the gate immediately.
  route('GET', `${G}/relays`, 'gate', async ({ g }) => {
    try {
      const relays = await dk.checkRelays(client(), g);
      return [200, { checkedAt: new Date(), relays: relays.map((r) => ({ ...r, name: '' })) }];
    } catch (e) { return [502, { error: (e as Error).message }]; }
  }),

  // Recorded in the history; not revertible (it changed the gate, not the working copy).
  route('PUT', `${G}/relays`, 'gate', async ({ s, g, body }) => {
    const desired: Record<string, boolean> = {};
    const prefs = await prefsOf(g.phoneNumber);
    const cmd = await commandRelays(g.phoneNumber);
    const allowed = liveRelays(cmd);
    for (const k of Object.keys(body)) {
      if (typeof body[k] !== 'boolean') continue;
      if (!allowed.includes(Number(k)) || !/^\d{1,2}$/.test(k)) {
        return [400, { error: cmd.includes(Number(k))
          ? `Relay ${k} is a Tracker command relay; use relays ${Number(k) === 1 ? '11-18' : '3-10'} instead`
          : `Relay ${k} is not available (relays 3-18 need their Tracker box on the Relays page)` }];
      }
      desired[k] = body[k];
    }
    if (!Object.keys(desired).length) return [400, { error: 'No relay states given' }];
    const labels: Record<string, string | undefined> = prefs.relayLabels || {};
    const summary = Object.entries(desired)
      .map(([k, on]) => `${labels[k] || `Relay ${k}`} ${on ? 'held open' : 'released'}`).join(', ');
    const record = async (result: string, error?: string) => {
      DEBUG.write('gate', `Gate ${g.phoneNumber}: ${summary} by ${s.user}: ${result}${error ? ` (${error})` : ''}`);
      await dk.addEvent(STORE, g.phoneNumber, { user: s.user, action: 'relay', summary, result, ...(error && { error }) });
    };
    let out;
    try {
      out = await dk.controlRelays(client(), g, desired);
    } catch (e) { await record('failed', (e as Error).message); return [502, { error: (e as Error).message }]; }
    await record('done');
    return [200, { checkedAt: new Date(), ...out }];
  }),

  // Scheduled transfers for this gate. Saving an entry stores the signed-in user's DKS password (encrypted)
  // and makes them its owner; the entry runs with that password. Body: { days: [0-6], time: 'HH:MM',
  // actions: ['send'|'residents'|'transactions'|'snapshots'], enabled }.
  route('GET', `${G}/schedules`, 'gate', async ({ s, g }) => [200, {
    schedules: (await dk.listSchedules(STORE, g.phoneNumber)).map((x) => ({ ...x, queued: scheduleQueue.some((q) => q.id === x.id) })),
    passwordSaved: await dk.hasCredential(STORE, s.user),
  }]),

  route('POST', `${G}/schedules`, 'gate', async ({ s, g, body }) => {
    const out = await dk.saveSchedule(STORE, g.phoneNumber, s.user, body);
    await dk.saveCredential(STORE, s.user, s.password);
    DEBUG.write('schedule', `Gate ${g.phoneNumber}: schedule ${out!.id} added by ${s.user} (${scheduleText(out!)})`);
    return [201, out];
  }),

  route('PUT', `${G}/schedules/:id`, 'gate', async ({ s, g, params, body }) => {
    const out = await dk.saveSchedule(STORE, g.phoneNumber, s.user, body, params.id);
    await dk.saveCredential(STORE, s.user, s.password);
    DEBUG.write('schedule', `Gate ${g.phoneNumber}: schedule ${params.id} changed by ${s.user} (${scheduleText(out!)})`);
    return [200, out];
  }),

  route('DELETE', `${G}/schedules/:id`, 'gate', async ({ s, g, params }) => {
    await dk.deleteSchedule(STORE, g.phoneNumber, params.id);
    DEBUG.write('schedule', `Gate ${g.phoneNumber}: schedule ${params.id} deleted by ${s.user}`);
    return [200, { ok: true }];
  }),

  // Queues the entry to run now (after any running gate connection); its next scheduled time is unchanged.
  route('POST', `${G}/schedules/:id/run`, 'gate', async ({ s, g, params }) => {
    const sch = await dk.getSchedule(STORE, g.phoneNumber, params.id);
    if (!sch) return [404, { error: 'Schedule not found' }];
    if (!queueSchedule(sch)) return [409, { error: 'This schedule is already queued' }];
    DEBUG.write('schedule', `Gate ${g.phoneNumber}: schedule ${sch.id} queued to run now by ${s.user}`);
    return [202, { ok: true }];
  }),

  // Camera settings for this gate (shared by every account that manages it). The password is never returned;
  // PUT with a blank password keeps the saved one. Body: { enabled, serial, username, password,
  // channels: [{ channel, name }], clockOffset, frames, framesAfter, clipTries, events: 'access'|'all', backfillHours }.
  route('GET', `${G}/cameras`, 'gate', async ({ g }) => [200, { settings: await dk.getCameraSettings(STORE, g.phoneNumber) }]),
  route('PUT', `${G}/cameras`, 'gate', ({ s, g, body }) => saveCameras(s, g, body)),
  route('DELETE', `${G}/cameras`, 'gate', async ({ s, g }) => {
    const removed = await dk.deleteCameraSettings(STORE, g.phoneNumber);
    if (removed) {
      await dk.addEvent(STORE, g.phoneNumber, { user: s.user, action: 'camera', summary: 'Removed camera settings' });
      DEBUG.write('camera', `Gate ${g.phoneNumber}: camera settings removed by ${s.user}`);
    }
    return [200, { removed }];
  }),

  // Grabs a live frame from each saved channel; frames are at .../snapshots/live/ch<N>.jpg.
  route('POST', `${G}/cameras/test`, 'gate', async ({ s, g }) => {
    const cfg = await dk.getCameraSettings(STORE, g.phoneNumber, { withPassword: true });
    if (!cfg) return [404, { error: 'Save the camera settings first' }];
    const channels = await dk.liveSnapshots(CAMERAS, cfg, g.dir);
    DEBUG.write('camera', `Gate ${g.phoneNumber}: camera test by ${s.user}: ${channels
      .map((c) => `channel ${c.channel} ${c.error ? `failed (${c.error})` : 'ok'}`).join(', ')}`);
    return [200, { channels }];
  }),
  // Live view of a saved channel as MJPEG for an <img> (?quality=high: the main stream, else the sub stream).
  // The stream ends when the browser drops the request; 502 { error } when no picture came.
  route('GET', `${G}/cameras/live/:channel`, 'gate', async ({ s, g, params, req, res }) => {
    const cfg = await dk.getCameraSettings(STORE, g.phoneNumber, { withPassword: true });
    if (!cfg) return [404, { error: 'Save the camera settings first' }];
    const channel = Number(params.channel);
    if (!cfg.channels.some((c) => c.channel === channel)) return [404, { error: 'Not a saved channel' }];
    const sub = new URL(req.url!, 'http://localhost').searchParams.get('quality') !== 'high';
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const name = `Gate ${g.phoneNumber}: live view of channel ${channel} (${sub ? 'low' : 'high'})`;
    const started = Date.now();
    DEBUG.write('camera', `${name} opened by ${s.user}`);
    try {
      await CAMERAS.liveStream(cfg, channel, res, { sub, signal: ac.signal, onStart: () => {
        DEBUG.write('camera', `${name}: first picture after ${Math.round((Date.now() - started) / 1000)} s`);
        res.writeHead(200, {
          'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        });
      } });
    } catch (e) {
      if (!res.headersSent && !ac.signal.aborted) return [502, { error: (e as Error).message }];
      DEBUG.write('camera', `${name} failed: ${(e as Error).message}`);
    }
    DEBUG.write('camera', `${name} ended after ${Math.round((Date.now() - started) / 1000)} s${ac.signal.aborted ? ' (closed in the browser)' : ''}`);
    if (!res.writableEnded) res.end();
    return undefined;
  }),

  // Snapshot log by minute (YYYYMMDD-HHMM, matching each transaction's `minute`) and the current/last run.
  route('GET', `${G}/snapshots`, 'gate', async ({ g }) => [200, {
    snapshots: await dk.listSnapshots(STORE, g.phoneNumber), run: snapRuns.get(g.phoneNumber) || null,
  }]),
  // { minute } (optional, YYYYMMDD-HHMM): snapshot only that transaction's minute.
  route('POST', `${G}/snapshots/run`, 'gate', async ({ g, body }) => {
    if (!await dk.getCameraSettings(STORE, g.phoneNumber)) return [404, { error: 'Save the camera settings first' }];
    const minute = body && body.minute ? String(body.minute) : undefined;
    if (minute) {
      if (dk.minuteStart(minute) === null) return [400, { error: 'Not a transaction minute' }];
      const cur = snapRuns.get(g.phoneNumber);
      if (cur && cur.state === 'running') return [409, { error: 'Wait for the snapshot run to finish, or stop it' }];
    }
    queueSnapshots(g.phoneNumber, g.dir, minute);
    return [202, { ok: true }];
  }),
  route('POST', `${G}/snapshots/stop`, 'gate', ({ s, g }) => {
    const stopped = stopSnapshots(g.phoneNumber);
    if (stopped) DEBUG.write('camera', `Gate ${g.phoneNumber}: snapshot run stopped by ${s.user}`);
    return [200, { stopped }];
  }),
  // Deletes every saved picture and the snapshot log (refused while a run is going).
  route('DELETE', `${G}/snapshots`, 'gate', async ({ s, g }) => {
    const cur = snapRuns.get(g.phoneNumber);
    if (cur && cur.state === 'running') return [409, { error: 'Stop the snapshot run first' }];
    const out = await dk.deleteSnapshots(STORE, g.phoneNumber, g.dir);
    snapRuns.delete(g.phoneNumber);
    if (out.minutes || out.files) {
      await dk.addEvent(STORE, g.phoneNumber, { user: s.user, action: 'camera', summary: `Deleted all camera snapshots (${out.files} pictures)` });
      DEBUG.write('camera', `Gate ${g.phoneNumber}: all snapshots deleted by ${s.user} (${out.minutes} minutes, ${out.files} files)`);
    }
    return [200, out];
  }),
  // Fetches one picture again: { snapshot } (the minute's log entry); 502 { error } when no picture was saved.
  route('POST', `${G}/snapshots/:minute/:file/refresh`, 'gate', async ({ g, params }) => {
    const cur = snapRuns.get(g.phoneNumber);
    if (cur && cur.state === 'running') return [409, { error: 'Wait for the snapshot run to finish, or stop it' }];
    return [200, { snapshot: await refreshSnapshot(g.phoneNumber, g.dir, params.minute, params.file) }];
  }),
  route('GET', `${G}/snapshots/:minute/:file`, 'gate', ({ g, params, req, res }) => {
    const file = dk.snapshotFile(g.dir, params.minute, params.file);
    if (!file) return [404, { error: 'Snapshot not found' }];
    if (file.endsWith('.mp4')) sendVideo(req, res, file);
    else sendImage(res, file);
    return undefined;
  }),

  // Deletes the signed-in user's saved password; their schedules fail until they save one again.
  route('DELETE', '/api/credentials', 'user', async ({ s }) => {
    const removed = await dk.forgetCredential(STORE, s.user);
    if (removed) DEBUG.write('schedule', `${s.user} deleted their saved password`);
    return [200, { removed }];
  }),

  // Debug log (one for the whole server, see src/debug-log.ts): { enabled, file, size }; PUT { enabled }.
  route('GET', '/api/debug-log', 'user', () => [200, DEBUG.info()]),
  route('PUT', '/api/debug-log', 'user', async ({ s, body }) => {
    const on = body.enabled === true;
    if (on !== debugOn) {
      if (!on) DEBUG.write('server', `Debug logs turned off by ${s.user}`);
      await dk.setDebugLogEnabled(STORE, on);
      debugOn = on;
      if (on) DEBUG.write('server', `Debug logs turned on by ${s.user}`);
    }
    return [200, DEBUG.info()];
  }),
  route('GET', '/api/debug-log/file', 'user', ({ res }) => { send(res, 200, DEBUG.read(), 'text/plain'); return undefined; }),
];

// Scheduled transfers: checked every 30 s and once at startup, so a time missed while the server was stopped
// runs once. Due entries queue up and run one at a time, each transfer waiting for any running gate connection.
const SCHEDULE_TICK_MS = CONFIG.schedules.checkSeconds * 1000;
const scheduleQueue: Schedule[] = [];
let scheduleRunning = false;
const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });
const connectionBusy = () => job.state === 'running';

function queueSchedule(sch: Schedule): boolean {
  if (scheduleQueue.some((q) => q.id === sch.id)) return false;
  scheduleQueue.push(sch);
  runScheduleQueue();
  return true;
}

let checkingSchedules = false;
async function checkSchedules() {
  if (checkingSchedules) return;
  checkingSchedules = true;
  const now = new Date();
  try {
    for (const sch of await dk.listSchedules(STORE)) {
      if (!dk.scheduleIsDue(sch, now)) continue;
      await dk.updateScheduleRun(STORE, sch.id, { lastDue: dk.lastDue(sch, now)!.toISOString() });
      queueSchedule(sch);
    }
  } catch (e) { console.error(`Schedule check failed: ${(e as Error).message}`); DEBUG.write('schedule', `Schedule check failed: ${(e as Error).message}`); }
  finally { checkingSchedules = false; }
}

async function runScheduleQueue() {
  if (scheduleRunning) return;
  scheduleRunning = true;
  try {
    while (scheduleQueue.length) {
      await runSchedule(scheduleQueue[0]);
      scheduleQueue.shift();
    }
  } finally { scheduleRunning = false; }
}

// Runs an entry's transfers in SCHEDULE_ACTIONS order with its owner's saved password. A failed transfer does
// not stop the others; the entry's last result lists every error. Send is skipped when the working copy has
// no changes. Snapshots do not use the gate connection.
async function runSchedule(sch: Schedule) {
  const errors: string[] = [];
  const notes: string[] = [];
  const since = new Date();
  DEBUG.write('schedule', `Gate ${sch.phoneNumber}: schedule ${sch.id} started for ${sch.user} (${sch.actions.join(', ')})`);
  try {
    const cred = await dk.getCredential(STORE, sch.user);
    if (!cred) throw new Error(`No saved password for ${sch.user}. Save the schedule again to store it.`);
    const g = await gateFor(cred, sch.phoneNumber);
    for (const what of dk.SCHEDULE_ACTIONS.filter((a) => sch.actions.includes(a))) {
      if (what === 'snapshots') {
        try {
          const { error, note } = await scheduledSnapshots(g.phoneNumber, g.dir, since);
          if (error) errors.push(`snapshots: ${error}`);
          if (note) notes.push(note);
        } catch (e) { errors.push(`snapshots: ${(e as Error).message}`); }
        continue;
      }
      try {
        if (what === 'send' && !(await dk.cacheStatus(STORE, g.phoneNumber)).edited) { notes.push('Send skipped: no changes'); continue; }
        let prepared: PreparedSend | null = null;
        do {
          while (connectionBusy()) await sleep(2000);
          if (what === 'send') prepared = await prepareGateSend(g);
        } while (connectionBusy()); // another connection started while the send was being prepared
        const j = await (what === 'send' ? startSend(g, prepared!, { scheduled: true }) : startPull(g, what, { scheduled: true }));
        if (j.state === 'failed') errors.push(`${what}: ${j.error}`);
      } catch (e) { errors.push(`${what}: ${(e as Error).message}`); }
    }
  } catch (e) { errors.push((e as Error).message); }
  DEBUG.write('schedule', `Gate ${sch.phoneNumber}: schedule ${sch.id} ${errors.length ? `failed: ${errors.join('; ')}` : 'done'}${notes.length ? ` (${notes.join('; ')})` : ''}`);
  try {
    await dk.updateScheduleRun(STORE, sch.id, {
      lastRun: new Date().toISOString(),
      lastResult: errors.length ? 'failed' : 'done',
      lastError: [...errors, ...notes].join('; ') || null,
    });
  } catch (e) { console.error(`Schedule result not saved: ${(e as Error).message}`); DEBUG.write('schedule', `Schedule result not saved: ${(e as Error).message}`); }
}

async function busyMessage(g: Gate): Promise<string> {
  if (job.phoneNumber === g.phoneNumber) return 'A gate connection is already running';
  const other = (await siteNameOf(job.phoneNumber)) || `the gate ending ${String(job.phoneNumber).slice(-4)}`;
  return `A gate connection is already running for ${other}`;
}
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`,
  ...(PUBLIC_HOST ? [`https://${PUBLIC_HOST}`] : [])]);
const isPublic = (req: http.IncomingMessage) => Boolean(PUBLIC_HOST) && (req.headers.host || '').toLowerCase() === PUBLIC_HOST;
// Session cookie attributes; Secure when the page came through the public HTTPS name.
const cookieAttrs = (req: http.IncomingMessage) => `; HttpOnly; SameSite=Strict; Path=/${isPublic(req) ? '; Secure' : ''}`;

function match(method: string | undefined, pathname: string):
  { route: Route; params: Record<string, string> } | { route?: undefined; allow: string[] } {
  const hits = ROUTES.map((r) => ({ r, m: r.re.exec(pathname) })).filter((x): x is { r: Route; m: RegExpExecArray } => x.m !== null);
  const hit = hits.find((x) => x.r.method === method);
  if (!hit) return { allow: hits.map((x) => x.r.method) };
  const params = Object.fromEntries(hit.r.keys.map((k, i) => [k, decodeURIComponent(hit.m[i + 1])]));
  return { route: hit.r, params };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'Forbidden host' });
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const page = req.method === 'GET' ? staticFile(url.pathname) : null;
    if (page) return send(res, 200, fs.readFileSync(page[0]), page[1]);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 503, NOT_BUILT, 'text/plain');
    const found = match(req.method, url.pathname);
    if (!found.route) {
      if (!found.allow.length) return send(res, 404, { error: 'Not found' });
      res.setHeader('Allow', found.allow.join(', '));
      return send(res, 405, { error: 'Method not allowed' });
    }
    const { route: r, params } = found;
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin.toLowerCase())) return send(res, 403, { error: 'Forbidden origin' });
    }
    const hasBody = req.method === 'POST' || req.method === 'PUT';
    if (hasBody && !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
    const s = currentSession(req);
    if (!s && r.scope !== 'public') return send(res, 401, { error: 'Not logged in' });
    let out: Reply | undefined | void;
    try {
      const body = hasBody ? await readJson(req) : {};
      const g = r.scope.startsWith('gate') ? await gateFor(s!, params.phone) : null;
      out = g && !g.verified && (r.scope === 'gate' || (r.scope === 'gate-setup' && await dk.gateClaimed(STORE, g.phoneNumber)))
        ? [403, { error: NOT_CONNECTED, notConnected: true }]
        : await r.handler({ s, g, params, body, req, res });
    } catch (e) {
      const err = e as Error & { status?: number };
      out = [err.status || 400, { error: err.message }];
    }
    const failed = out && out[0] >= 400 ? out[1] as { error?: unknown } | null : null;
    if (out && failed && failed.error) DEBUG.write('request', `${req.method} ${url.pathname}: ${out[0]} ${failed.error}`);
    return out && send(res, ...out);
  } catch (e) {
    DEBUG.write('request', `${req.method} ${req.url}: 500 ${(e as Error).message}`);
    return send(res, 500, { error: (e as Error).message });
  }
});

// Camera bridges are child processes; stop them with the server.
process.on('exit', () => CAMERAS.stopAll());
process.on('uncaughtExceptionMonitor', (e, origin) => DEBUG.write('server', `${origin}: ${e && e.stack ? e.stack : e}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

// Once: the board files kept on disk before gate_files move into the database (then their tables are filled).
const movedFiles = await dk.importGateFiles(STORE, ROOT);
if (movedFiles && Object.keys(movedFiles).length) {
  console.log(`Moved the gate files on disk into the database: ${JSON.stringify(movedFiles)}`);
  DEBUG.write('server', `Moved the gate files on disk into the database: ${JSON.stringify(movedFiles)}`);
  for (const phone of Object.keys(movedFiles)) console.log(`Gate ${phone}: ${await recordGateState(phone)}`);
}
// Once per gate: a working copy still stored as files becomes values (gate-state.ts).
for (const phone of await dk.migrateWorkingFiles(STORE)) {
  console.log(`Gate ${phone}: working copy moved into the values tables`);
  DEBUG.write('server', `Gate ${phone}: working copy moved into the values tables`);
}
server.listen(PORT, HOST, () => {
  console.log(`DoorKing web UI: http://localhost:${PORT}${PUBLIC_HOST ? ` and https://${PUBLIC_HOST}` : ''}  (config ${CONFIG.file || 'none, defaults'}, media in ${ROOT})`);
  DEBUG.write('server', `Started on port ${PORT}: ${JSON.stringify(dk.maskedConfig(CONFIG))}`);
  checkSchedules();
  setInterval(checkSchedules, SCHEDULE_TICK_MS);
  setInterval(sweepSessions, 60000);
  tidyAllSnapshots().catch(() => {});
  setInterval(() => { tidyAllSnapshots().catch(() => {}); }, SNAPSHOT_TIDY_MS);
});
