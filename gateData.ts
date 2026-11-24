/**
 * @module web/ui/gateData
 *
 * The open gate's data and connection, and the sidebar's spacing, for GateApp.
 */
import { useCallback, useRef, useState } from 'react';
import type { CameraSettings, DataReply, GatePrefs, Job, ResidentsReply } from './types.ts';
import { ApiError, errorText, type GateApi } from './api.ts';

/**
 * The gate's transactions, residents, preferences and camera settings. loadData reloads them: nothing pulled yet
 * (404) is an empty page; any other failure keeps what is shown and says so (loadError, cleared by the next load that
 * works). afterLoad runs after each load (GateApp reloads the snapshots). loadOlder adds the next older page of
 * transactions (GET /data returns the newest page) at the end of the list.
 *
 * @param gapi - Gate-scoped API fetch helper.
 * @param afterLoad - `() => void` value.
 * @returns Operation result.
 */
export function useGateData(gapi: GateApi, afterLoad: () => void) {
  const [data, setData] = useState<DataReply | null>(null);
  const [residents, setResidents] = useState<ResidentsReply | null>(null);
  const [prefs, setPrefs] = useState<GatePrefs>({});
  const [cameras, setCameras] = useState<CameraSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const after = useRef(afterLoad);
  after.current = afterLoad;

  const loadData = useCallback(async () => {
    const failures: string[] = [];
    const get = <T,>(path: string, empty: T) => gapi<T>('GET', path).catch((err) => {
      const missing = err instanceof ApiError && err.status === 404;
      if (!missing) failures.push(errorText(err));
      return missing ? empty : undefined;
    });
    const [dataReply, residentsReply, prefsReply, camerasReply] = await Promise.all([get<DataReply | null>('/data', null),
      get<ResidentsReply | null>('/residents', null), get<GatePrefs>('/prefs', {}), get<{ settings: CameraSettings | null } | null>('/cameras', null)]);
    if (dataReply !== undefined) setData(dataReply);
    if (residentsReply !== undefined) setResidents(residentsReply && residentsReply.rows ? residentsReply : null);
    if (prefsReply !== undefined) setPrefs(prefsReply);
    if (camerasReply !== undefined) {
      const next = camerasReply ? camerasReply.settings : null;
      setCameras((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }
    setLoadError(failures.length ? `Couldn't load the gate's data: ${[...new Set(failures)].join('; ')}` : '');
    after.current();
  }, [gapi]);

  const loadOlder = useCallback(async () => {
    const next = data?.transactions?.next;
    if (next == null) return;
    const reply = await gapi<DataReply>('GET', `/data?before=${next}`);
    setData((cur) => (cur?.transactions && reply.transactions
      ? { ...cur, transactions: { ...cur.transactions, rows: [...cur.transactions.rows, ...reply.transactions.rows], next: reply.transactions.next } } : cur));
  }, [gapi, data]);

  return { data, residents, prefs, cameras, loadError, loadData, loadOlder };
}

interface GateJobEvents {
  onRunning: () => void; // a connection is running (GateApp opens the progress window)
  onFinished: (job: Job) => void; // a pull or send started from this page finished well
}

/**
 * The gate's connection: polled every 3 s while it runs (a failed check is tried again). onFinished is not called for
 * a connection that had already finished when the gate was opened. stop() ends the polling (the page closes; a check
 * still on its way then doesn't start polling again). started(): a connection was just started here.
 *
 * @param gapi - Gate-scoped API fetch helper.
 * @param events - `GateJobEvents` value.
 * @returns Operation result.
 */
export function useGateJob(gapi: GateApi, events: GateJobEvents) {
  const [job, setJob] = useState<Job | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pollGen = useRef(0);
  const running = useRef(false);
  const lastFinished = useRef<string | undefined>(undefined);
  const on = useRef(events);
  on.current = events;

  const refresh = useCallback(async () => {
    clearTimeout(timer.current);
    const gen = pollGen.current;
    const latest = await gapi<Job>('GET', '/job').catch(() => null);
    if (gen !== pollGen.current) return;
    if (!latest) {
      if (running.current) timer.current = setTimeout(refresh, 3000);
      return;
    }
    running.current = latest.state === 'running';
    setJob(latest);
    if (latest.state === 'running') {
      on.current.onRunning();
      timer.current = setTimeout(refresh, 3000);
      return;
    }
    if (!latest.finishedAt || latest.finishedAt === lastFinished.current) return;
    const first = lastFinished.current === undefined;
    lastFinished.current = latest.finishedAt;
    if (!first && latest.state === 'done') on.current.onFinished(latest);
  }, [gapi]);

  /** The first check: a connection that finished before the gate was opened is then known as already seen. */
  const start = useCallback(() => refresh().then(() => { if (lastFinished.current === undefined) lastFinished.current = ''; }), [refresh]);
  const stop = useCallback(() => { pollGen.current++; clearTimeout(timer.current); }, []);
  const started = () => { running.current = true; refresh(); };
  return { job, start, stop, started };
}
