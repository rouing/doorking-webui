/**
 * @module src/camera-runner
 *
 * Runs the dahua-p2p bridges (relay tunnels) and ffmpeg: single frames, videos and live views.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openTunnel } from 'dahua-p2p';
import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import { NO_RECORDING, NO_RECORDING_MSG } from './camera-log.ts';
import { type Log, NO_VIDEO_MSG, type Recorder } from './camera-settings.ts';

const LIVE_FPS = 8;
const LIVE_WIDTH = 960;
const LIVE_MAX_MS = 15 * 60000; // longest live view stream
const BIN_DIR = path.join(import.meta.dirname, '..', 'tools', 'bin');
/**
 * Hides secrets (and any user:pass@ in URLs) in tool output.
 *
 * @param text - Input text string.
 * @param [secrets] - `string[]` value.
 * @returns `string` result.
 */
export function maskSecrets(text: unknown, secrets: string[] = []): string {
  let out = String(text || '').replace(/(rtsp:\/\/)[^@\s/]+@/gi, '$1***@');
  for (const secret of secrets.filter(Boolean)) {
    for (const variant of new Set([secret, encodeURIComponent(secret)])) out = out.split(variant).join('***');
  }
  return out;
}

/**
 * ffmpeg's path by platform: Windows ffmpeg.exe (x64; runs emulated on arm64), Linux ffmpeg-linux-<x64|arm64>.
 *
 * @param arch - `string` value.
 * @returns `string` result.
 */
const archName = (arch: string): string => (arch === 'arm64' ? 'arm64' : 'x64');
/**
 * Ffmpeg exe.
 *
 * @param [binDir] - Bin dir.
 * @param [arch] - `string` value.
 * @param [platform] - `string` value.
 * @returns `string` result.
 */
export const ffmpegExe = (binDir = BIN_DIR, arch: string = process.arch, platform: string = process.platform): string => path.join(binDir,
  platform === 'win32' ? 'ffmpeg.exe' : `ffmpeg-linux-${archName(arch)}`);
/**
 * The bundled ffmpeg when tools/bin has it (it is not in the git repository: too large), else ffmpeg on the PATH.
 *
 * @param [binDir] - Bin dir.
 * @returns `string` result.
 */
export const ffmpegCommand = (binDir = BIN_DIR): string => (fs.existsSync(ffmpegExe(binDir)) ? ffmpegExe(binDir) : 'ffmpeg');

/**
 * Outside Windows, adds the execute bit when it is missing (lost when the files are copied from Windows).
 *
 * @param file - File path or filename.
 * @returns `string` result.
 */
function executable(file: string): string {
  if (process.platform === 'win32') return file;
  try {
    const { mode } = fs.statSync(file);
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
  } catch { /* spawn reports a missing file */ }
  return file;
}

/**
 * Runs the bridges and ffmpeg. One bridge (relay tunnel) per recorder (serial + username), started on first use and
 * stopped after idleMs unused; it is replaced when its tunnel closes. A frame that fails is tried once more after
 * retryWaitMs (a recorder 404 is not always final): on a new bridge when the tunnel closed or the stream never
 * opened. A frame cut off in transfer (decoder errors; saved as
 * a part-green picture) is deleted and tried once more straight away.
 * A bridge that cannot connect (fails or times out before listening) is started again after connectWaitMs,
 * then twice that, up to connectTries times; after that the error has code NO_CONNECTION.
 * log(message) gets bridge starts, connections, unexpected closes and idle stops, each bridge connection
 * failure, and live views retried on a new bridge.
 * Videos (grabFrame's video option) are copied without re-encoding to a fragmented MP4 file of up to VIDEO_SECS,
 * within clipMs (ffmpeg's MPEG-TS writer refuses the recorder's H.265 stream, verified 2026-10-19); finishClip
 * turns that into the .mp4 and its first-frame picture. A bridge is not stopped as idle while a grab is using it.
 */
const STREAM_NOT_OPENED = /Invalid data found|End of file|Connection refused/i;
const DAMAGED = /error while decoding|concealing|corrupt|Invalid NAL|Could not find ref|missing picture|PPS id|SPS id/i;
const DAMAGED_MSG = 'Picture damaged in transfer';
export const STOPPED_MSG = 'Stopped';
export const NO_CONNECTION = 'NO_CONNECTION';

/**
 * Waits ms; rejects with "Stopped" when signal aborts.
 *
 * @param ms - `number` value.
 * @param [signal] - AbortSignal to cancel the operation.
 */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error(STOPPED_MSG));
    const onAbort = () => { clearTimeout(timer); reject(new Error(STOPPED_MSG)); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** kill: stops the bridge (its tunnel and local port). */
interface Bridge {
  kill: () => void; port: Promise<number>; password: string; lines: string[];
  timer?: ReturnType<typeof setTimeout>; busy?: number; dead?: boolean; connected?: boolean;
}

interface CameraRunnerOptions {
  binDir?: string; ffmpegPath?: string; idleMs?: number; readyMs?: number; grabMs?: number; clipExtraMs?: number;
  connectTries?: number; connectWaitMs?: number; retryWaitMs?: number; log?: Log;
}
interface GrabOptions { signal?: AbortSignal; onRetry?: (error: Error) => void; once?: boolean; video?: number }
interface LiveOptions { sub?: boolean; signal?: AbortSignal; onStart?: () => void; maxMs?: number }

/**
 * ffmpegPath: the ffmpeg program to run; empty = ffmpegCommand(binDir).
 * The recorders' bridges (one per recorder and username), each started when first needed and stopped after idleMs
 * unused or when its settings change.
 *
 * @param options - Options object.
 * @param options.readyMs - Ready ms.
 * @param options.idleMs - Idle timeout in milliseconds.
 * @param options.log - Callback receiving progress or diagnostic messages.
 * @returns Operation result.
 */
function createBridgePool({ readyMs, idleMs, log }: { readyMs: number; idleMs: number; log: Log }) {
  const bridges = new Map<string, Bridge>();

  function stop(key: string): void {
    const bridge = bridges.get(key);
    if (!bridge) return;
    bridges.delete(key);
    clearTimeout(bridge.timer);
    bridge.kill();
  }

  /**
   * The dahua-p2p package's relay tunnel (reliable PTCP layer), exposing the recorder's RTSP port on a local port. It
   * carries one stream at a time (later ones wait) and retries while the recorder still holds an earlier session.
   *
   * @param key - Lookup key, API key, or setting key.
   * @param cfg - Configuration or settings object.
   * @returns `Bridge` result.
   */
  function start(key: string, cfg: Recorder): Bridge {
    let closeTunnel = () => {};
    let server: { close: () => void } | null = null;
    let killed = false;
    /** port is set just below, once the bridge's other fields exist (its startup reports through them). */
    const bridge: Bridge = { password: cfg.password, lines: [], port: Promise.resolve(0), kill: () => { killed = true; server?.close(); closeTunnel(); } };
    const note = (line: string) => { bridge.lines.push(line); if (bridge.lines.length > 20) bridge.lines.shift(); };
    const tail = () => (bridge.lines.length ? `: ${maskSecrets(bridge.lines.slice(-3).join(' | '), [cfg.password])}` : '');
    log(`Recorder ${cfg.serial}: starting bridge`);
    const ended = (why: string) => {
      bridge.dead = true;
      if (bridges.get(key) === bridge) {
        bridges.delete(key); clearTimeout(bridge.timer);
        if (bridge.connected && !killed) log(`Recorder ${cfg.serial}: bridge closed (${why})${tail()}`);
      }
    };
    bridge.port = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const opening = openTunnel({ serial: cfg.serial, log: note });
      let opened = false;
      try {
        const tunnel = await Promise.race([
          opening,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Camera bridge did not connect within ${readyMs / 1000} s${tail()}`)), readyMs); }),
        ]);
        opened = true;
        closeTunnel = () => tunnel.close('stopped');
        if (killed) { tunnel.close('stopped'); throw new Error('Camera bridge stopped'); }
        tunnel.on('closed', (reason) => { server?.close(); ended(String(reason || 'closed')); });
        const srv = await tunnel.listen(0, 554, '127.0.0.1');
        server = srv;
        bridge.connected = true;
        log(`Recorder ${cfg.serial}: bridge connected (${tunnel.stats.handshakeMs} ms)`);
        return (srv.address() as AddressInfo).port;
      } catch (err) {
        // Close what is open: a tunnel whose local port failed (closeTunnel and server are no-ops before it opened), or
        // one that connects after the timeout.
        server?.close();
        closeTunnel();
        if (!opened) opening.then((late) => late.close('timed out'), () => {});
        ended((err as Error).message);
        throw new Error(`Camera bridge: ${maskSecrets((err as Error).message, [cfg.password])}`);
      } finally { clearTimeout(timer); }
    })();
    bridge.port.catch(() => {});
    return bridge;
  }

  /**
   * The bridge's local port, starting the bridge when needed.
   *
   * @param cfg - Configuration or settings object.
   * @returns `{ key: string; port: Promise<number>; b: Bridge }` result.
   */
  function bridge(cfg: Recorder): { key: string; port: Promise<number>; b: Bridge } {
    const key = `${cfg.serial}|${cfg.username}`;
    let running = bridges.get(key);
    if (running && (running.password !== cfg.password || running.dead)) { stop(key); running = undefined; }
    if (!running) { running = start(key, cfg); bridges.set(key, running); }
    idle(key, running);
    return { key, port: running.port, b: running };
  }

  function idle(key: string, b: Bridge): void {
    clearTimeout(b.timer);
    if (!b.busy && bridges.get(key) === b) {
      b.timer = setTimeout(() => { log(`Recorder ${key.split('|')[0]}: bridge stopped after ${idleMs / 1000} s idle`); stop(key); }, idleMs);
    }
  }

  /**
   * The recorder's RTSP address through the bridge on localPort.
   *
   * @param cfg - Configuration or settings object.
   * @param localPort - Local loopback TCP port exposed by the bridge.
   * @param pathQuery - RTSP path and query string.
   * @returns Computed result.
   */
  const streamUrl = (cfg: Recorder, localPort: number, pathQuery: string) =>
    `rtsp://${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@127.0.0.1:${localPort}${pathQuery}`;
  /**
   * Runs use(url) with the bridge counted busy (so it isn't closed as idle meanwhile).
   *
   * @param key - Lookup key, API key, or setting key.
   * @param b - Active dahua-p2p bridge handle.
   * @param use - Callback that uses the RTSP stream URL.
   * @param url - Target URL.
   * @returns Promise resolving to `T`.
   */
  async function onBridge<T>(key: string, b: Bridge, use: (url: string) => Promise<T>, url: string): Promise<T> {
    b.busy = (b.busy || 0) + 1;
    clearTimeout(b.timer);
    try {
      return await use(url);
    } finally {
      b.busy--;
      idle(key, b);
    }
  }

  const stopAll = () => { for (const key of [...bridges.keys()]) stop(key); };
  /**
   * Stops the bridge unless another has taken its place meanwhile, or another stream still uses it (and it isn't dead).
   *
   * @param key - Lookup key, API key, or setting key.
   * @param b - Active dahua-p2p bridge handle.
   */
  const drop = (key: string, b: Bridge): void => { if (bridges.get(key) === b && (!b.busy || b.dead)) stop(key); };
  return { bridge, onBridge, streamUrl, drop, stopAll, running: () => bridges.size };
}

/**
 * ffmpeg: saving a frame or a video from a stream, joining video parts, and the live view as MJPEG.
 *
 * @param options - Options object.
 * @param options.binDir - Bin dir.
 * @param options.ffmpegPath - Ffmpeg path.
 * @param options.grabMs - Grab ms.
 * @param options.clipExtraMs - Clip extra ms.
 * @returns Operation result.
 */
function createFfmpeg({ binDir, ffmpegPath, grabMs, clipExtraMs }: { binDir: string; ffmpegPath: string; grabMs: number; clipExtraMs: number }) {
  /**
   * video: seconds of video to save instead of one frame.
   *
   * @param url - Target URL.
   * @param outFile - Destination file path on disk.
   * @param secrets - `string[]` value.
   * @param [signal] - AbortSignal to cancel the operation.
   * @param [video] - Seconds of video to save instead of one frame.
   */
  function ffmpeg(url: string, outFile: string, secrets: string[], signal?: AbortSignal, video = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error(STOPPED_MSG));
      const input = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', String(grabMs * 1000)];
      const args = video
        ? [...input, '-i', url, '-t', String(video), '-map', '0:v:0', '-c', 'copy',
          '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov', '-y', outFile]
        : [...input, '-fflags', '+discardcorrupt', '-skip_frame', 'nokey', '-i', url, '-frames:v', '1', '-update', '1', '-q:v', '3', '-y', outFile];
      const proc = spawn(executable(ffmpegPath || ffmpegCommand(binDir)), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000); });
      const timer = setTimeout(() => proc.kill(), video ? video * 1000 + clipExtraMs : grabMs + 5000);
      const onAbort = () => proc.kill();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (error) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error(`ffmpeg: ${error.message}`));
      });
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

  /** Runs ffmpeg on local files, rejecting on spawn errors instead of returning a sentinel exit code. */
  function localFfmpeg(args: string[], ms = 60000): Promise<{ code: number | null; err: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(executable(ffmpegPath || ffmpegCommand(binDir)), ['-hide_banner', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (chunk) => { err = (err + chunk).slice(-4000); });
      const timer = setTimeout(() => proc.kill(), ms);
      proc.on('error', (error) => { clearTimeout(timer); reject(new Error(`ffmpeg: ${error.message}`)); });
      proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, err }); });
    });
  }

  /** A local video file's duration in seconds (0 when unreadable). */
  async function clipSeconds(file: string): Promise<number> {
    const out = await localFfmpeg(['-i', file], 30000).catch(() => ({ code: null, err: '' }));
    const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out.err);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  }

  /**
   * Joins the recorded parts (in order) into outFile (.mp4, playable while loading; H.265 tagged hvc1 so Safari
   * plays it) and saves the first keyframe to poster. Returns the video's duration in seconds; throws when it has
   * less than a second of video.
   *
   * @param parts - `string[]` value.
   * @param outFile - Destination file path on disk.
   * @param poster - `string` value.
   * @returns Promise resolving to `number`.
   * @throws Error when validation or the underlying operation fails.
   */
  async function finishClip(parts: string[], outFile: string, poster: string): Promise<number> {
    const list = `${outFile}.parts.txt`;
    const input = parts.length > 1 ? ['-f', 'concat', '-safe', '0', '-i', list] : ['-i', parts[0]];
    const drop = () => { fs.rmSync(outFile, { force: true }); fs.rmSync(poster, { force: true }); };
    if (parts.length > 1) fs.writeFileSync(list, parts.map((part) => `file '${part.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`).join(''));
    try {
      const tag = /Video: hevc/.test((await localFfmpeg(['-i', parts[0]], 30000)).err) ? ['-tag:v', 'hvc1'] : [];
      const result = await localFfmpeg(['-loglevel', 'error', '-skip_frame', 'nokey', ...input,
        '-map', '0:v:0', '-c', 'copy', ...tag, '-movflags', '+faststart', '-y', outFile,
        '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-q:v', '3', '-y', poster]);
      if (result.code !== 0 || !fs.existsSync(outFile) || !fs.statSync(outFile).size) {
        drop();
        throw new Error(`Could not save the video: ${result.err.trim().split(/\r?\n/).pop() || `ffmpeg exited (code ${result.code})`}`);
      }
    } finally {
      fs.rmSync(list, { force: true });
    }
    const secs = await clipSeconds(outFile);
    if (secs < 1) { drop(); throw new Error(NO_VIDEO_MSG); }
    return secs;
  }

  function mjpeg(url: string, out: Writable, secrets: string[],
    { signal, onStart, maxMs }: { signal?: AbortSignal; onStart: () => void; maxMs: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return resolve();
      const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', String(grabMs * 1000),
        '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', url, '-map', '0:v:0', '-an',
        '-vf', `fps=${LIVE_FPS},scale=w='min(${LIVE_WIDTH},iw)':h=-2`, '-c:v', 'mjpeg', '-q:v', '6',
        '-f', 'mpjpeg', '-boundary_tag', 'frame', 'pipe:1'];
      const proc = spawn(executable(ffmpegPath || ffmpegCommand(binDir)), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      let started = false;
      const firstTimer = setTimeout(() => proc.kill(), grabMs + 5000);
      const endTimer = setTimeout(() => proc.kill(), maxMs);
      proc.stderr.on('data', (chunk) => { err = (err + chunk).slice(-2000); });
      proc.stdout.on('data', (chunk) => {
        if (!started) { started = true; clearTimeout(firstTimer); onStart(); }
        if (!out.write(chunk)) { proc.stdout.pause(); out.once('drain', () => proc.stdout.resume()); }
      });
      const onAbort = () => proc.kill();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proc.on('error', (error) => {
        clearTimeout(firstTimer);
        clearTimeout(endTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error(`ffmpeg: ${error.message}`));
      });
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

  return { ffmpeg, clipSeconds, finishClip, mjpeg };
}

/**
 * Create camera runner.
 *
 * @param [options] - Options object.
 * @param [options.binDir] - Bin dir.
 * @param [options.ffmpegPath] - Ffmpeg path.
 * @param [options.idleMs] - Idle timeout in milliseconds.
 * @param [options.readyMs] - Ready ms.
 * @param [options.grabMs] - Grab ms.
 * @param [options.clipExtraMs] - Clip extra ms.
 * @param [options.connectTries] - Connect tries.
 * @param [options.connectWaitMs] - Connect wait ms.
 * @param [options.retryWaitMs] - Retry wait ms.
 * @param [options.log] - Callback receiving progress or diagnostic messages.
 * @returns Operation result.
 */
export function createCameraRunner({ binDir = BIN_DIR, ffmpegPath = '', idleMs = 120000, readyMs = 45000, grabMs = 45000,
  clipExtraMs = 60000, connectTries = 3, connectWaitMs = 10000, retryWaitMs = 2000, log = () => {} }: CameraRunnerOptions = {}) {
  const pool = createBridgePool({ readyMs, idleMs, log });
  const { bridge, onBridge, streamUrl, drop, stopAll } = pool;
  const { ffmpeg, clipSeconds, finishClip, mjpeg } = createFfmpeg({ binDir, ffmpegPath, grabMs, clipExtraMs });

  /**
   * Saves one frame from rtsp://<bridge><pathQuery> (e.g. /cam/playback?channel=1&starttime=...) to outFile.
   * signal (AbortSignal) stops the grab: it rejects with "Stopped". onRetry(error) runs before the second try.
   * once: no second try (bridge connection tries still apply). video: seconds of the stream to save instead (see
   * above).
   *
   * @param cfg - Configuration or settings object.
   * @param pathQuery - RTSP path and query string.
   * @param outFile - Destination file path on disk.
   * @param [options] - Options object.
   * @param [options.signal] - AbortSignal to cancel the operation.
   * @param [options.onRetry] - On retry.
   * @param [options.once] - When `true`, skip the second frame retry (bridge connection retries still apply).
   * @param [options.video] - Seconds of video stream to save (`0` for a single still frame).
   * @throws Error when validation or the underlying operation fails.
   */
  async function grabFrame(cfg: Recorder, pathQuery: string, outFile: string,
    { signal, onRetry = () => {}, once = false, video = 0 }: GrabOptions = {}): Promise<void> {
    let retried = once;
    for (let fails = 0; ;) {
      if (signal && signal.aborted) throw new Error(STOPPED_MSG);
      const { key, port, b } = bridge(cfg);
      let localPort: number;
      try {
        localPort = await port;
      } catch (err) {
        const { message } = err as Error;
        if (signal && signal.aborted) throw new Error(STOPPED_MSG);
        drop(key, b);
        log(`Recorder ${cfg.serial}: bridge did not connect (try ${fails + 1} of ${connectTries}): ${message}`);
        if (++fails >= connectTries) throw Object.assign(new Error(`Could not reach the recorder after ${fails} tries (${message})`), { code: NO_CONNECTION });
        await pause(connectWaitMs * fails, signal);
        continue;
      }
      try {
        return await onBridge(key, b, (url) => ffmpeg(url, outFile, [cfg.password], signal, video), streamUrl(cfg, localPort, pathQuery));
      } catch (caught) {
        const err = caught as Error;
        if (retried || err.message === STOPPED_MSG || (signal && signal.aborted)) throw err;
        retried = true;
        onRetry(err);
        if (err.message === DAMAGED_MSG) continue;
        if (b.dead || STREAM_NOT_OPENED.test(err.message)) drop(key, b);
        await pause(retryWaitMs, signal);
      }
    }
  }

  /**
   * Writes the live picture of one channel to out as MJPEG (multipart/x-mixed-replace; boundary=frame; up to
   * LIVE_WIDTH wide, LIVE_FPS a second). sub: the recorder's lower-resolution sub stream. onStart() runs before
   * the first write. Ends (resolves) when signal aborts, the stream stops, or after maxMs. Rejects when no
   * picture came; the stream is tried once more on a new bridge when the first try got none.
   *
   * @param cfg - Configuration or settings object.
   * @param channel - Recorder camera channel number (1–64).
   * @param out - Writable output stream.
   * @param [options] - Options object.
   * @param [options.sub] - The recorder's lower-resolution sub stream.
   * @param [options.signal] - AbortSignal to cancel the operation.
   * @param [options.onStart] - On start.
   * @param [options.maxMs] - Maximum duration in milliseconds.
   * @throws Error when validation or the underlying operation fails.
   */
  async function liveStream(cfg: Recorder, channel: number | string, out: Writable,
    { sub = true, signal, onStart = () => {}, maxMs = LIVE_MAX_MS }: LiveOptions = {}): Promise<void> {
    const pathQuery = `/cam/realmonitor?channel=${channel}&subtype=${sub ? 1 : 0}`;
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) return;
      const { key, port, b } = bridge(cfg);
      try {
        const localPort = await port;
        return await onBridge(key, b, (url) => mjpeg(url, out, [cfg.password], { signal, onStart, maxMs }), streamUrl(cfg, localPort, pathQuery));
      } catch (err) {
        if (attempt || (signal && signal.aborted)) throw err;
        log(`Recorder ${cfg.serial}: live view of channel ${channel} failed, trying a new bridge: ${(err as Error).message}`);
        drop(key, b);
      }
    }
  }

  return { grabFrame, clipSeconds, finishClip, liveStream, stopAll, running: pool.running };
}
