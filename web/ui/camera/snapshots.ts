// Camera snapshots. Each transaction's `minute` (YYYYMMDD-HHMM) names its snapshot folder; every transaction in
// the same minute shows the same frames. Frame files are ch<N>-<SS>.jpg (SS = seconds into the minute) and
// ch<N>-a<SS>.jpg (seconds into the minute after it). In video mode each channel has ch<N>.mp4 (2 minutes from the
// minute's start) with its first frame in ch<N>.jpg.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraSettings, SnapshotMinute, SnapshotRun, SnapshotsReply } from '../../../src/types.ts';
import { errorText, gateUrl, type GateApi } from '../api.ts';
import { fmtTime } from '../format.ts';

export const isVideo = (f: string) => f.endsWith('.mp4');
export const posterOf = (f: string) => f.replace(/\.mp4$/, '.jpg');
export const fileChannel = (f: string) => Number(/^ch(\d+)/.exec(f)![1]);
export const fmtMinute = (m: string) => `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)} ${m.slice(9, 11)}:${m.slice(11)}`;
const frameSecs = (n: number) => Array.from({ length: n }, (_, i) => String(Math.floor((i * 60) / n)).padStart(2, '0'));

export function frameCaption(f: string) {
  if (isVideo(f)) return '2-minute video';
  const [, after, s] = /-(a?)(\d+)\.jpg$/.exec(f)!;
  return `+${Number(s)} s${after ? ' after the minute' : ''}`;
}

// Gate time (H:MM:SS) of frame f of minute, taken `shift` seconds off its planned time.
export function shiftedTime(minute: string, f: string, shift: number) {
  const [, y, mo, d, h, mi] = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)$/.exec(minute)!.map(Number);
  const [, after, s] = /-(a?)(\d+)\.jpg$/.exec(f)!;
  return new Date(y, mo - 1, d, h, mi, (after ? 60 : 0) + Number(s) + shift)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

// Every frame of a minute: the camera settings' frames (or videos) plus any other saved file. A minute saved only
// in the other mode shows just its saved files; in video mode a minute with a saved video shows only its videos.
export function snapFiles(c: CameraSettings | null, s: SnapshotMinute): string[] {
  const video = Boolean(c && c.mode === 'video');
  let saved = s.files;
  if (video && saved.some(isVideo)) saved = saved.filter(isVideo);
  let want = !c ? [] : video ? c.channels.map(({ channel }) => `ch${channel}.mp4`)
    : c.channels.flatMap(({ channel }) => [...frameSecs(c.frames).map((x) => `ch${channel}-${x}.jpg`),
      ...frameSecs(c.framesAfter || 0).map((x) => `ch${channel}-a${x}.jpg`)]);
  if (saved.length && !saved.some((f) => isVideo(f) === video)) want = [];
  return [...new Set([...want, ...saved])].sort();
}

// One line about the current or last snapshot run.
function runText(r: SnapshotRun | null, noun: string): string {
  if (!r) return '';
  const p = r.progress;
  const left = p ? p.minutes - p.minutesDone : 0;
  const counts = r.result ? `${r.result.done} saved, ${r.result.partial || 0} missing some frames, ${r.result.failed} without a picture` : '';
  const at = fmtTime(r.finishedAt);
  if (r.state === 'running') {
    return `${r.stopping ? 'Stopping' : 'Getting'} camera snapshots… ${p ? `${p.framesDone} of ${p.frames} ${noun}, ${p.minutesDone} of ${p.minutes} minutes. ` : ''}`
      + (r.log.length ? r.log[r.log.length - 1] : '');
  }
  if (r.state === 'failed') return `Camera snapshots failed: ${r.error}`;
  if (!r.result) return '';
  if (r.state === 'stopped') return `Camera snapshots stopped: ${counts}; ${left} minutes left for the next run (${at})`;
  if (!r.result.minutes) {
    return r.result.error ? `Camera snapshots: ${r.result.error} (${at})`
      : `Camera snapshots: no transactions needing pictures in the look-back period (${at})`;
  }
  if (r.result.error) return `Camera snapshots ended early: ${r.result.error}. ${counts}; ${left} minutes left for the next run (${at})`;
  return `Camera snapshots: ${counts} (${at})`;
}

export type Snaps = ReturnType<typeof useSnapshots>;

// The snapshot log and the current run (polled every 2 s while it runs), and single-picture refreshes.
export function useSnapshots(phone: string, gapi: GateApi, settings: CameraSettings | null) {
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotMinute>>({});
  const [run, setRun] = useState<SnapshotRun | null>(null);
  const [versions, setVersions] = useState<Record<string, number>>({}); // "<minute>/<file>" -> time refreshed
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({}); // "<minute>/<file>" -> why its refresh failed
  const [note, setNote] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const video = Boolean(settings && settings.mode === 'video');
  const noun = video ? 'videos' : 'pictures';

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    if (!settings) { setSnapshots({}); setRun(null); return; }
    const out = await gapi<SnapshotsReply>('GET', '/snapshots').catch(() => null);
    if (!out) return;
    setSnapshots((prev) => (JSON.stringify(prev) === JSON.stringify(out.snapshots) ? prev : out.snapshots));
    setRun(out.run as SnapshotRun | null);
    if (out.run && out.run.state === 'running') timer.current = setTimeout(load, 2000);
  }, [gapi, settings]);

  useEffect(() => { load(); return () => clearTimeout(timer.current); }, [load]);

  const act = async (fn: () => Promise<unknown>, prefix = '') => {
    try { setNote(''); await fn(); await load(); } catch (e) { setNote(`${prefix}${errorText(e)}`); }
  };

  const refresh = async (minute: string, f: string) => {
    const key = `${minute}/${f}`;
    setRefreshing((r) => ({ ...r, [key]: true }));
    setErrors(({ [key]: _, ...rest }) => rest);
    try {
      const out = await gapi<{ snapshot: SnapshotMinute }>('POST', `/snapshots/${minute}/${encodeURIComponent(f)}/refresh`, {});
      setSnapshots((s) => ({ ...s, [minute]: out.snapshot }));
      setVersions((v) => ({ ...v, [key]: Date.now() }));
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: errorText(e) }));
      setNote(`${fmtMinute(minute)} ${frameCaption(f)}: not refreshed (${errorText(e)})`);
    }
    setRefreshing(({ [key]: _, ...rest }) => rest);
  };

  // URL of file (or of url, e.g. a video's picture) with the refresh version of file.
  const src = (minute: string, file: string, url = file) => gateUrl(phone, `/snapshots/${minute}/${url}`)
    + (versions[`${minute}/${file}`] ? `?v=${versions[`${minute}/${file}`]}` : '');

  const running = Boolean(run && run.state === 'running');
  return {
    settings, snapshots, run, running, video, noun, refreshing, errors, src, refresh, load,
    info: note || runText(run, noun),
    byMinute: running && run!.progress ? run!.progress.byMinute : {},
    current: running && run!.progress ? run!.progress.current : null,
    channelName: (n: number) => (settings && settings.channels.find((c) => c.channel === n)?.name) || `Channel ${n}`,
    runAll: () => act(() => gapi('POST', '/snapshots/run', {})),
    runMinute: (minute: string) => act(() => gapi('POST', '/snapshots/run', { minute }), `${fmtMinute(minute)}: `),
    stop: () => act(() => gapi('POST', '/snapshots/stop', {})),
  };
}
