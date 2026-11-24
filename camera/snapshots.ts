/**
 * @module web/ui/camera/snapshots
 *
 * Camera snapshots. Each transaction's `minute` (YYYYMMDD-HHMM) names its snapshot folder; every transaction in
 * the same minute shows the same frames. Frame files are ch<N>-<SS>.jpg (SS = seconds into the minute) and
 * ch<N>-a<SS>.jpg (seconds into the minute after it). In video mode each channel has ch<N>.mp4 (2 minutes from the
 * minute's start) with its first frame in ch<N>.jpg.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraSettings, SnapshotMinute, SnapshotRun, SnapshotsReply } from '../types.ts';
import { errorText, gateUrl, type GateApi } from '../api.ts';
import { fmtTime } from '../format.ts';
import { frameJobs, posterFile } from '../lib/shared.ts';

/**
 * Is video.
 *
 * @param file - File path or filename.
 * @returns Computed result.
 */
export const isVideo = (file: string) => file.endsWith('.mp4');
export const posterOf = posterFile;
/**
 * File channel.
 *
 * @param file - File path or filename.
 * @returns Computed result.
 */
export const fileChannel = (file: string) => Number(/^ch(\d+)/.exec(file)![1]);
/**
 * Fmt minute.
 *
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @returns Computed result.
 */
export const fmtMinute = (minute: string) => `${minute.slice(0, 4)}-${minute.slice(4, 6)}-${minute.slice(6, 8)} ${minute.slice(9, 11)}:${minute.slice(11)}`;

/**
 * Frame caption.
 *
 * @param file - File path or filename.
 * @returns Operation result.
 */
export function frameCaption(file: string) {
  if (isVideo(file)) return '2-minute video';
  const [, after, seconds] = /-(a?)(\d+)\.jpg$/.exec(file)!;
  return `+${Number(seconds)} s${after ? ' after the minute' : ''}`;
}

/**
 * Gate time (H:MM:SS) of frame f of minute, taken `shift` seconds off its planned time.
 *
 * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param file - File path or filename.
 * @param shift - `number` value.
 * @returns Operation result.
 */
export function shiftedTime(minute: string, file: string, shift: number) {
  const [, year, month, day, hour, minuteOfHour] = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(minute)!.map(Number);
  const [, after, seconds] = /-(a?)(\d+)\.jpg$/.exec(file)!;
  return new Date(year, month - 1, day, hour, minuteOfHour, (after ? 60 : 0) + Number(seconds) + shift)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/**
 * Every frame of a minute: the camera settings' frames (or videos) plus any other saved file. A minute saved only
 * in the other mode shows just its saved files; in video mode a minute with a saved video shows only its videos.
 *
 * @param settings - Settings map or configuration.
 * @param snapshot - `SnapshotMinute` value.
 * @returns `string[]` result.
 */
export function snapFiles(settings: CameraSettings | null, snapshot: SnapshotMinute): string[] {
  const video = Boolean(settings && settings.mode === 'video');
  let saved = snapshot.files;
  if (video && saved.some(isVideo)) saved = saved.filter(isVideo);
  let want = settings ? frameJobs(settings).map((job) => job.file) : [];
  if (saved.length && !saved.some((file) => isVideo(file) === video)) want = [];
  return [...new Set([...want, ...saved])].sort();
}

/**
 * One line about the current or last snapshot run.
 *
 * @param run - `SnapshotRun | null` value.
 * @param noun - `string` value.
 * @returns `string` result.
 */
function runText(run: SnapshotRun | null, noun: string): string {
  if (!run) return '';
  const progress = run.progress;
  const left = progress ? progress.minutes - progress.minutesDone : 0;
  const counts = run.result ? `${run.result.done} saved, ${run.result.partial || 0} missing some frames, ${run.result.failed} without a picture` : '';
  const at = fmtTime(run.finishedAt);
  if (run.state === 'running') {
    return `${run.stopping ? 'Stopping' : 'Getting'} camera snapshots… ${progress ? `${progress.framesDone} of ${progress.frames} ${noun}, ${progress.minutesDone} of ${progress.minutes} minutes. ` : ''}`
      + (run.log.length ? run.log[run.log.length - 1] : '');
  }
  if (run.state === 'failed') return `Camera snapshots failed: ${run.error}`;
  if (!run.result) return '';
  if (run.state === 'stopped') return `Camera snapshots stopped: ${counts}; ${left} minutes left for the next run (${at})`;
  if (!run.result.minutes) {
    return run.result.error ? `Camera snapshots: ${run.result.error} (${at})`
      : `Camera snapshots: no transactions needing pictures in the look-back period (${at})`;
  }
  if (run.result.error) return `Camera snapshots ended early: ${run.result.error}. ${counts}; ${left} minutes left for the next run (${at})`;
  return `Camera snapshots: ${counts} (${at})`;
}

export type Snaps = ReturnType<typeof useSnapshots>;

/**
 * The snapshot log and the current run (polled every 2 s while it runs), and single-picture refreshes.
 *
 * @param phone - Gate system phone number (digits or formatted).
 * @param gapi - Gate-scoped API fetch helper.
 * @param settings - Settings map or configuration.
 * @returns Operation result.
 */
export function useSnapshots(phone: string, gapi: GateApi, settings: CameraSettings | null) {
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotMinute>>({});
  const [run, setRun] = useState<SnapshotRun | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({}); // "<minute>/<file>" -> time refreshed
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({}); // "<minute>/<file>" -> why its refresh failed
  const [note, setNote] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pollGen = useRef(0);
  const runActive = useRef(false);
  const video = Boolean(settings && settings.mode === 'video');
  const noun = video ? 'videos' : 'pictures';

  /**
   * Polls every 2 s while a run is going (a failed check is tried again). pollGen: bumped on cleanup, so a check still
   * on its way doesn't start polling again for a closed gate.
   */
  const load = useCallback(async () => {
    clearTimeout(timer.current);
    if (!settings) { setSnapshots({}); setRun(null); return; }
    const gen = pollGen.current;
    const out = await gapi<SnapshotsReply>('GET', '/snapshots').catch(() => null);
    if (gen !== pollGen.current) return;
    if (!out) {
      if (runActive.current) timer.current = setTimeout(load, 2000);
      return;
    }
    runActive.current = Boolean(out.run && out.run.state === 'running');
    setSnapshots((prev) => (JSON.stringify(prev) === JSON.stringify(out.snapshots) ? prev : out.snapshots));
    setRun(out.run as SnapshotRun | null);
    if (out.run && out.run.state === 'running') timer.current = setTimeout(load, 2000);
  }, [gapi, settings]);

  useEffect(() => { load(); return () => { pollGen.current++; clearTimeout(timer.current); }; }, [load]);

  const act = async (fn: () => Promise<unknown>, prefix = '') => {
    try { setNote(''); await fn(); await load(); } catch (err) { setNote(`${prefix}${errorText(err)}`); }
  };

  const refresh = async (minute: string, file: string) => {
    const key = `${minute}/${file}`;
    setRefreshing((current) => ({ ...current, [key]: true }));
    setErrors(({ [key]: _, ...rest }) => rest);
    try {
      const out = await gapi<{ snapshot: SnapshotMinute }>('POST', `/snapshots/${minute}/${encodeURIComponent(file)}/refresh`, {});
      setSnapshots((current) => ({ ...current, [minute]: out.snapshot }));
      setVersions((current) => ({ ...current, [key]: Date.now() }));
    } catch (err) {
      setErrors((current) => ({ ...current, [key]: errorText(err) }));
      setNote(`${fmtMinute(minute)} ${frameCaption(file)}: not refreshed (${errorText(err)})`);
    }
    setRefreshing(({ [key]: _, ...rest }) => rest);
  };

  /**
   * URL of file (or of url, e.g. a video's picture) with the refresh version of file.
   *
   * @param minute - Transaction minute key (`YYYYMMDD-HHMM`).
   * @param file - File path or filename.
   * @param [url] - Target URL.
   * @returns Computed result.
   */
  const src = (minute: string, file: string, url = file) => gateUrl(phone, `/snapshots/${minute}/${url}`)
    + (versions[`${minute}/${file}`] ? `?v=${versions[`${minute}/${file}`]}` : '');

  const running = Boolean(run && run.state === 'running');
  return {
    settings, snapshots, run, running, video, noun, refreshing, errors, src, refresh, load,
    info: note || runText(run, noun),
    byMinute: running && run!.progress ? run!.progress.byMinute : {},
    current: running && run!.progress ? run!.progress.current : null,
    channelName: (wanted: number) => (settings && settings.channels.find((channel) => channel.channel === wanted)?.name) || `Channel ${wanted}`,
    runAll: () => act(() => gapi('POST', '/snapshots/run', {})),
    runMinute: (minute: string) => act(() => gapi('POST', '/snapshots/run', { minute }), `${fmtMinute(minute)}: `),
    stop: () => act(() => gapi('POST', '/snapshots/stop', {})),
  };
}
