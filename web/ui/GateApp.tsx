import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Callout, Flex, Link, Separator, Text } from '@radix-ui/themes';
import type { CameraSettings, DataReply, GateInfo, GatePrefs, Job, ResidentRow, ResidentsReply, TransactionRow } from '../../src/types.ts';
import { api, errorText, gateApi } from './api.ts';
import { DEFAULT_DEVICES, featuresOf, trackerOf, trackerRelays } from './format.ts';
import { LiveView } from './camera/LiveView.tsx';
import { SnapViewer } from './camera/SnapViews.tsx';
import { useSnapshots } from './camera/snapshots.ts';
import { useConfirm } from './Confirm.tsx';
import { gateLabel } from './Gates.tsx';
import { JOB_COLORS, JobDock, jobLabel, type DockState } from './JobDock.tsx';
import { Directory } from './panes/Directory.tsx';
import { History } from './panes/History.tsx';
import { Schedules } from './panes/Schedules.tsx';
import { ApbPage } from './settings/ApbPage.tsx';
import { FacilityPage, HolidaysPage } from './settings/ListPages.tsx';
import { ElevatorPage, HoldOpenPage, RelayElevatorPage, SecurityPage } from './settings/SchedulePages.tsx';
import { DisplayPage, RelaysPage } from './settings/RelaysDisplay.tsx';
import { SystemSettings } from './settings/SystemSettings.tsx';
import { Transactions } from './panes/Transactions.tsx';
import type { SignedIn } from './App.tsx';

const NAV = [
  { key: 'residents', label: 'Residents' }, { key: 'vendors', label: 'Vendors' }, { key: 'transactions', label: 'Transactions' },
  { section: 'System' },
  { key: 'display', label: 'Display' }, { key: 'relays', label: 'Relays' }, { key: 'holdOpen', label: 'Hold Open' },
  { key: 'holidays', label: 'Holidays' }, { key: 'security', label: 'Security Levels' }, { key: 'facility', label: 'Facility Codes' },
  { key: 'elevator', label: 'Elevator Reference' }, { key: 'relayElevator', label: 'Relay / Elevator' }, { key: 'apb', label: 'Anti-Pass Back' },
] as const;
// Pinned at the bottom of the sidebar, above Gate connection.
const PINNED_NAV = [
  { key: 'history', label: 'History' }, { key: 'schedules', label: 'Scheduled Transfers' }, { key: 'prefs', label: 'System Settings' },
] as const;
type NavKey = Extract<(typeof NAV)[number], { key: string }>['key'] | (typeof PINNED_NAV)[number]['key'];

const PULL_WARNING = {
  residents: 'This refreshes the working copy with the gate\'s current data. If you have unsaved resident edits they are kept (use "Reset to gate" to discard them).',
  transactions: '',
};

// The open gate: sidebar navigation and gate connection, and the page for the chosen item.
export function GateApp({ session, gate, onChange, dark, onToggleDark }: {
  session: SignedIn; gate: GateInfo; onChange: () => void; dark: boolean; onToggleDark: () => void;
}) {
  const gapi = useMemo(() => gateApi(gate.phoneNumber), [gate.phoneNumber]);
  const [nav, setNav] = useState<NavKey>('residents');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [data, setData] = useState<DataReply | null>(null);
  const [residents, setResidents] = useState<ResidentsReply | null>(null);
  const [prefs, setPrefs] = useState<GatePrefs>({});
  const [cameras, setCameras] = useState<CameraSettings | null>(null);
  const [viewing, setViewing] = useState<TransactionRow | null>(null);
  const snaps = useSnapshots(gate.phoneNumber, gapi, cameras);
  const loadSnaps = useRef(snaps.load);
  loadSnaps.current = snaps.load;
  const [job, setJob] = useState<Job | null>(null);
  const [dock, setDock] = useState<DockState>('closed');
  const [error, setError] = useState('');
  const [dialog, confirm] = useConfirm();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastFinished = useRef<string | undefined>(undefined);

  useEffect(() => { document.title = `${gateLabel(gate)} · DoorKing Gate Data`; }, [gate]);

  // Sidebar spacing: the roomiest density (0 normal, 1 compact, 2 tight) whose menu fits without scrolling.
  // Rechecked after every render (items and the job badge come and go) and on window resize.
  const sidebar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = sidebar.current;
      const menu = el?.querySelector<HTMLElement>('.sidebar-nav');
      if (!el || !menu) return;
      for (let d = 0; d <= 2; d++) {
        el.dataset.density = String(d);
        if (menu.scrollHeight <= menu.clientHeight) break;
      }
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });

  const loadData = useCallback(async () => {
    const [d, r, p, c] = await Promise.all([gapi<DataReply>('GET', '/data').catch(() => null),
      gapi<ResidentsReply>('GET', '/residents').catch(() => null), gapi<GatePrefs>('GET', '/prefs').catch(() => ({})),
      gapi<{ settings: CameraSettings | null }>('GET', '/cameras').catch(() => null)]);
    setData(d);
    setResidents(r && r.rows ? r : null);
    setPrefs(p);
    setCameras((prev) => (JSON.stringify(prev) === JSON.stringify(c ? c.settings : null) ? prev : c ? c.settings : null));
    loadSnaps.current();
  }, [gapi]);

  // Polls the gate connection every 3 s while it runs. When a pull or send finishes, reloads the data and shows
  // its page (not for a connection that had already finished when the gate was opened).
  const refreshJob = useCallback(async () => {
    clearTimeout(timer.current);
    const j = await gapi<Job>('GET', '/job').catch(() => null);
    if (!j) return;
    setJob(j);
    if (j.state === 'running') {
      setDock((d) => (d === 'closed' ? 'open' : d));
      timer.current = setTimeout(refreshJob, 3000);
    } else if (j.finishedAt && j.finishedAt !== lastFinished.current) {
      const first = lastFinished.current === undefined;
      lastFinished.current = j.finishedAt;
      if (!first && j.state === 'done') {
        setNav(j.what === 'transactions' ? 'transactions' : 'residents');
        loadData();
        if (!gate.verified) onChange();
      }
    }
  }, [gapi, loadData, gate.verified, onChange]);

  useEffect(() => {
    loadData();
    refreshJob().then(() => { if (lastFinished.current === undefined) lastFinished.current = ''; });
    return () => clearTimeout(timer.current);
  }, [loadData, refreshJob]);

  const jobStarted = () => { setDock('open'); refreshJob(); };

  async function pull(what: 'residents' | 'transactions') {
    if (!await confirm({ title: `Pull ${what} from the gate?`, body: PULL_WARNING[what] || undefined, action: `Pull ${what}` })) return;
    try { await gapi('POST', '/pull', { what }); jobStarted(); } catch (e) { setError(errorText(e)); }
  }

  const allGates = async () => { await api('DELETE', '/api/session/gate').catch(() => {}); document.title = 'DoorKing Gate Data'; onChange(); };
  const signOut = async () => { await api('DELETE', '/api/session').catch(() => {}); onChange(); };
  const go = (key: NavKey) => { setNav(key); setHighlight(null); };
  const openResident = (r: ResidentRow) => { setNav(r.type === 'Vendor' ? 'vendors' : 'residents'); setHighlight(r.directoryCode); };
  const running = job?.state === 'running';
  const features = featuresOf(prefs);
  const relays = trackerRelays(trackerOf(prefs));
  const shown = (key: string) => (key !== 'elevator' && key !== 'relayElevator') || features.elevators;

  let page;
  if (nav === 'residents' || nav === 'vendors' || !shown(nav)) {
    const kind = nav === 'vendors' ? 'vendors' : 'residents';
    page = <Directory key={kind} kind={kind} list={residents} tx={data?.transactions?.rows ?? null} highlight={highlight}
      devices={prefs.deviceAssociation || DEFAULT_DEVICES} features={features} snaps={snaps} onOpenSnap={setViewing}
      gapi={gapi} onReload={loadData} onJobStarted={jobStarted} />;
  } else if (nav === 'transactions') {
    page = <Transactions tx={data?.transactions ?? null} residents={residents?.rows ?? []} onOpenResident={openResident}
      snaps={snaps} onOpenSnap={setViewing} />;
  } else if (nav === 'history') {
    page = <History gapi={gapi} onReverted={loadData} />;
  } else if (nav === 'schedules') {
    page = <Schedules gapi={gapi} video={snaps.video} />;
  } else if (nav === 'prefs') {
    page = <SystemSettings phone={gate.phoneNumber} gapi={gapi} prefs={prefs} defaults={session.defaults} list={residents}
      cameras={cameras} dark={dark} onToggleDark={onToggleDark} onReload={loadData} onSessionChange={onChange} onJobStarted={jobStarted} />;
  } else if (nav === 'relays') {
    page = <RelaysPage gapi={gapi} prefs={prefs} onReload={loadData} onJobStarted={jobStarted} />;
  } else if (nav === 'display') {
    page = <DisplayPage gapi={gapi} onReload={loadData} onJobStarted={jobStarted} />;
  } else if (nav === 'holdOpen') {
    page = <HoldOpenPage gapi={gapi} relays={relays} />;
  } else if (nav === 'holidays') {
    page = <HolidaysPage gapi={gapi} holidays={session.holidayList || []} />;
  } else if (nav === 'security') {
    page = <SecurityPage gapi={gapi} floors={features.floors} relays={relays} />;
  } else if (nav === 'facility') {
    page = <FacilityPage gapi={gapi} />;
  } else if (nav === 'elevator') {
    page = <ElevatorPage gapi={gapi} />;
  } else if (nav === 'relayElevator') {
    page = <RelayElevatorPage gapi={gapi} prefs={prefs} />;
  } else {
    page = <ApbPage gapi={gapi} relayLabels={prefs.relayLabels || {}} relays={relays} />;
  }

  return (
    <div className="app">
      {dialog}
      <aside className="sidebar" ref={sidebar}>
        <Flex direction="column" gap="1" p="3" className="sidebar-nav">
          <Text size="4" weight="bold">{gateLabel(gate)}</Text>
          <Link href="#" size="2" className="nav-gates" onClick={(e) => { e.preventDefault(); allGates(); }}>All gates</Link>
          {NAV.filter((n) => 'section' in n || shown(n.key)).map((n, i) => ('section' in n
            ? <Text key={i} size="1" color="gray" weight="bold" className="nav-section">{n.section}</Text>
            : <Button key={n.key} className="nav-item" variant={nav === n.key ? 'soft' : 'ghost'} color={nav === n.key ? undefined : 'gray'}
              onClick={() => go(n.key)}>{n.label}</Button>))}
        </Flex>
        <Flex direction="column" gap="1" p="3" className="sidebar-bottom">
          {PINNED_NAV.map((n) => (
            <Button key={n.key} className="nav-item" variant={nav === n.key ? 'soft' : 'ghost'} color={nav === n.key ? undefined : 'gray'}
              onClick={() => go(n.key)}>{n.label}</Button>
          ))}
          <Button asChild className="nav-item" variant="ghost" color="gray">
            <a href="/help" target="_blank" rel="noopener" title="Open the user guide in a new tab">Help ↗</a>
          </Button>
          <Separator size="4" />
          <Text size="1" color="gray" weight="bold">Gate connection</Text>
          <Button variant="soft" className="nav-action" disabled={running} onClick={() => pull('residents')}>Pull residents</Button>
          <Button variant="soft" className="nav-action" disabled={running} onClick={() => pull('transactions')}>Pull transactions</Button>
          <Flex direction="column" gap="1" align="stretch">
            {jobLabel(job) && <Badge size="2" color={JOB_COLORS[job!.state]} className="nav-action"
              style={{ justifyContent: 'center' }}>{jobLabel(job)}</Badge>}
            {dock === 'closed' && job && job.log.length > 0 && <Link href="#" size="1" style={{ textAlign: 'center' }} onClick={(e) => { e.preventDefault(); setDock('open'); }}>Show progress</Link>}
          </Flex>
          <Separator size="4" />
          <Text size="1" color="gray">{session.user}</Text>
          <Flex gap="2" wrap="wrap">
            <Button size="1" variant="soft" color="gray" onClick={signOut}>Sign out</Button>
            <Button size="1" variant="soft" color="gray" onClick={onToggleDark}>{dark ? 'Light mode' : 'Dark mode'}</Button>
          </Flex>
        </Flex>
      </aside>
      <main className="content">
        {!gate.verified && (
          <Callout.Root color="amber" mb="4">
            <Callout.Text>Not connected yet: pull residents or transactions to open this gate's saved data.</Callout.Text>
          </Callout.Root>
        )}
        {error && <Callout.Root color="red" mb="4"><Callout.Text>{error}</Callout.Text></Callout.Root>}
        {page}
      </main>
      <JobDock job={job} state={dock} onState={setDock} />
      <SnapViewer t={viewing} snaps={snaps} onClose={() => setViewing(null)} />
      {cameras && <LiveView phone={gate.phoneNumber} settings={cameras} />}
    </div>
  );
}
