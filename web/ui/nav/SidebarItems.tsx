import { Box, Button, Chip, Divider, List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SearchIcon from '@mui/icons-material/Search';
import type { GateInfo, Job } from '../../../src/types.ts';
import type { DraftActions, GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { roleLabel } from '../Gates.tsx';
import { JOB_COLORS, jobLabel } from '../JobDock.tsx';
import { useGateActions, type WorkingCopyState } from '../panes/WorkingCopyBar.tsx';
import { GateSwitcher } from './GateSwitcher.tsx';
import { NAV, pageShown, PINNED_NAV, type NavKey } from './pages.ts';
import { TAB_PAGES } from './PhoneNav.tsx';

const WORKING_COPY_COLOR: Record<WorkingCopyState['color'], string> = {
  gray: 'text.secondary',
  red: 'error.main',
  amber: 'warning.main',
  green: 'success.main',
};

interface SidebarItemsProps {
  gate: GateInfo;
  user: string;
  page: NavKey; // the open page
  phone: boolean; // the phone's More menu: leaves out what the tab bar and Gate sheet have
  elevators: boolean; // the gate's Elevators feature (shows the elevator pages)
  job: Job | null;
  progressShown: boolean; // the progress window is open or minimized
  gapi: GateApi;
  readOnly: boolean;
  isAdmin: boolean;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  draft: DraftActions | null;
  onGo: (page: NavKey) => void;
  onOpenSearch: () => void;
  onSwitchGate: (to: GateInfo) => void;
  onAllGates: () => void;
  onPull: (what: 'residents' | 'transactions') => void;
  onShowProgress: () => void;
  onReset: () => Promise<void>; // reloads after Reset to gate
  onJobStarted: () => void;
  onNotify: (text: string) => void; // the outcome of Send / Reset, shown on the page
  onOpenPortal?: () => void;
  onSignOut: () => void;
}

interface NavButtonProps {
  label: string;
  current: boolean;
  onClick: () => void;
}

/**
 * One page in the menu; the open one is highlighted.
 *
 * @param props - Component props.
 * @param props.label - Display label.
 * @param props.current - Current password or state.
 * @param props.onClick - On click.
 * @returns Rendered React element.
 */
function NavButton({ label, current, onClick }: NavButtonProps) {
  return (
    <ListItemButton
      selected={current}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      sx={{ borderRadius: 1.5, py: 0.5, px: 1.25 }}
    >
      <ListItemText
        primary={label}
        slotProps={{ primary: { variant: 'body2', sx: { fontWeight: current ? 600 : 400 } } }}
      />
    </ListItemButton>
  );
}

interface GateConnectionProps {
  job: Job | null;
  progressShown: boolean;
  gapi: GateApi;
  readOnly: boolean;
  isAdmin: boolean;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  draft: DraftActions | null;
  onPull: (what: 'residents' | 'transactions') => void;
  onShowProgress: () => void;
  onReset: () => Promise<void>;
  onJobStarted: () => void;
  onNotify: (text: string) => void;
}

/**
 * The desktop sidebar's gate connection: only shows actions that are currently clickable (save/discard unsaved edits,
 * Send to gate / Reset to gate when available, pulls when idle), plus the running or last connection status.
 */
function GateConnection({ job, progressShown, gapi, readOnly, isAdmin, workingCopy, hasWorkingCopy, draft, onPull, onShowProgress, onReset, onJobStarted,
  onNotify }: GateConnectionProps) {
  const running = job?.state === 'running';
  const actions = useGateActions({ gapi, workingCopy, hasWorkingCopy, running, onReset, onJobStarted, onNotify });
  const statusLabel = jobLabel(job);
  const showSave = !readOnly && Boolean(draft && draft.unsaved > 0 && !draft.blocked);
  const showDiscard = !readOnly && Boolean(draft && draft.unsaved > 0);
  const showSend = !readOnly && isAdmin && actions.canSend;
  const showReset = !readOnly && actions.canReset;
  const showPulls = !running;
  const showProgress = !progressShown && Boolean(job && job.log.length > 0);
  return (
    <Stack spacing={0.75} sx={{ mt: 0.5 }}>
      {actions.dialog}
      <Divider />
      <Typography variant="overline" color="text.secondary" sx={{ px: 0.5, lineHeight: 1.4, fontWeight: 700 }}>
        Gate connection
      </Typography>
      {showSave && draft && (
        <Button
          fullWidth
          size="small"
          variant="contained"
          color="success"
          onClick={() => { void draft.save(); }}
        >
          Save to working copy ({draft.unsaved})
        </Button>
      )}
      {showDiscard && draft && (
        <Button
          fullWidth
          size="small"
          variant="contained"
          color="error"
          onClick={() => draft.discard()}
        >
          Discard unsaved
        </Button>
      )}
      {showSend && (
        <Button
          fullWidth
          size="small"
          variant="contained"
          onClick={() => { onNotify(''); actions.send(); }}
        >
          Send to gate
        </Button>
      )}
      {showReset && (
        <Button
          fullWidth
          size="small"
          variant="outlined"
          color="error"
          onClick={() => { onNotify(''); actions.reset(); }}
        >
          Reset to gate
        </Button>
      )}
      {showPulls && (
        <>
          <Button fullWidth size="small" variant="outlined" onClick={() => onPull('residents')}>
            Pull residents
          </Button>
          <Button fullWidth size="small" variant="outlined" onClick={() => onPull('transactions')}>
            Pull transactions
          </Button>
        </>
      )}
      {(statusLabel || showProgress) && (
        <Stack spacing={0.5} sx={{ alignItems: 'stretch' }}>
          {statusLabel && <Chip size="small" label={statusLabel} color={JOB_COLORS[job!.state]} sx={{ width: '100%' }} />}
          {showProgress && (
            <Button variant="text" size="small" onClick={onShowProgress}>Show progress</Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * The sidebar's contents (GateApp puts them in the desktop sidebar or the phone's More menu): the gate switcher, the
 * pages, the pinned pages and Help, the gate connection (desktop) and the user's settings and Sign out.
 *
 * @param props - Component props.
 * @param props.gate - Currently open gate summary (`GateInfo`).
 * @param props.user - Local account username (or actor name for audit logs).
 * @param props.page - Page.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.elevators - Elevators.
 * @param props.job - Job.
 * @param props.progressShown - Progress shown.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.readOnly - Read only.
 * @param props.workingCopy - Working copy.
 * @param props.hasWorkingCopy - Has working copy.
 * @param props.onGo - On go.
 * @param props.onSwitchGate - On switch gate.
 * @param props.onAllGates - On all gates.
 * @param props.onPull - On pull.
 * @param props.onShowProgress - On show progress.
 * @param props.onReset - On reset.
 * @param props.onJobStarted - On job started.
 * @param props.onNotify - On notify.
 * @param props.onSignOut - On sign out.
 * @returns Rendered React element.
 */
export function SidebarItems({ gate, user, page, phone, elevators, job, progressShown, gapi, readOnly, isAdmin, workingCopy, hasWorkingCopy, draft, onGo,
  onOpenSearch, onSwitchGate, onAllGates, onPull, onShowProgress, onReset, onJobStarted, onNotify, onOpenPortal, onSignOut }: SidebarItemsProps) {
  const listed = (key: NavKey) => pageShown(key, elevators)
    && !(phone && (TAB_PAGES.includes(key) || key === 'relays'));
  return (
    <>
      <Box className="sidebar-nav" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        <GateSwitcher gate={gate} onSwitch={onSwitchGate} onAllGates={onAllGates} />
        {!phone && (
          <Box sx={{ display: 'flex', alignItems: 'center', px: 1 }}>
            <Typography variant="caption" sx={{ color: WORKING_COPY_COLOR[workingCopy.color], display: 'flex', alignItems: 'center' }}>
              <Box component="span" sx={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', bgcolor: 'currentColor', mr: 0.75, flexShrink: 0 }} />
              {workingCopy.label}
            </Typography>
            <HelpTip of="workingCopy" />
          </Box>
        )}
        <Button
          fullWidth
          size="small"
          variant="outlined"
          color="inherit"
          startIcon={<SearchIcon fontSize="small" />}
          onClick={onOpenSearch}
          title="Quick search across residents, cards, entry codes, transactions and pages"
          sx={{ justifyContent: 'flex-start', borderColor: 'divider', color: 'text.secondary' }}
        >
          Search…
          {!phone && (
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
              Ctrl+K
            </Typography>
          )}
        </Button>
        {onOpenPortal && (
          <Button
            fullWidth
            size="small"
            variant="outlined"
            color="success"
            endIcon={<OpenInNewIcon fontSize="small" />}
            onClick={onOpenPortal}
            title="Switch to the Resident Portal view for your unit"
            sx={{ justifyContent: 'space-between' }}
          >
            Resident Portal
          </Button>
        )}
        <List dense disablePadding>
          {NAV.map((item) => ('section' in item
            ? (
              <Typography
                key={item.section}
                variant="overline"
                color="text.secondary"
                sx={{ px: 1.25, pt: 1.25, pb: 0.25, display: 'block', lineHeight: 1.4, fontWeight: 700 }}
              >
                {item.section}
              </Typography>
            )
            : listed(item.key) && <NavButton key={item.key} label={item.label} current={page === item.key} onClick={() => onGo(item.key)} />))}
        </List>
      </Box>
      <Box className="sidebar-bottom" sx={{ p: 1.5, pt: 0.75, display: 'flex', flexDirection: 'column', gap: 0.75, borderTop: 1, borderColor: 'divider' }}>
        <List dense disablePadding>
          {PINNED_NAV.map((item) => <NavButton key={item.key} label={item.label} current={page === item.key} onClick={() => onGo(item.key)} />)}
          <ListItemButton
            component="a"
            href="/help"
            target="_blank"
            rel="noopener"
            title="Open the user guide in a new tab"
            sx={{ borderRadius: 1.5, py: 0.5, px: 1.25 }}
          >
            <ListItemText primary="Help ↗" slotProps={{ primary: { variant: 'body2' } }} />
          </ListItemButton>
        </List>
        {!phone && (
          <GateConnection
            job={job}
            progressShown={progressShown}
            gapi={gapi}
            readOnly={readOnly}
            isAdmin={isAdmin}
            workingCopy={workingCopy}
            hasWorkingCopy={hasWorkingCopy}
            draft={draft}
            onPull={onPull}
            onShowProgress={onShowProgress}
            onReset={onReset}
            onJobStarted={onJobStarted}
            onNotify={onNotify}
          />
        )}
        <Divider />
        <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
          {user} · {roleLabel(gate.role)}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant={page === 'user' ? 'contained' : 'outlined'}
            color={page === 'user' ? 'primary' : 'inherit'}
            onClick={() => onGo('user')}
          >
            User settings
          </Button>
          <Button size="small" variant="outlined" color="inherit" onClick={onSignOut}>Sign out</Button>
        </Stack>
      </Box>
    </>
  );
}
