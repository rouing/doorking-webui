import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Box, IconButton, Tab, Tabs } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { GateInfo, ResidentRow, TransactionRow } from './types.ts';
import { api, DraftActionsContext, errorText, gateApi, GateRoleContext, ReadOnlyContext, WorkingCopySavedContext, type DraftActions } from './api.ts';
import { useGateData, useGateJob } from './gateData.ts';
import { useBackLayer } from './back.ts';
import { usePhone } from './phone.ts';
import { UserSettings } from './account/UserSettings.tsx';
import { featuresOf, trackerOf, trackerRelays } from './format.ts';
import { DEFAULT_DEVICE_ASSOCIATION } from './lib/shared.ts';
import { LiveView } from './camera/LiveView.tsx';
import { SnapViewer } from './camera/SnapViews.tsx';
import { useSnapshots } from './camera/snapshots.ts';
import { useConfirm } from './Confirm.tsx';
import { gateLabel } from './Gates.tsx';
import { JobDock, type DockState } from './JobDock.tsx';
import { Directory } from './panes/Directory.tsx';
import { workingCopyState } from './panes/WorkingCopyBar.tsx';
import { BOARD_SETTING_TABS, isBoardSettingPage, PAGE_TITLES, pageShown, type NavKey } from './nav/pages.ts';
import { GateSheet, PhoneTabBar, PhoneTopBar, TAB_PAGES } from './nav/PhoneNav.tsx';
import { PhoneMorePage } from './nav/PhoneMorePage.tsx';
import { QuickJump } from './nav/QuickJump.tsx';
import { SidebarItems } from './nav/SidebarItems.tsx';
import { Audit } from './panes/Audit.tsx';
import { History } from './panes/History.tsx';
import { Schedules } from './panes/Schedules.tsx';
import { ApbPage } from './settings/ApbPage.tsx';
import { FacilityPage, HolidaysPage } from './settings/ListPages.tsx';
import { ElevatorPage, HoldOpenPage, RelayElevatorPage, SecurityPage } from './settings/SchedulePages.tsx';
import { DisplayPage, RelaysPage } from './settings/RelaysDisplay.tsx';
import { SystemSettings } from './settings/SystemSettings.tsx';
import { Transactions } from './panes/Transactions.tsx';
import type { SignedIn } from './App.tsx';

const EDIT_PAGES: NavKey[] = ['display', 'relays', 'holdOpen', 'holidays', 'security', 'facility', 'elevator', 'relayElevator', 'apb', 'schedules'];
const ADMIN_ONLY_PAGES: NavKey[] = ['schedules'];

const PULL_WARNING = {
  residents: 'This reads the gate\'s current data. Changes you haven\'t sent stay on top of it; anything changed both at the gate and here is listed for you to decide.',
  transactions: '',
};

interface GateAppProps {
  session: SignedIn;
  gate: GateInfo;
  onChange: () => void;
  onOpenPortal?: () => void;
}

/**
 * The open gate: sidebar navigation and gate connection, and the page for the chosen item. On phones the sidebar is a
 * bottom tab bar (Residents, Vendors, Transactions, Gate: the connection sheet, More: the drawer with every other page). Back
 * closes the sheet or drawer, then goes from another page to Residents, then back to the gate list. Read-only users see
 * every page but can't change anything (they can pull and use the cameras).
 *
 * @param props - Component props.
 * @param props.session - Authenticated user or API-key session.
 * @param props.gate - Open gate summary (`phoneNumber`, `siteName`, `role`).
 * @param props.onChange - Callback invoked when the value changes.
 * @returns Rendered React element.
 */
export function GateApp({ session, gate, onChange, onOpenPortal }: GateAppProps) {
  const gapi = useMemo(() => gateApi(gate.phoneNumber), [gate.phoneNumber]);
  const readOnly = gate.role === 'readonly';
  const isAdmin = gate.role === 'admin';
  const [nav, setNav] = useState<NavKey>('residents');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [viewing, setViewing] = useState<TransactionRow | null>(null);
  const loadSnaps = useRef<() => void>(() => {});
  const { data, residents, prefs, cameras, loadError, loadData, loadOlder } = useGateData(gapi, () => loadSnaps.current());
  const snaps = useSnapshots(gate.phoneNumber, gapi, cameras);
  loadSnaps.current = snaps.load;
  const [dock, setDock] = useState<DockState>('closed');
  const [moreHub, setMoreHub] = useState(false); // full-page "More" hub on phones (replaces sidebar drawer)
  const [gateSheet, setGateSheet] = useState(false); // the Gate tab's sheet (phones)
  const [quickJump, setQuickJump] = useState(false); // global Cmd/Ctrl+K search dialog
  const [actionInfo, setActionInfo] = useState(''); // the outcome of Reset to gate / Send to gate (sidebar or Gate sheet)
  const [draft, setDraft] = useState<DraftActions | null>(null);
  const [pageKey, setPageKey] = useState(0); // bumped to reload the open page (its settings) after Reset to gate
  const [error, setError] = useState('');
  const [dialog, confirm] = useConfirm();
  /** When a pull or send finishes, the data reloads and its page shows. */
  const { job, start: watchJob, stop: stopWatching, started } = useGateJob(gapi, {
    onRunning: () => setDock((current) => (current === 'closed' ? 'open' : current)),
    onFinished: (finished) => { setNav(finished.what === 'transactions' ? 'transactions' : 'residents'); window.scrollTo(0, 0); loadData(); },
  });

  useEffect(() => { document.title = `${gateLabel(gate)} · Doorking Gate`; }, [gate]);
  const phone = usePhone();

  useEffect(() => {
    loadData();
    watchJob();
    return stopWatching;
  }, [loadData, watchJob, stopWatching]);

  const jobStarted = () => { setDock('open'); started(); };

  async function pull(what: 'residents' | 'transactions') {
    setMoreHub(false);
    setGateSheet(false);
    if (!await confirm({ title: `Pull ${what} from the gate?`, body: PULL_WARNING[what] || undefined, action: `Pull ${what}` })) return;
    try { await gapi('POST', '/pull', { what }); jobStarted(); } catch (err) { setError(errorText(err)); }
  }

  const allGates = async () => { await api('DELETE', '/api/session/gate').catch(() => {}); document.title = 'Doorking Gate'; onChange(); };
  /**
   * Opens another of the user's gates (the server session keeps the open gate; App then shows it).
   *
   * @param to - Recipient email address.
   */
  const switchGate = async (to: GateInfo) => {
    setMoreHub(false);
    try { await api('PUT', '/api/session/gate', { phoneNumber: to.phoneNumber }); onChange(); } catch (err) { setError(errorText(err)); }
  };
  const signOut = async () => { await api('DELETE', '/api/session').catch(() => {}); onChange(); };
  /**
   * A new page starts at its top (a resident opened from Transactions scrolls itself into view instead).
   *
   * @param key - Lookup key, API key, or setting key.
   */
  const go = (key: NavKey) => { setNav(key); setHighlight(null); setMoreHub(false); setGateSheet(false); window.scrollTo(0, 0); };
  const openMoreHub = () => { setGateSheet(false); setMoreHub(true); window.scrollTo(0, 0); };
  const isPhoneSubPage = phone && !moreHub && !TAB_PAGES.includes(nav);
  useBackLayer(true, allGates);
  useBackLayer(nav !== 'residents' || moreHub, () => (isPhoneSubPage ? openMoreHub() : go('residents')));
  useBackLayer(gateSheet, () => setGateSheet(false));
  useBackLayer(dock === 'open', () => setDock('min'));
  const openResident = (resident: ResidentRow) => { setNav(resident.type === 'Vendor' ? 'vendors' : 'residents'); setHighlight(resident.directoryCode); };
  const running = job?.state === 'running';
  const features = featuresOf(prefs);
  const relays = trackerRelays(trackerOf(prefs));

  const directory = (kind: 'residents' | 'vendors') => (
    <Directory key={kind} kind={kind} gatePhone={gate.phoneNumber} adminPhone={prefs.adminPhone || ''} account={gate.siteName} list={residents} tx={data?.transactions?.rows ?? null} highlight={highlight}
      devices={prefs.deviceAssociation || DEFAULT_DEVICE_ASSOCIATION} features={features} snaps={snaps} onOpenSnap={setViewing}
      gapi={gapi} onReload={loadData} />
  );
  const pages: Record<NavKey, () => ReactNode> = {
    residents: () => directory('residents'),
    vendors: () => directory('vendors'),
    transactions: () => <Transactions tx={data?.transactions ?? null} apbEnabled={Boolean(data?.apbEnabled)} onLoadOlder={loadOlder} residents={residents?.rows ?? []}
      onOpenResident={openResident} snaps={snaps} onOpenSnap={setViewing} />,
    audit: () => <Audit gapi={gapi} residents={residents?.rows ?? []} transactions={data?.transactions?.rows ?? []}
      onOpenResident={openResident} onOpenSnap={setViewing} />,
    history: () => <History gapi={gapi} onReverted={loadData} />,
    schedules: () => <Schedules gapi={gapi} video={snaps.video} />,
    prefs: () => <SystemSettings phone={gate.phoneNumber} gapi={gapi} prefs={prefs} defaults={session.defaults} list={residents}
      cameras={cameras} user={session.user} emailEnabled={session.emailEnabled} onReload={loadData} onSessionChange={onChange} onJobStarted={jobStarted} />,
    user: () => <UserSettings session={session} onSaved={onChange} />,
    relays: () => <RelaysPage gapi={gapi} prefs={prefs} onReload={loadData} />,
    display: () => <DisplayPage gapi={gapi} onReload={loadData} />,
    holdOpen: () => <HoldOpenPage gapi={gapi} relays={relays} />,
    holidays: () => <HolidaysPage gapi={gapi} holidays={session.holidayList || []} />,
    security: () => <SecurityPage gapi={gapi} floors={features.floors} relays={relays} />,
    facility: () => <FacilityPage gapi={gapi} />,
    elevator: () => <ElevatorPage gapi={gapi} />,
    relayElevator: () => <RelayElevatorPage gapi={gapi} prefs={prefs} />,
    apb: () => <ApbPage gapi={gapi} relayLabels={prefs.relayLabels || {}} relays={relays} />,
  };
  const page = <Fragment key={pageKey}>{pageShown(nav, features.elevators) ? pages[nav]() : directory('residents')}</Fragment>;
  /**
   * The working copy's state under the gate's name (phones: in the top bar), and Reset to gate / Send to gate in the
   * sidebar's gate connection (phones: the Gate sheet); the pages leave them out.
   */
  const workingCopy = workingCopyState(residents ? residents.cache : null);
  const afterReset = async () => { await loadData(); setPageKey((key) => key + 1); };
  const openGateSheet = () => { setGateSheet(true); };
  const boardTabs = useMemo(
    () => BOARD_SETTING_TABS.filter((t) => pageShown(t.key, features.elevators)),
    [features.elevators],
  );

  const hasPortalUnit = Boolean(
    prefs.residentPortal?.enabled
    && residents?.rows?.some((r) => r.portalEnabled && r.portalUsername === session.user),
  ) || Boolean(session.hasPortalUnit);

  const sidebarItems = (
    <SidebarItems gate={gate} user={session.user} page={nav} phone={phone} elevators={features.elevators} job={job}
      progressShown={dock !== 'closed'} gapi={gapi} readOnly={readOnly} isAdmin={isAdmin} workingCopy={workingCopy} hasWorkingCopy={Boolean(residents)} draft={draft} onGo={go}
      onOpenSearch={() => { setMoreHub(false); setQuickJump(true); }}
      onSwitchGate={switchGate} onAllGates={allGates} onPull={pull} onShowProgress={() => setDock('open')} onReset={afterReset}
      onJobStarted={jobStarted} onNotify={setActionInfo} onOpenPortal={hasPortalUnit ? onOpenPortal : undefined} onSignOut={signOut} />
  );

  return (
    <div className="app">
      {dialog}
      {phone && (
        <PhoneTopBar
          gateName={gateLabel(gate)}
          pageTitle={moreHub ? 'More' : isPhoneSubPage ? PAGE_TITLES[nav] : undefined}
          onBack={isPhoneSubPage ? openMoreHub : undefined}
          workingCopy={workingCopy}
          job={job}
          hasCamera={Boolean(cameras)}
          onOpenGate={openGateSheet}
          onShowProgress={() => setDock('open')}
        />
      )}
      {!phone && <aside className="sidebar">{sidebarItems}</aside>}
      <main className="content">
        {phone && !moreHub && isBoardSettingPage(nav) && (
          <Box sx={{ borderBottom: 1, borderColor: 'divider', mx: -2, mb: 2, px: 1 }}>
            <Tabs
              value={nav}
              onChange={(_e, next: NavKey) => go(next)}
              variant="scrollable"
              scrollButtons={false}
              aria-label="Board Settings sections"
            >
              {boardTabs.map((t) => (
                <Tab key={t.key} value={t.key} label={t.label} sx={{ minHeight: 44, textTransform: 'none' }} />
              ))}
            </Tabs>
          </Box>
        )}
        {readOnly && nav !== 'user' && !moreHub && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Read only: you can look at everything, pull from the gate and use the cameras. Ask a gate admin to make changes.
          </Alert>
        )}
        {gate.role === 'editor' && nav !== 'user' && !moreHub && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Editor access: your edits save to the working copy. Ask a gate admin to review and click <strong>Send to gate</strong>.
          </Alert>
        )}
        {[error, loadError].filter(Boolean).map((text) => <Alert key={text} severity="error" sx={{ mb: 2 }}>{text}</Alert>)}
        {actionInfo && (
          <Alert
            severity="info"
            sx={{ mb: 2 }}
            action={
              <IconButton size="small" color="inherit" aria-label="Dismiss" onClick={() => setActionInfo('')}>
                <CloseIcon fontSize="small" />
              </IconButton>
            }
          >
            {actionInfo}
          </Alert>
        )}
        {phone && moreHub ? (
          <PhoneMorePage
            gate={gate}
            user={session.user}
            onGo={go}
            onOpenSearch={() => setQuickJump(true)}
            onAllGates={allGates}
            onOpenPortal={hasPortalUnit ? onOpenPortal : undefined}
            onSignOut={signOut}
          />
        ) : (
          <GateRoleContext.Provider value={gate.role}>
            <ReadOnlyContext.Provider value={readOnly}>
              <WorkingCopySavedContext.Provider value={loadData}>
                <DraftActionsContext.Provider value={setDraft}>
                  {((readOnly && EDIT_PAGES.includes(nav)) || (!isAdmin && ADMIN_ONLY_PAGES.includes(nav)))
                    ? <fieldset disabled className="readonly-page">{page}</fieldset> : page}
                </DraftActionsContext.Provider>
              </WorkingCopySavedContext.Provider>
            </ReadOnlyContext.Provider>
          </GateRoleContext.Provider>
        )}
      </main>
      {phone && (
        <>
          <PhoneTabBar
            page={nav}
            menuOpen={moreHub}
            gateOpen={gateSheet}
            running={running}
            unsavedCount={draft?.unsaved ?? 0}
            onGo={go}
            onOpenGate={openGateSheet}
            onOpenMore={openMoreHub}
          />
          <GateSheet open={gateSheet} onOpenChange={setGateSheet} gapi={gapi} job={job} readOnly={readOnly} isAdmin={isAdmin} workingCopy={workingCopy}
            hasWorkingCopy={Boolean(residents)} draft={draft} onPull={pull} onShowProgress={() => setDock('open')} onLiveRelays={() => go('relays')}
            onReset={afterReset} onJobStarted={jobStarted} onNotify={setActionInfo} />
        </>
      )}
      <QuickJump open={quickJump} onOpenChange={setQuickJump} residents={residents?.rows ?? []}
        transactions={data?.transactions?.rows ?? []} elevators={features.elevators} onGoPage={go}
        onOpenResident={openResident} onOpenTransaction={(tx) => { go('transactions'); if (cameras && tx.camera) setViewing(tx); }} />
      <JobDock job={job} state={dock} onState={setDock} />
      <SnapViewer transaction={viewing} snaps={snaps} onClose={() => setViewing(null)} />
      {cameras && <LiveView phone={gate.phoneNumber} settings={cameras} />}
    </div>
  );
}
