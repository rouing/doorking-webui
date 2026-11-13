// Gate camera snapshots. A gate can have a Dahua recorder, reached through Dahua's P2P cloud by the bundled
// dahua-p2p bridge (tools/bin). After a transactions pull, frames from the recording during each new
// transaction's minute are saved with ffmpeg to <gate dir>/snapshots/<YYYYMMDD-HHMM>/ch<N>-<SS>.jpg, and frames
// from the minute after it to ch<N>-a<SS>.jpg. In video mode each channel's recording from the start of the
// minute for VIDEO_SECS is saved instead, as ch<N>.mp4 with a first-frame picture ch<N>.jpg.
// Recorder playback takes local time (verified 2026-10-19); clockOffset (seconds) is added to the gate's time.
// Playback streams at about real-time speed, so a clip takes about VIDEO_SECS to fetch (verified 2026-10-19).
// The recorder password is encrypted in the database (see db.ts) and given to the bridge in DAHUA_PASSWORD.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { encrypt, decrypt } from './db.ts';
import { all, one, run, type Store } from './db.ts';
import type { CameraChannel, CameraSettings, SnapshotMinute } from './types.ts';

// Settings as validated by normalizeCameraSettings; with the recorder password for the runner.
export type CameraConfig = Omit<CameraSettings, 'savedBy' | 'savedAt'>;
type WithPassword = { password: string };
export interface Recorder { serial: string; username: string; password: string }
type RecorderConfig = CameraConfig & WithPassword;
type CodedError = Error & { code?: string; status?: number };
type Shifts = Record<string, number>;
type Log = (message: string) => void;
// Transaction rows as read by transactions.ts (only the fields used here).
interface TxRow { ts: number; access?: string }
interface PendingMinute { minute: string; ts: number }
interface FrameJob { channel: number; off: number; file: string; video?: boolean }

const BIN_DIR = path.join(import.meta.dirname, '..', 'tools', 'bin');
export const CAMERA_EVENTS: CameraSettings['events'][] = ['access', 'all']; // access: admitted/denied entries only
export const CAMERA_MODES: CameraSettings['mode'][] = ['snapshots', 'video'];
export const VIDEO_SECS = 120;
const CLIP_RESUMES = 2;
const CLIP_SHORT_SECS = 5; // a video this much shorter than VIDEO_SECS counts as cut off
const CLIP_GAP_STEP = 5; // seconds a video request moves on past a gap in the recording
const CLIP_MAX_PARTS = 8; // most parts joined into one video
const CLIP_TRIES = 2; // default whole-video tries before a cut-off video fails (setting clipTries)
const MAX_CLIP_TRIES = 5;
const NO_VIDEO_MSG = 'The recorder sent no video';
const LIVE_MAX_MS = 15 * 60000; // longest live view stream
const LIVE_WIDTH = 960;
const LIVE_FPS = 8;
const MAX_CHANNELS = 8;
const MAX_MINUTES_PER_RUN = 60;
const MAX_ATTEMPTS = 3;
const SETTLE_MS = 90000; // a minute this recent may not be fully recorded yet
export const KEEP_DAYS = [15, 30, 60, 90, 0]; // how long saved snapshots are kept (setting keepDays); 0 = forever
const DAY_MS = 86400000;
// Pieces of a video being fetched (grabClipOnce parts, grabClip's best try, saveClip's new video) and their pictures.
const LEFTOVER = /\.(rec\d+|best|new)\.(mp4|jpg)$/;

const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');
const pad = (n: number): string => String(n).padStart(2, '0');
const int = (v: unknown, def: number): number => (v === undefined || v === null || v === '' ? def : Number(v));
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

type CameraBody = Partial<Record<'enabled' | 'serial' | 'username' | 'clockOffset' | 'frames' | 'framesAfter' | 'events'
  | 'mode' | 'backfillHours' | 'clipTries' | 'keepDays' | 'channels', unknown>>;

// Returns { settings } or { error }. channels: [{ channel: 1-64, name }].
export function normalizeCameraSettings(body: unknown): { settings: CameraConfig; error?: undefined } | { settings?: undefined; error: string } {
  const b = (body || {}) as CameraBody;
  const serial = String(b.serial || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(serial)) return { error: 'Recorder serial must be 6-32 letters and digits' };
  const username = String(b.username || '').trim().slice(0, 64);
  if (!username) return { error: 'Recorder username is required' };
  const channels: CameraChannel[] = [];
  for (const c of (Array.isArray(b.channels) ? b.channels : []) as ({ channel?: unknown; name?: unknown } | null)[]) {
    if (!c || c.channel === '' || c.channel == null) continue;
    const channel = Number(c.channel);
    if (!Number.isInteger(channel) || channel < 1 || channel > 64) return { error: 'Channels must be 1-64' };
    if (channels.some((x) => x.channel === channel)) return { error: `Channel ${channel} is listed twice` };
    channels.push({ channel, name: String(c.name || '').trim().slice(0, 40) });
  }
  if (!channels.length || channels.length > MAX_CHANNELS) return { error: `List 1-${MAX_CHANNELS} channels` };
  const clockOffset = int(b.clockOffset, 0);
  if (!Number.isInteger(clockOffset) || Math.abs(clockOffset) > 86400) return { error: 'Clock offset must be whole seconds within a day' };
  const frames = int(b.frames, 3);
  if (!Number.isInteger(frames) || frames < 1 || frames > 6) return { error: 'Frames per transaction must be 1-6' };
  const framesAfter = int(b.framesAfter, 0);
  if (!Number.isInteger(framesAfter) || framesAfter < 0 || framesAfter > 6) return { error: 'Frames after the minute must be 0-6' };
  const events = (b.events || 'access') as CameraSettings['events'];
  if (!CAMERA_EVENTS.includes(events)) return { error: `Events must be ${CAMERA_EVENTS.join(' or ')}` };
  const mode = (b.mode || 'snapshots') as CameraSettings['mode'];
  if (!CAMERA_MODES.includes(mode)) return { error: `Save must be ${CAMERA_MODES.join(' or ')}` };
  const backfillHours = int(b.backfillHours, 24);
  if (!Number.isInteger(backfillHours) || backfillHours < 0 || backfillHours > 720) return { error: 'Look-back hours must be 0-720' };
  const clipTries = int(b.clipTries, CLIP_TRIES);
  if (!Number.isInteger(clipTries) || clipTries < 1 || clipTries > MAX_CLIP_TRIES) return { error: `Video tries must be 1-${MAX_CLIP_TRIES}` };
  const keepDays = int(b.keepDays, 0);
  if (!KEEP_DAYS.includes(keepDays)) return { error: 'Keep pictures must be 15, 30, 60 or 90 days, or forever' };
  return { settings: { enabled: b.enabled !== false, serial, username, channels, clockOffset, mode, frames, framesAfter, clipTries, events,
    backfillHours, keepDays } };
}

interface CameraRow { phone: string; data: CameraSettings; password: string; saved_by: string; saved_at: string }

// The gate's camera settings (password only with withPassword), or null.
export function getCameraSettings(store: Store, phone: unknown, opts: { withPassword: true }): Promise<(CameraSettings & WithPassword) | null>;
export function getCameraSettings(store: Store, phone: unknown, opts?: { withPassword?: boolean }): Promise<CameraSettings | null>;
export async function getCameraSettings(store: Store, phone: unknown, { withPassword = false }: { withPassword?: boolean } = {}): Promise<CameraSettings | null> {
  const r = await one<CameraRow>(store, 'SELECT * FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  if (!r) return null;
  return { ...r.data, savedBy: r.saved_by, savedAt: r.saved_at, ...(withPassword && { password: decrypt(store, r.password) }) };
}

// Saves the settings; a blank password keeps the saved one. Throws 400 on bad input.
export async function saveCameraSettings(store: Store, phone: unknown, user: unknown, body: unknown): Promise<CameraSettings | null> {
  const { settings, error } = normalizeCameraSettings(body);
  if (error) throw bad(error);
  const password = String((body && (body as { password?: unknown }).password) || '');
  const old = await one<{ password: string }>(store, 'SELECT password FROM cameras WHERE phone = $1', [phoneDigits(phone)]);
  if (!password && !old) throw bad('Recorder password is required');
  await run(store, `INSERT INTO cameras (phone, data, password, saved_by, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone) DO UPDATE SET data = excluded.data, password = excluded.password, saved_by = excluded.saved_by,
    saved_at = excluded.saved_at`,
  [phoneDigits(phone), JSON.stringify(settings), password ? encrypt(store, password) : old!.password, String(user), new Date().toISOString()]);
  return getCameraSettings(store, phone);
}

export async function deleteCameraSettings(store: Store, phone: unknown): Promise<boolean> {
  return (await run(store, 'DELETE FROM cameras WHERE phone = $1', [phoneDigits(phone)])) > 0;
}

// Snapshot folder name for a transaction time: YYYYMMDD-HHMM (local).
export function minuteKey(ts: number | string | Date): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Playback starttime: YYYY_MM_DD_HH_MM_SS (local).
export function playbackTime(d: Date): string {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join('_');
}

// Seconds into the minute for each frame: 3 -> [0, 20, 40].
export const frameOffsets = (n: number): number[] => Array.from({ length: n }, (_, i) => Math.floor((i * 60) / n));

// Each channel's frames for a minute: [{ channel, off, file, video }], off in seconds from the minute's start.
// Frames after the minute (framesAfter) are at 60 + their offset, named ch<N>-a<SS>.jpg. Video mode: one
// ch<N>.mp4 per channel from the minute's start.
const frameJobs = (cfg: CameraConfig): FrameJob[] => (cfg.mode === 'video'
  ? cfg.channels.map(({ channel }) => ({ channel, off: 0, file: `ch${channel}.mp4`, video: true }))
  : cfg.channels.flatMap(({ channel }) => [
    ...frameOffsets(cfg.frames).map((s) => ({ channel, off: s, file: `ch${channel}-${pad(s)}.jpg` })),
    ...frameOffsets(cfg.framesAfter || 0).map((s) => ({ channel, off: 60 + s, file: `ch${channel}-a${pad(s)}.jpg` })),
  ]));
// Extra wait before a minute can be fetched when its recording reaches into the next minute.
const afterMs = (cfg: CameraConfig): number => (cfg.mode === 'video' || cfg.framesAfter ? 60000 : 0);
// A video's first-frame picture: ch<N>.mp4 -> ch<N>.jpg.
export const posterFile = (file: string): string => String(file).replace(/\.mp4$/, '.jpg');

const wantsSnapshot = (cfg: CameraConfig, t: TxRow): boolean => cfg.events === 'all' || t.access === 'Admit' || t.access === 'Deny';

interface SnapshotRow {
  phone: string; minute: string; status: string; files: string[]; error: string | null; attempts: number;
  video_attempts: number | null; at: string; shifts: Shifts | null; short: Shifts | null;
}

// { [minute]: { status, files, error, attempts, videoAttempts, at, shifts, short } } for the gate. shifts: { [file]: seconds } for
// pictures taken that many seconds from the planned time (see NEARBY_SECS). short: { [file]: seconds } for partial
// videos (kept, fetched again later). videoAttempts: the runs made in video mode.
export async function listSnapshots(store: Store, phone: unknown): Promise<Record<string, SnapshotMinute>> {
  const rows = await all<SnapshotRow>(store, 'SELECT * FROM snapshots WHERE phone = $1', [phoneDigits(phone)]);
  return Object.fromEntries(rows.map((r) => [r.minute,
    { status: r.status, files: r.files, error: r.error, attempts: r.attempts, videoAttempts: r.video_attempts || 0, at: r.at,
      shifts: r.shifts || {}, short: r.short || {} }]));
}

const shiftsOf = (files: string[] | undefined, shifts: Shifts = {}): Shifts =>
  Object.fromEntries((files || []).filter((f) => shifts[f]).map((f) => [f, shifts[f]]));

interface SnapshotRecord { status: string; files?: string[]; error?: string | null; shifts?: Shifts; short?: Shifts; video?: boolean }

// video: the run was in video mode (counted in video_attempts too).
export async function recordSnapshot(store: Store, phone: unknown, minute: string,
  { status, files, error, shifts, short, video = false }: SnapshotRecord): Promise<void> {
  await run(store, `INSERT INTO snapshots (phone, minute, status, files, error, attempts, at, shifts, video_attempts, short)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9)
    ON CONFLICT (phone, minute) DO UPDATE SET status = excluded.status, files = excluded.files, error = excluded.error,
    attempts = snapshots.attempts + 1, at = excluded.at, shifts = excluded.shifts,
    video_attempts = snapshots.video_attempts + excluded.video_attempts, short = excluded.short`,
  [phoneDigits(phone), minute, status, JSON.stringify(files || []), error || null, new Date().toISOString(),
    JSON.stringify(shiftsOf(files, shifts)), video ? 1 : 0, JSON.stringify(shiftsOf(files, short))]);
}

// A minute folder's saved pictures and videos (a video's first-frame picture not counted) and their bytes.
function mediaIn(folder: string): { files: number; bytes: number } {
  const names = fs.readdirSync(folder);
  let files = 0;
  let bytes = 0;
  for (const f of names) {
    bytes += fs.statSync(path.join(folder, f)).size;
    if (f.endsWith('.mp4') || (f.endsWith('.jpg') && !names.includes(f.replace(/\.jpg$/, '.mp4')))) files++;
  }
  return { files, bytes };
}

export interface TidyResult { minutes: number; files: number; bytes: number; leftovers: number; leftoverBytes: number; missing: number }

// Tidies a gate's saved snapshots (<dir>/snapshots): deletes leftover pieces of videos whose fetch was cut off
// (LEFTOVER), deletes the minute folders older than keepDays (0 = keep forever), and marks the log entries whose
// files are all gone as removed (status 'removed', no files, error = why) so they are not fetched again; an entry
// missing only some files lists just the ones left. Call only while no snapshot run or refresh uses the folder.
// Returns what was deleted: minutes/files/bytes (old minutes), leftovers/leftoverBytes, missing (entries marked).
export async function tidySnapshots(store: Store, phone: unknown, dir: string, keepDays = 0, now = Date.now()): Promise<TidyResult> {
  const out: TidyResult = { minutes: 0, files: 0, bytes: 0, leftovers: 0, leftoverBytes: 0, missing: 0 };
  const cutoff = keepDays ? now - keepDays * DAY_MS : null;
  const old = (minute: string) => { const t = minuteStart(minute); return cutoff !== null && t !== null && t < cutoff; };
  const folder = path.join(dir, 'snapshots');
  if (fs.existsSync(folder)) {
    for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sub = path.join(folder, d.name);
      for (const f of fs.readdirSync(sub)) {
        if (!LEFTOVER.test(f)) continue;
        out.leftovers++;
        out.leftoverBytes += fs.statSync(path.join(sub, f)).size;
        fs.rmSync(path.join(sub, f), { force: true });
      }
      if (d.name !== 'live' && old(d.name)) {
        const m = mediaIn(sub);
        out.minutes++;
        out.files += m.files;
        out.bytes += m.bytes;
        fs.rmSync(sub, { recursive: true, force: true });
      } else if (!fs.readdirSync(sub).length) fs.rmdirSync(sub);
    }
  }
  const p = phoneDigits(phone);
  for (const r of await all<SnapshotRow>(store, "SELECT * FROM snapshots WHERE phone = $1 AND status <> 'removed'", [p])) {
    if (!r.files.length) continue;
    const left = old(r.minute) ? [] : r.files.filter((f) => fs.existsSync(path.join(folder, r.minute, f)));
    if (left.length === r.files.length) continue;
    if (!left.length) {
      if (!old(r.minute)) out.missing++;
      await run(store, `UPDATE snapshots SET status = 'removed', files = '[]', shifts = '{}', short = '{}', error = $3
        WHERE phone = $1 AND minute = $2`, [p, r.minute, old(r.minute) ? `Deleted after ${keepDays} days` : 'The files are no longer on disk']);
    } else {
      await run(store, 'UPDATE snapshots SET files = $3, shifts = $4, short = $5 WHERE phone = $1 AND minute = $2',
        [p, r.minute, JSON.stringify(left), JSON.stringify(shiftsOf(left, r.shifts || {})), JSON.stringify(shiftsOf(left, r.short || {}))]);
    }
  }
  return out;
}

// Deletes every saved picture (<dir>/snapshots, live pictures included) and the gate's snapshot log.
// Returns { minutes, files }: log rows and picture files removed.
export async function deleteSnapshots(store: Store, phone: unknown, dir: string): Promise<{ minutes: number; files: number }> {
  const minutes = await run(store, 'DELETE FROM snapshots WHERE phone = $1', [phoneDigits(phone)]);
  const folder = path.join(dir, 'snapshots');
  let files = 0;
  if (fs.existsSync(folder)) {
    for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const names = fs.readdirSync(path.join(folder, d.name));
      files += names.filter((f) => f.endsWith('.mp4') || (f.endsWith('.jpg') && !names.includes(f.replace(/\.jpg$/, '.mp4')))).length;
    }
    fs.rmSync(folder, { recursive: true, force: true });
  }
  return { minutes, files };
}

// The recorder answers 404 for a playback time it has no recording of; after one more try (see grabFrame) the
// frame counts as not recorded and is not asked for on later runs.
const NO_RECORDING = /404 Not Found|No recording at this time/i;
const NO_RECORDING_MSG = 'No recording at this time';
// A minute is finished when every frame was saved or has no recording.
const finished = (s: { error?: string | null }): boolean => !s.error || String(s.error).split('; ').every((e) => NO_RECORDING.test(e));
// When the recorder has no recording at a frame's time, these seconds around it are tried (once each) and the
// first picture saved instead.
const NEARBY_SECS = [-2, 2];

// A logged minute still to fetch. Video mode: until every channel has its video, a minute with only pictures
// is fetched again (its picture runs do not count); after a video run, finished and tries count as usual.
function needsRun(cfg: CameraConfig, s: SnapshotMinute): boolean {
  if (s.status === 'removed') return false;
  if (cfg.mode !== 'video') return !finished(s) && s.attempts < MAX_ATTEMPTS;
  if (frameJobs(cfg).every(({ file }) => s.files.includes(file) && !(s.short || {})[file])) return false;
  return !s.videoAttempts || (!finished(s) && s.videoAttempts < MAX_ATTEMPTS);
}

// Minutes still to snapshot, newest first: wanted transactions within backfillHours (and keepDays), not finished,
// not removed, and not tried MAX_ATTEMPTS times (see needsRun). rows: transaction rows ({ ts, access }).
export function pendingMinutes(cfg: CameraConfig, rows: TxRow[], done: Record<string, SnapshotMinute>, now = Date.now()): PendingMinute[] {
  const since = Math.max(now - cfg.backfillHours * 3600000, cfg.keepDays ? now - cfg.keepDays * DAY_MS : -Infinity);
  const seen = new Map<string, PendingMinute>();
  for (const t of rows) {
    if (!wantsSnapshot(cfg, t) || t.ts < since || t.ts > now - SETTLE_MS - afterMs(cfg)) continue;
    const minute = minuteKey(t.ts);
    const s = done[minute];
    if (seen.has(minute) || (s && !needsRun(cfg, s))) continue;
    seen.set(minute, { minute, ts: new Date(t.ts).setSeconds(0, 0) });
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_MINUTES_PER_RUN);
}

// Hides secrets (and any user:pass@ in URLs) in tool output.
export function maskSecrets(text: unknown, secrets: string[] = []): string {
  let out = String(text || '').replace(/(rtsp:\/\/)[^@\s/]+@/gi, '$1***@');
  for (const s of secrets.filter(Boolean)) {
    for (const v of new Set([s, encodeURIComponent(s)])) out = out.split(v).join('***');
  }
  return out;
}

// Tool paths by platform: Windows dahua-p2p-<x64|arm64>.exe and ffmpeg.exe (x64; runs emulated on arm64),
// Linux dahua-p2p-linux-<x64|arm64> and ffmpeg-linux-<x64|arm64>.
const archName = (arch: string): string => (arch === 'arm64' ? 'arm64' : 'x64');
export const bridgeExe = (binDir = BIN_DIR, arch: string = process.arch, platform: string = process.platform): string => path.join(binDir,
  platform === 'win32' ? `dahua-p2p-${archName(arch)}.exe` : `dahua-p2p-linux-${archName(arch)}`);
export const ffmpegExe = (binDir = BIN_DIR, arch: string = process.arch, platform: string = process.platform): string => path.join(binDir,
  platform === 'win32' ? 'ffmpeg.exe' : `ffmpeg-linux-${archName(arch)}`);
// The bundled ffmpeg when tools/bin has it (it is not in the git repository: too large), else ffmpeg on the PATH.
export const ffmpegCommand = (binDir = BIN_DIR): string => (fs.existsSync(ffmpegExe(binDir)) ? ffmpegExe(binDir) : 'ffmpeg');

// Outside Windows, adds the execute bit when it is missing (lost when the files are copied from Windows).
function executable(file: string): string {
  if (process.platform === 'win32') return file;
  try {
    const { mode } = fs.statSync(file);
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
  } catch { /* spawn reports a missing file */ }
  return file;
}

// Saved snapshot or video path, or null when the names are not snapshot names or the file is missing.
export function snapshotFile(dir: string, minute: string, file: string): string | null {
  if (!/^(\d{8}-\d{4}|live)$/.test(minute) || !/^ch\d{1,2}((-a?\d{2})?\.jpg|\.mp4)$/.test(file)) return null;
  const f = path.join(dir, 'snapshots', minute, file);
  return fs.existsSync(f) ? f : null;
}

// Runs the bridges and ffmpeg. One bridge per recorder (serial + username), started on first use and stopped
// after idleMs unused. The bridge exits when its P2P connection drops, but can also stay running after the
// recorder stops answering ("device stopped consuming our data ... closing tunnel"). A frame that fails is
// tried once more after retryWaitMs (a recorder 404 is not always final): on a new bridge when the bridge
// exited, its tunnel closed, or the stream never opened. A frame cut off in transfer (decoder errors; saved as
// a part-green picture) is deleted and tried once more straight away.
// A bridge that cannot connect (exits or times out before listening) is started again after connectWaitMs,
// then twice that, up to connectTries times; after that the error has code NO_CONNECTION.
// log(message) gets bridge starts, connections, unexpected exits and idle stops, each bridge connection
// failure, and live views retried on a new bridge.
// Videos (grabFrame's video option) are copied without re-encoding to a fragmented MP4 file of up to VIDEO_SECS,
// within clipMs (ffmpeg's MPEG-TS writer refuses the recorder's H.265 stream, verified 2026-10-19); finishClip
// turns that into the .mp4 and its first-frame picture. A bridge is not stopped as idle while a grab is using it.
const TUNNEL_DEAD = /closing tunnel|device silent|retiring/i;
const STREAM_NOT_OPENED = /Invalid data found|End of file|Connection refused/i;
const DAMAGED = /error while decoding|concealing|corrupt|Invalid NAL|Could not find ref|missing picture|PPS id|SPS id/i;
const DAMAGED_MSG = 'Picture damaged in transfer';
const STOPPED_MSG = 'Stopped';
const NO_CONNECTION = 'NO_CONNECTION';

// Waits ms; rejects with "Stopped" when signal aborts.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error(STOPPED_MSG));
    const onAbort = () => { clearTimeout(timer); reject(new Error(STOPPED_MSG)); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface Bridge {
  proc: ChildProcess; port: Promise<number>; password: string; lines: string[];
  timer?: ReturnType<typeof setTimeout>; busy?: number; dead?: boolean; connected?: boolean;
}

export interface CameraRunnerOptions {
  binDir?: string; idleMs?: number; readyMs?: number; grabMs?: number; clipExtraMs?: number;
  connectTries?: number; connectWaitMs?: number; retryWaitMs?: number; log?: Log;
}
export interface GrabOptions { signal?: AbortSignal; onRetry?: (e: Error) => void; once?: boolean; video?: number }
export interface LiveOptions { sub?: boolean; signal?: AbortSignal; onStart?: () => void; maxMs?: number }

export function createCameraRunner({ binDir = BIN_DIR, idleMs = 120000, readyMs = 45000, grabMs = 45000,
  clipExtraMs = 60000, connectTries = 3, connectWaitMs = 10000, retryWaitMs = 2000, log = () => {} }: CameraRunnerOptions = {}) {
  const bridges = new Map<string, Bridge>();

  function stop(key: string): void {
    const b = bridges.get(key);
    if (!b) return;
    bridges.delete(key);
    clearTimeout(b.timer);
    b.proc.kill();
  }

  function start(key: string, cfg: Recorder): Bridge {
    const proc = spawn(executable(bridgeExe(binDir)), ['-serial', cfg.serial, '-username', cfg.username, '-listen', '127.0.0.1:0'],
      { env: { ...process.env, DAHUA_PASSWORD: cfg.password }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const b = { proc, password: cfg.password, lines: [] } as unknown as Bridge;
    const tail = () => (b.lines.length ? `: ${maskSecrets(b.lines.slice(-3).join(' | '), [cfg.password])}` : '');
    log(`Recorder ${cfg.serial}: starting bridge`);
    b.port = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`Camera bridge did not connect within ${readyMs / 1000} s${tail()}`)); proc.kill(); }, readyMs);
      const onData = (chunk: Buffer | string) => {
        for (const line of String(chunk).split(/\r?\n/).filter((l) => l.trim())) {
          b.lines.push(line);
          if (b.lines.length > 20) b.lines.shift();
          if (TUNNEL_DEAD.test(line)) b.dead = true;
          const m = /listening on 127\.0\.0\.1:(\d+)/.exec(line);
          if (m) { clearTimeout(timer); b.connected = true; log(`Recorder ${cfg.serial}: bridge connected`); resolve(Number(m[1])); }
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`Camera bridge: ${e.message}`)); });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (bridges.get(key) === b) {
          bridges.delete(key); clearTimeout(b.timer);
          if (b.connected) log(`Recorder ${cfg.serial}: bridge exited (code ${code})${tail()}`);
        }
        reject(new Error(`Camera bridge exited (code ${code})${tail()}`));
      });
    });
    b.port.catch(() => {}); // callers get the error from their own await
    return b;
  }

  // The bridge's local port, starting the bridge when needed.
  function bridge(cfg: Recorder): { key: string; port: Promise<number>; b: Bridge } {
    const key = `${cfg.serial}|${cfg.username}`;
    let b = bridges.get(key);
    if (b && (b.password !== cfg.password || b.dead)) { stop(key); b = undefined; }
    if (!b) { b = start(key, cfg); bridges.set(key, b); }
    idle(key, b);
    return { key, port: b.port, b };
  }

  function idle(key: string, b: Bridge): void {
    clearTimeout(b.timer);
    if (!b.busy && bridges.get(key) === b) {
      b.timer = setTimeout(() => { log(`Recorder ${key.split('|')[0]}: bridge stopped after ${idleMs / 1000} s idle`); stop(key); }, idleMs);
    }
  }

  // video: seconds of video to save instead of one frame.
  function ffmpeg(url: string, outFile: string, secrets: string[], signal?: AbortSignal, video = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error(STOPPED_MSG));
      const input = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', String(grabMs * 1000)];
      const args = video
        ? [...input, '-i', url, '-t', String(video), '-map', '0:v:0', '-c', 'copy',
          '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov', '-y', outFile]
        : [...input, '-fflags', '+discardcorrupt', '-skip_frame', 'nokey', '-i', url, '-frames:v', '1', '-update', '1', '-q:v', '3', '-y', outFile];
      const proc = spawn(executable(ffmpegCommand(binDir)), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
      const timer = setTimeout(() => proc.kill(), video ? video * 1000 + clipExtraMs : grabMs + 5000);
      const onAbort = () => proc.kill();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg: ${e.message}`)); });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) { fs.rmSync(outFile, { force: true }); return reject(new Error(STOPPED_MSG)); }
        const saved = code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
        if (saved && (video || !DAMAGED.test(err))) return resolve();
        fs.rmSync(outFile, { force: true });
        if (saved) return reject(new Error(DAMAGED_MSG));
        const last = maskSecrets(err.trim().split(/\r?\n/).pop(), secrets);
        if (NO_RECORDING.test(last)) return reject(new Error(NO_RECORDING_MSG));
        reject(new Error(last || (code === null ? `No ${video ? 'video' : 'picture'} before the time limit` : `ffmpeg exited (code ${code})`)));
      });
    });
  }

  // Runs ffmpeg on local files: { code, err } (err: the last 4000 characters of its output).
  function localFfmpeg(args: string[], ms = 60000): Promise<{ code: number | null; err: string }> {
    return new Promise((resolve) => {
      const proc = spawn(executable(ffmpegCommand(binDir)), ['-hide_banner', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
      const timer = setTimeout(() => proc.kill(), ms);
      proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: e.message }); });
      proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, err }); });
    });
  }

  // A local video file's duration in seconds (0 when unreadable).
  async function clipSeconds(file: string): Promise<number> {
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec((await localFfmpeg(['-i', file], 30000)).err);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  }

  // Joins the recorded parts (in order) into outFile (.mp4, playable while loading; H.265 tagged hvc1 so Safari
  // plays it) and saves the first keyframe to poster. Returns the video's duration in seconds; throws when it has
  // less than a second of video.
  async function finishClip(parts: string[], outFile: string, poster: string): Promise<number> {
    const list = `${outFile}.parts.txt`;
    const input = parts.length > 1 ? ['-f', 'concat', '-safe', '0', '-i', list] : ['-i', parts[0]];
    const drop = () => { fs.rmSync(outFile, { force: true }); fs.rmSync(poster, { force: true }); };
    if (parts.length > 1) fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`).join(''));
    try {
      const tag = /Video: hevc/.test((await localFfmpeg(['-i', parts[0]], 30000)).err) ? ['-tag:v', 'hvc1'] : [];
      const r = await localFfmpeg(['-loglevel', 'error', '-skip_frame', 'nokey', ...input,
        '-map', '0:v:0', '-c', 'copy', ...tag, '-movflags', '+faststart', '-y', outFile,
        '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-q:v', '3', '-y', poster]);
      if (r.code !== 0 || !fs.existsSync(outFile) || !fs.statSync(outFile).size) {
        drop();
        throw new Error(`Could not save the video: ${r.err.trim().split(/\r?\n/).pop() || `ffmpeg exited (code ${r.code})`}`);
      }
    } finally {
      fs.rmSync(list, { force: true });
    }
    const secs = await clipSeconds(outFile);
    if (secs < 1) { drop(); throw new Error(NO_VIDEO_MSG); }
    return secs;
  }

  // Saves one frame from rtsp://<bridge><pathQuery> (e.g. /cam/playback?channel=1&starttime=...) to outFile.
  // signal (AbortSignal) stops the grab: it rejects with "Stopped". onRetry(error) runs before the second try.
  // once: no second try (bridge connection tries still apply). video: seconds of the stream to save instead (see
  // above).
  async function grabFrame(cfg: Recorder, pathQuery: string, outFile: string,
    { signal, onRetry = () => {}, once = false, video = 0 }: GrabOptions = {}): Promise<void> {
    let retried = once;
    for (let fails = 0; ;) {
      if (signal && signal.aborted) throw new Error(STOPPED_MSG);
      const { key, port, b } = bridge(cfg);
      let localPort: number;
      try {
        localPort = await port;
      } catch (e) {
        const { message } = e as Error;
        if (signal && signal.aborted) throw new Error(STOPPED_MSG);
        if (bridges.get(key) === b) stop(key);
        log(`Recorder ${cfg.serial}: bridge did not connect (try ${fails + 1} of ${connectTries}): ${message}`);
        if (++fails >= connectTries) throw Object.assign(new Error(`Could not reach the recorder after ${fails} tries (${message})`), { code: NO_CONNECTION });
        await pause(connectWaitMs * fails, signal);
        continue;
      }
      try {
        const url = `rtsp://${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@127.0.0.1:${localPort}${pathQuery}`;
        b.busy = (b.busy || 0) + 1;
        clearTimeout(b.timer);
        try {
          return await ffmpeg(url, outFile, [cfg.password], signal, video);
        } finally {
          b.busy--;
          idle(key, b);
        }
      } catch (e) {
        const err = e as Error;
        if (retried || err.message === STOPPED_MSG || (signal && signal.aborted)) throw e;
        retried = true;
        onRetry(err);
        if (err.message === DAMAGED_MSG) continue;
        if (bridges.get(key) === b && (b.dead || STREAM_NOT_OPENED.test(err.message))) stop(key);
        await pause(retryWaitMs, signal);
      }
    }
  }

  // Writes the live picture of one channel to out as MJPEG (multipart/x-mixed-replace; boundary=frame; up to
  // LIVE_WIDTH wide, LIVE_FPS a second). sub: the recorder's lower-resolution sub stream. onStart() runs before
  // the first write. Ends (resolves) when signal aborts, the stream stops, or after maxMs. Rejects when no
  // picture came; the stream is tried once more on a new bridge when the first try got none.
  async function liveStream(cfg: Recorder, channel: number | string, out: Writable,
    { sub = true, signal, onStart = () => {}, maxMs = LIVE_MAX_MS }: LiveOptions = {}): Promise<void> {
    const pathQuery = `/cam/realmonitor?channel=${channel}&subtype=${sub ? 1 : 0}`;
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) return;
      const { key, port, b } = bridge(cfg);
      try {
        const localPort = await port;
        const url = `rtsp://${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@127.0.0.1:${localPort}${pathQuery}`;
        b.busy = (b.busy || 0) + 1;
        clearTimeout(b.timer);
        try {
          return await mjpeg(url, out, [cfg.password], { signal, onStart, maxMs });
        } finally {
          b.busy--;
          idle(key, b);
        }
      } catch (e) {
        if (attempt || (signal && signal.aborted)) throw e;
        log(`Recorder ${cfg.serial}: live view of channel ${channel} failed, trying a new bridge: ${(e as Error).message}`);
        if (bridges.get(key) === b) stop(key);
      }
    }
  }

  function mjpeg(url: string, out: Writable, secrets: string[],
    { signal, onStart, maxMs }: { signal?: AbortSignal; onStart: () => void; maxMs: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return resolve();
      const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', String(grabMs * 1000),
        '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', url, '-map', '0:v:0', '-an',
        '-vf', `fps=${LIVE_FPS},scale=w='min(${LIVE_WIDTH},iw)':h=-2`, '-c:v', 'mjpeg', '-q:v', '6',
        '-f', 'mpjpeg', '-boundary_tag', 'frame', 'pipe:1'];
      const proc = spawn(executable(ffmpegCommand(binDir)), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      let started = false;
      const firstTimer = setTimeout(() => proc.kill(), grabMs + 5000);
      const endTimer = setTimeout(() => proc.kill(), maxMs);
      proc.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
      proc.stdout.on('data', (c) => {
        if (!started) { started = true; clearTimeout(firstTimer); onStart(); }
        if (!out.write(c)) { proc.stdout.pause(); out.once('drain', () => proc.stdout.resume()); }
      });
      const onAbort = () => proc.kill();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (e) => { clearTimeout(firstTimer); clearTimeout(endTimer); reject(new Error(`ffmpeg: ${e.message}`)); });
      proc.on('exit', (code) => {
        clearTimeout(firstTimer);
        clearTimeout(endTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (started || (signal && signal.aborted)) return resolve();
        const last = maskSecrets(err.trim().split(/\r?\n/).pop(), secrets);
        reject(new Error(last || (code === null ? 'No picture before the time limit' : `ffmpeg exited (code ${code})`)));
      });
    });
  }

  const stopAll = () => { for (const key of [...bridges.keys()]) stop(key); };
  return { grabFrame, clipSeconds, finishClip, liveStream, stopAll, running: () => bridges.size };
}

export type CameraRunner = ReturnType<typeof createCameraRunner>;

type Settled<T> = { value: T; error?: undefined } | { value?: undefined; error: CodedError };

// Runs fns with at most `limit` at a time; returns their settled results in order.
async function settleAll<T>(fns: (() => Promise<T>)[], limit: number): Promise<Settled<T>[]> {
  const out = new Array<Settled<T>>(fns.length);
  let next = 0;
  const worker = async () => {
    while (next < fns.length) {
      const i = next++;
      try { out[i] = { value: await fns[i]() }; } catch (e) { out[i] = { error: e as CodedError }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return out;
}

// The frames of a minute still to grab: { kept, jobs } (kept: files in have that are on disk). Partial videos
// (short: { [file]: seconds }) are kept and grabbed again.
export function missingFrames(cfg: CameraConfig, dir: string, minute: string, have: string[] = [], short: Shifts = {}):
  { kept: string[]; jobs: FrameJob[] } {
  const folder = path.join(dir, 'snapshots', minute);
  const kept = have.filter((f) => fs.existsSync(path.join(folder, f)));
  const jobs = frameJobs(cfg).filter(({ file }) => !kept.includes(file) || short[file]);
  return { kept, jobs };
}

const playbackQuery = (channel: number, at: number): string => `/cam/playback?channel=${channel}&starttime=${playbackTime(new Date(at))}`;
const clipQuery = (channel: number, at: number, secs = VIDEO_SECS): string =>
  `${playbackQuery(channel, at)}&endtime=${playbackTime(new Date(at + secs * 1000))}`;

const isShort = (secs: number): boolean => secs < VIDEO_SECS - CLIP_SHORT_SECS;
const moveClip = (from: string, to: string): void => {
  fs.renameSync(from, to);
  if (fs.existsSync(posterFile(from))) fs.renameSync(posterFile(from), posterFile(to));
};
const dropClip = (file: string): void => { fs.rmSync(file, { force: true }); fs.rmSync(posterFile(file), { force: true }); };

interface ClipOptions { signal?: AbortSignal; onRetry?: (e: Error) => void; log?: Log }
interface ClipResult { secs: number; error: CodedError | null }

// Saves channel's VIDEO_SECS of video from time at (ms) to outFile (.mp4) and its first frame to
// posterFile(outFile). When the stream ends early (the P2P connection dropped; seen 2026-10-19) or sends no video
// (also seen), the rest is asked for from where it stopped (gaps in the recording are skipped; see grabClipOnce),
// and the parts are joined. A
// video still more than CLIP_SHORT_SECS short is asked for again from the start, up to cfg.clipTries (default
// CLIP_TRIES) times; the longest one is kept. Returns { secs, error }: the saved video's seconds and, when it is
// short, why. Throws when no video was saved. log(message) gets resumes and short videos.
async function grabClip(runner: CameraRunner, cfg: RecorderConfig, channel: number, at: number, outFile: string,
  opts: ClipOptions = {}): Promise<ClipResult> {
  const name = path.basename(outFile);
  const { log = () => {} } = opts;
  const tries = cfg.clipTries || CLIP_TRIES;
  const best = outFile.replace(/\.mp4$/, '.best.mp4');
  let bestSecs = 0;
  let error: CodedError | null = null;
  for (let i = 1; i <= tries; i++) {
    let secs: number;
    try {
      secs = await grabClipOnce(runner, cfg, channel, at, outFile, opts);
    } catch (e) {
      if (!bestSecs || (e as Error).message === STOPPED_MSG) { dropClip(best); throw e; }
      error = e as CodedError;
      break;
    }
    if (!isShort(secs)) { dropClip(best); return { secs, error: null }; }
    const longer = secs > bestSecs;
    if (longer) { moveClip(outFile, best); bestSecs = secs; } else dropClip(outFile);
    log(`${name}: the recorder sent ${Math.round(secs)} s of ${VIDEO_SECS} s, ${longer ? 'kept it' : 'deleted it (not longer than the one kept)'}${i < tries ? ', trying again' : ''}`);
  }
  moveClip(best, outFile);
  return { secs: bestSecs, error: error || new Error(`The recorder sent only ${Math.round(bestSecs)} s of ${VIDEO_SECS} s of video`) };
}

// grabClip to file, which may already hold a video of have seconds (0: none; VIDEO_SECS when complete): the new
// video replaces it when complete or longer. Returns { secs, error, saved } for the video in file (saved: the new
// one). Throws when there is no video in file.
async function saveClip(runner: CameraRunner, cfg: RecorderConfig, channel: number, at: number, file: string, have: number,
  opts: ClipOptions = {}): Promise<ClipResult & { saved: boolean }> {
  const tmp = have ? file.replace(/\.mp4$/, '.new.mp4') : file;
  const { log = () => {} } = opts;
  let r: ClipResult;
  try {
    r = await grabClip(runner, cfg, channel, at, tmp, { ...opts, log: (m) => log(m.replace(path.basename(tmp), path.basename(file))) });
  } catch (e) {
    if (!have || (e as Error).message === STOPPED_MSG) throw e;
    return { secs: have, error: e as CodedError, saved: false };
  }
  if (tmp === file) return { ...r, saved: true };
  if (r.error && r.secs <= have) { dropClip(tmp); return { secs: have, error: r.error, saved: false }; }
  moveClip(tmp, file);
  return { ...r, saved: true };
}

// Seconds of the video file in a minute's folder: 0 when missing, its short seconds when partial, else VIDEO_SECS.
const clipHave = (folder: string, file: string, short: Shifts = {}): number =>
  (fs.existsSync(path.join(folder, file)) ? short[file] || VIDEO_SECS : 0);

// One try of grabClip; returns the saved video's seconds plus the seconds the recorder has no recording of.
// A playback stream stops at a gap in the recording (a 404 just after it; a 15 s gap was seen 2026-10-20), so
// on "No recording" the request moves on CLIP_GAP_STEP seconds (once each) until the recording starts again.
// The stream also stops a second or two before a gap, so the rest is asked for while each part brings video (up to
// CLIP_MAX_PARTS parts); CLIP_RESUMES limits only the requests that bring none.
async function grabClipOnce(runner: CameraRunner, cfg: RecorderConfig, channel: number, at: number, outFile: string,
  { signal, onRetry, log = () => {} }: ClipOptions = {}): Promise<number> {
  const name = path.basename(outFile);
  const files: string[] = [];
  const parts: string[] = [];
  let got = 0; // whole seconds covered: saved, or not recorded
  let skipped = 0; // of those, not recorded
  let gap = 0; // not recorded since the last part
  let empty = 0; // requests that brought no video
  const logGap = (end: string) => log(`${name}: no recording from +${got - gap} s to ${end}, skipped it`);
  try {
    for (let n = 0; empty <= CLIP_RESUMES && parts.length < CLIP_MAX_PARTS && got < VIDEO_SECS - CLIP_SHORT_SECS; n++) {
      const part = outFile.replace(/\.mp4$/, `.rec${n}.mp4`);
      const secs = VIDEO_SECS - got;
      files.push(part);
      if (n && !gap) log(`${name}: ${got ? `the recorder stopped after ${got} s, asking for the rest` : 'no video received, asking again'}`);
      try {
        await runner.grabFrame(cfg, clipQuery(channel, at + got * 1000, secs), part, { signal, onRetry, video: secs, once: gap > 0 });
      } catch (e) {
        const { message } = e as Error;
        if (message === STOPPED_MSG) throw e;
        if (message === NO_RECORDING_MSG) {
          const step = Math.min(CLIP_GAP_STEP, secs);
          got += step;
          skipped += step;
          gap += step;
          continue;
        }
        if (!parts.length) throw e;
        log(`${name}: the rest from +${got} s failed: ${message}`);
        break;
      }
      if (gap) { logGap(`+${got} s`); gap = 0; }
      const d = Math.floor(await runner.clipSeconds(part));
      if (d < 1) { empty++; continue; }
      parts.push(part);
      got += d;
    }
    if (gap && parts.length) logGap('the end');
    if (!parts.length) throw new Error(skipped ? NO_RECORDING_MSG : NO_VIDEO_MSG);
    return (await runner.finishClip(parts, outFile, posterFile(outFile))) + skipped;
  } finally {
    for (const f of files) fs.rmSync(f, { force: true });
  }
}

// Grabs channel's frame at time at (ms); when the recorder has no recording then, tries NEARBY_SECS once each.
// Returns the seconds the saved picture is from at (0 when taken at at); otherwise throws the first error.
async function grabNearby(runner: CameraRunner, cfg: Recorder, channel: number, at: number, outFile: string,
  { signal, onRetry, log = () => {} }: ClipOptions = {}): Promise<number> {
  try {
    await runner.grabFrame(cfg, playbackQuery(channel, at), outFile, { signal, onRetry });
    return 0;
  } catch (e) {
    if ((e as Error).message !== NO_RECORDING_MSG) throw e;
    for (const s of NEARBY_SECS) {
      const query = playbackQuery(channel, at + s * 1000);
      try {
        await runner.grabFrame(cfg, query, outFile, { signal, once: true });
        log(`${path.basename(outFile)}: no recording at the planned time, took ${s > 0 ? '+' : ''}${s} s instead (${query})`);
        return s;
      } catch (e2) {
        const err = e2 as CodedError;
        if (err.message === STOPPED_MSG || err.code === NO_CONNECTION) throw e2;
      }
    }
    throw e;
  }
}

// Frames for one minute: each channel at each frame offset, skipping files already saved (have), one at a
// time over the tunnel. onFrame runs after each grab; signal stops the minute. Once the recorder cannot be
// reached (error code NO_CONNECTION) the minute's other frames are not tried. Returns { files, errors,
// stopped, unreachable, shifts, short } with files including have, shifts { [file]: seconds } for the new pictures
// taken off their planned time (see grabNearby) and short the minute's partial videos (see listSnapshots; given
// ones are grabbed again and kept unless a longer one comes). log(message) gets each retried, shifted and failed frame.
export async function snapshotMinute(runner: CameraRunner, cfg: RecorderConfig, dir: string, { minute, ts }: PendingMinute, have: string[] = [],
  { signal, onFrame = () => {}, log = () => {}, short: given = {} }: { signal?: AbortSignal; onFrame?: () => void; log?: Log; short?: Shifts } = {}) {
  const folder = path.join(dir, 'snapshots', minute);
  fs.mkdirSync(folder, { recursive: true });
  const { kept, jobs } = missingFrames(cfg, dir, minute, have, given);
  let unreachable = null as CodedError | null;
  const shifts: Shifts = {};
  const short: Shifts = { ...given };
  const partialErrors: string[] = [];
  const results = await settleAll(jobs.map(({ channel, off, file, video }) => async () => {
    if (signal && signal.aborted) throw new Error(STOPPED_MSG);
    if (unreachable) throw unreachable;
    const at = ts + (cfg.clockOffset + off) * 1000;
    const query = video ? clipQuery(channel, at) : playbackQuery(channel, at);
    const onRetry = (e: Error) => log(`${minute}/${file} failed, trying again (${query}): ${e.message}`);
    try {
      if (video) {
        const r = await saveClip(runner, cfg, channel, at, path.join(folder, file), clipHave(folder, file, given),
          { signal, onRetry, log: (m) => log(`${minute}/${m}`) });
        if (isShort(r.secs)) short[file] = Math.round(r.secs);
        else delete short[file];
        if (r.error) {
          if (r.error.code === NO_CONNECTION) unreachable = r.error;
          partialErrors.push(r.error.message);
          log(`${minute}/${file} partial video kept (${Math.round(r.secs)} s, ${query}): ${r.error.message}`);
        }
      } else {
        const shift = await grabNearby(runner, cfg, channel, at, path.join(folder, file), { signal, onRetry, log: (m) => log(`${minute}/${m}`) });
        if (shift) shifts[file] = shift;
      }
    } catch (e) {
      const err = e as CodedError;
      if (err.code === NO_CONNECTION) unreachable = err;
      if (err.message !== STOPPED_MSG) log(`${minute}/${file} failed (${query}): ${err.message}`);
      throw e;
    } finally {
      if (!(signal && signal.aborted)) onFrame();
    }
    return file;
  }), 1);
  const stopped = Boolean(signal && signal.aborted);
  const files = [...new Set([...kept, ...results.filter((r) => r.value).map((r) => r.value as string)])];
  const errors = [...new Set([...results.filter((r) => r.error && r.error.message !== STOPPED_MSG).map((r) => (r.error as CodedError).message),
    ...partialErrors])];
  return { files, errors, stopped, unreachable: unreachable ? unreachable.message : null, shifts, short };
}

// ch<N>-<SS>.jpg / ch<N>-a<SS>.jpg -> { channel, off } (off in seconds from the minute's start), ch<N>.mp4 ->
// { channel, off: 0, video: true }, or null.
export function frameOfFile(file: unknown): { channel: number; off: number; video?: boolean } | null {
  const v = /^ch(\d{1,2})\.mp4$/.exec(String(file));
  if (v) return Number(v[1]) >= 1 && Number(v[1]) <= 64 ? { channel: Number(v[1]), off: 0, video: true } : null;
  const m = /^ch(\d{1,2})-(a?)(\d{2})\.jpg$/.exec(String(file));
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 64 || Number(m[3]) > 59) return null;
  return { channel: Number(m[1]), off: (m[2] ? 60 : 0) + Number(m[3]) };
}

// YYYYMMDD-HHMM -> the minute's start (local, ms), or null.
export function minuteStart(minute: unknown): number | null {
  const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(String(minute));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime() : null;
}

// Fetches one frame (or video) of a minute again (the picture's refresh button). The new picture replaces the
// saved one only once it is saved. The snapshot log gets the file; once every frame of the current settings is on disk the
// minute is done (attempts unchanged). Returns the minute's log entry; when no picture is saved, throws the
// grab's error with status 502 (the old picture, if any, is kept). A partial video is saved (marked short) only
// when longer than the saved one. log(message) gets retries and failures.
export async function refreshSnapshot(store: Store, runner: CameraRunner, phone: unknown, dir: string, minute: string, file: string,
  { log: logTo = () => {} }: { log?: Log } = {}): Promise<SnapshotMinute | undefined> {
  const cfg = await getCameraSettings(store, phone, { withPassword: true });
  if (!cfg) throw Object.assign(new Error('Save the camera settings first'), { status: 404 });
  const frame = frameOfFile(file);
  const start = minuteStart(minute);
  if (!frame || start === null) throw bad('Not a snapshot picture');
  const log = (m: string) => logTo(`Gate ${phone}: ${m}`);
  const folder = path.join(dir, 'snapshots', minute);
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, file.replace(/\.(jpg|mp4)$/, '.new.$1'));
  const at = start + (cfg.clockOffset + frame.off) * 1000;
  const query = frame.video ? clipQuery(frame.channel, at) : playbackQuery(frame.channel, at);
  const opts: ClipOptions = {
    onRetry: (e) => log(`${minute}/${file} refresh failed, trying again (${query}): ${e.message}`),
    log: (m) => log(`${minute}/${m.replace(path.basename(tmp), file)}`),
  };
  const s = (await listSnapshots(store, phone))[minute];
  const short: Shifts = { ...(s ? s.short : {}) };
  let shift = 0;
  let clipError: CodedError | null = null;
  try {
    if (frame.video) {
      const r = await saveClip(runner, cfg, frame.channel, at, path.join(folder, file),
        clipHave(folder, file, short), { ...opts, log: (m) => log(`${minute}/${m}`) });
      if (!r.saved) throw r.error;
      if (isShort(r.secs)) short[file] = Math.round(r.secs);
      else delete short[file];
      clipError = r.error;
      if (clipError) log(`${minute}/${file} refresh saved a partial video (${Math.round(r.secs)} s, ${query}): ${clipError.message}`);
    } else {
      shift = await grabNearby(runner, cfg, frame.channel, at, tmp, opts);
      fs.renameSync(tmp, path.join(folder, file));
    }
  } catch (e) {
    const { message } = e as Error;
    if (!frame.video) fs.rmSync(tmp, { force: true });
    log(`${minute}/${file} refresh failed (${query}): ${message}`);
    throw Object.assign(new Error(message), { status: 502 });
  }
  const files = [...new Set([...(s ? s.files : []), file])].filter((f) => fs.existsSync(path.join(folder, f)));
  const complete = !missingFrames(cfg, dir, minute, files, short).jobs.length;
  const status = complete ? 'done' : clipError ? 'partial' : s && s.status !== 'failed' ? s.status : 'partial';
  const shifts = { ...(s ? s.shifts : {}), [file]: shift };
  const error = complete ? null : clipError ? clipError.message : (s && s.error) || null;
  await run(store, `INSERT INTO snapshots (phone, minute, status, files, error, attempts, at, shifts, short)
    VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
    ON CONFLICT (phone, minute) DO UPDATE SET status = excluded.status, files = excluded.files, error = excluded.error, at = excluded.at,
    shifts = excluded.shifts, short = excluded.short`,
  [phoneDigits(phone), minute, status, JSON.stringify(files), error, new Date().toISOString(),
    JSON.stringify(shiftsOf(files, shifts)), JSON.stringify(shiftsOf(files, short))]);
  return (await listSnapshots(store, phone))[minute];
}

// A live frame from each channel, to check the settings: <dir>/snapshots/live/ch<N>.jpg.
export async function liveSnapshots(runner: CameraRunner, cfg: RecorderConfig, dir: string):
  Promise<(CameraChannel & { error?: string; file?: string })[]> {
  const folder = path.join(dir, 'snapshots', 'live');
  fs.mkdirSync(folder, { recursive: true });
  const results = await settleAll(cfg.channels.map(({ channel }) => () => runner.grabFrame(cfg,
    `/cam/realmonitor?channel=${channel}&subtype=0`, path.join(folder, `ch${channel}.jpg`))), 3);
  return cfg.channels.map((c, i) => ({ ...c, ...(results[i].error ? { error: results[i].error.message } : { file: `ch${c.channel}.jpg` }) }));
}

export interface SnapshotProgress {
  minutes: number; minutesDone: number; frames: number; framesDone: number; current: string | null;
  byMinute: Record<string, { frames: number; done: number }>;
}
export interface SnapshotResult { minutes: number; done: number; partial: number; failed: number; stopped: boolean; error?: string }
interface RunSnapshotsOptions {
  now?: number; onStatus?: Log; onProgress?: (p: SnapshotProgress) => void; signal?: AbortSignal; log?: Log; minute?: string;
}

// Snapshots the gate's pending minutes (see pendingMinutes). rows: transaction rows. Returns null when the gate
// has no enabled camera settings, else { minutes, done, partial, failed, stopped }. done: every frame saved or
// not recorded; partial: some frames saved, others to try again on a later run; failed: no frame saved.
// onProgress gets { minutes, minutesDone, frames, framesDone, current, byMinute }: current is the minute being
// fetched (or null), byMinute { "<minute>": { frames, done } } the minutes not finished yet in this run.
// signal (AbortSignal) stops the run; the minute
// in progress is not recorded, so the next run does it again. When the recorder cannot be reached the run
// ends after that minute and the result also has error (the reason); the next run carries on.
// log(message) gets frame retries and failures, minutes not done, and why the run ended early.
// minute (YYYYMMDD-HHMM): snapshot only that minute (one transaction's button), whatever its transaction type,
// age or tries so far; a minute too recent to be recorded yet ends the run with error.
export async function runSnapshots(store: Store, runner: CameraRunner, phone: unknown, dir: string, rows: TxRow[],
  { now = Date.now(), onStatus = () => {}, onProgress = () => {}, signal, log: logTo = () => {}, minute }: RunSnapshotsOptions = {}):
  Promise<SnapshotResult | null> {
  const log = (m: string) => logTo(`Gate ${phone}: ${m}`);
  const cfg = await getCameraSettings(store, phone, { withPassword: true });
  if (!cfg || !cfg.enabled) return null;
  const known = await listSnapshots(store, phone);
  let pending: PendingMinute[];
  let tooRecent = false;
  if (minute) {
    const start = minuteStart(minute);
    if (start === null) throw bad('Not a transaction minute');
    tooRecent = start > now - SETTLE_MS - afterMs(cfg);
    pending = tooRecent ? [] : [{ minute, ts: start }];
  } else pending = pendingMinutes(cfg, rows, known, now);
  const out: SnapshotResult = { minutes: pending.length, done: 0, partial: 0, failed: 0, stopped: false };
  if (tooRecent) out.error = 'This minute may not be recorded yet; try again in a few minutes';
  const byMinute: SnapshotProgress['byMinute'] = Object.fromEntries(pending.map((p) => [p.minute,
    { frames: missingFrames(cfg, dir, p.minute, known[p.minute]?.files, known[p.minute]?.short).jobs.length, done: 0 }]));
  const progress = {
    minutes: pending.length, minutesDone: 0, framesDone: 0,
    frames: Object.values(byMinute).reduce((n, m) => n + m.frames, 0), current: null as string | null,
  };
  const report = () => onProgress({ ...progress,
    byMinute: Object.fromEntries(Object.entries(byMinute).map(([k, m]) => [k, { ...m }])) });
  report();
  for (const p of pending) {
    if (signal && signal.aborted) { out.stopped = true; break; }
    progress.current = p.minute;
    report();
    const onFrame = () => { progress.framesDone++; byMinute[p.minute].done++; report(); };
    const { files, errors, stopped, unreachable, shifts, short } = await snapshotMinute(runner, cfg, dir, p, known[p.minute]?.files,
      { signal, onFrame, log, short: known[p.minute]?.short });
    if (stopped) { out.stopped = true; break; }
    progress.minutesDone++;
    progress.current = null;
    delete byMinute[p.minute];
    report();
    const status: 'failed' | 'done' | 'partial' = !files.length ? 'failed' : finished({ error: errors.join('; ') }) ? 'done' : 'partial';
    await recordSnapshot(store, phone, p.minute, { status, files, error: errors.join('; '), shifts: { ...known[p.minute]?.shifts, ...shifts },
      short, video: cfg.mode === 'video' });
    out[status]++;
    onStatus(`${p.minute}: ${files.length} frames${errors.length ? ` (${errors.join('; ')})` : ''}`);
    if (errors.length) log(`${p.minute} ${status}: ${files.length} frames saved (${errors.join('; ')})`);
    if (unreachable) { out.error = unreachable; log(`Snapshot run ended early: ${unreachable}`); break; }
  }
  return out;
}
