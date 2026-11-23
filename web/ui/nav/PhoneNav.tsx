/**
 * @module web/ui/nav/PhoneNav
 *
 * The phone layout's navigation (GateApp): the top bar, the bottom tab bar, the Gate tab's sheet and the More drawer.
 */
import type { ReactNode } from 'react';
import {
  AppBar, Badge, BottomNavigation, BottomNavigationAction, Box, Button, ButtonBase, Chip, Drawer, Paper, Stack, Toolbar, Typography,
} from '@mui/material';
import FenceIcon from '@mui/icons-material/Fence';
import ListAltIcon from '@mui/icons-material/ListAlt';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PeopleIcon from '@mui/icons-material/People';
import WorkIcon from '@mui/icons-material/Work';
import type { Job } from '../../../src/types.ts';
import type { DraftActions, GateApi } from '../api.ts';
import { JOB_COLORS, jobLabel } from '../JobDock.tsx';
import { useGateActions, type WorkingCopyState } from '../panes/WorkingCopyBar.tsx';

/** The pages with a tab of their own in the bottom bar; More is highlighted for every other page (Relays included). */
export type TabPage = 'residents' | 'vendors' | 'transactions';
export const TAB_PAGES: readonly string[] = ['residents', 'vendors', 'transactions'] satisfies TabPage[];

const WORKING_COPY_COLOR: Record<WorkingCopyState['color'], string> = {
  gray: 'text.secondary',
  red: 'error.main',
  amber: 'warning.main',
  green: 'success.main',
};

interface PhoneTopBarProps {
  gateName: string;
  workingCopy: WorkingCopyState;
  job: Job | null;
  hasCamera: boolean; // leaves room for the camera button
  onOpenGate: () => void;
  onShowProgress: () => void;
}

/**
 * The gate's name with the working copy's state under it (opens the Gate sheet), and the running connection.
 *
 * @param props - Component props.
 * @param props.gateName - Gate name.
 * @param props.workingCopy - Working copy.
 * @param props.job - Job.
 * @param props.hasCamera - Has camera.
 * @param props.onOpenGate - On open gate.
 * @param props.onShowProgress - On show progress.
 * @returns Rendered React element.
 */
export function PhoneTopBar({ gateName, workingCopy, job, hasCamera, onOpenGate, onShowProgress }: PhoneTopBarProps) {
  const statusLabel = jobLabel(job);
  return (
    <AppBar position="sticky" color="default" elevation={0}
      sx={{ borderBottom: 1, borderColor: 'divider', pt: 'env(safe-area-inset-top)' }}>
      <Toolbar variant="dense" sx={{
        gap: 1, minHeight: 52,
        pl: 'calc(env(safe-area-inset-left) + 16px)',
        pr: hasCamera ? 'calc(env(safe-area-inset-right) + 64px)' : 'calc(env(safe-area-inset-right) + 16px)',
      }}>
        <ButtonBase
          type="button"
          onClick={onOpenGate}
          aria-label={`${gateName}, working copy: ${workingCopy.label}. Open the gate connection`}
          sx={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            py: 0.5,
            borderRadius: 1,
          }}
        >
          <Typography variant="subtitle1" noWrap sx={{ fontWeight: 700, width: '100%' }}>{gateName}</Typography>
          <Typography
            variant="caption"
            noWrap
            sx={{
              color: 'text.secondary',
              display: 'flex',
              alignItems: 'center',
              width: '100%',
            }}
          >
            <Box component="span" sx={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', bgcolor: WORKING_COPY_COLOR[workingCopy.color], mr: 0.75, flexShrink: 0 }} />
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{workingCopy.label}</Box>
          </Typography>
        </ButtonBase>
        {statusLabel && (
          <Chip
            size="small"
            clickable
            label={statusLabel}
            color={JOB_COLORS[job!.state]}
            onClick={onShowProgress}
            sx={{ flexShrink: 0 }}
            aria-label={`Gate connection ${statusLabel}: show progress`}
          />
        )}
      </Toolbar>
    </AppBar>
  );
}

interface PhoneTabBarProps {
  page: string; // the open page
  menuOpen: boolean;
  gateOpen: boolean;
  running: boolean;
  unsavedCount: number;
  onGo: (page: TabPage) => void;
  onOpenGate: () => void;
  onOpenMore: () => void;
}

/**
 * Residents, Vendors, Transactions, Gate (the sheet) and More (the drawer, current for every other page).
 *
 * @param props - Component props.
 * @param props.page - Page.
 * @param props.menuOpen - Menu open.
 * @param props.gateOpen - Gate open.
 * @param props.running - Running.
 * @param props.onGo - On go.
 * @param props.onOpenGate - On open gate.
 * @param props.onOpenMore - On open more.
 * @returns Rendered React element.
 */
export function PhoneTabBar({ page, menuOpen, gateOpen, running, unsavedCount, onGo, onOpenGate, onOpenMore }: PhoneTabBarProps) {
  const value = gateOpen ? 'gate' : menuOpen || !TAB_PAGES.includes(page) ? 'more' : page;
  return (
    <Paper
      component="nav"
      aria-label="Main"
      elevation={4}
      sx={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1100, pb: 'env(safe-area-inset-bottom)' }}
    >
      <BottomNavigation
        showLabels
        value={value}
        onChange={(_event, next: string) => {
          if (next === 'residents' || next === 'vendors' || next === 'transactions') onGo(next);
          else if (next === 'gate') onOpenGate();
          else if (next === 'more') onOpenMore();
        }}
      >
        <BottomNavigationAction value="residents" label="Residents" icon={<PeopleIcon />} sx={{ minWidth: 0, px: 0.5 }} />
        <BottomNavigationAction value="vendors" label="Vendors" icon={<WorkIcon />} sx={{ minWidth: 0, px: 0.5 }} />
        <BottomNavigationAction value="transactions" label="Transactions" icon={<ListAltIcon />} sx={{ minWidth: 0, px: 0.5 }} />
        <BottomNavigationAction
          value="gate"
          label="Gate"
          aria-label={running ? 'Gate (connection running)' : unsavedCount ? `Gate (${unsavedCount} unsaved)` : 'Gate'}
          icon={
            unsavedCount > 0 ? (
              <Badge badgeContent={unsavedCount} color="success"><FenceIcon /></Badge>
            ) : (
              <Badge variant="dot" color="primary" invisible={!running}><FenceIcon /></Badge>
            )
          }
          sx={{ minWidth: 0, px: 0.5 }}
        />
        <BottomNavigationAction value="more" label="More" icon={<MoreHorizIcon />} sx={{ minWidth: 0, px: 0.5 }} />
      </BottomNavigation>
    </Paper>
  );
}

interface GateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gapi: GateApi;
  job: Job | null;
  readOnly: boolean;
  isAdmin: boolean;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  draft: DraftActions | null;
  onPull: (what: 'residents' | 'transactions') => void;
  onShowProgress: () => void;
  onLiveRelays: () => void;
  onReset: () => Promise<void>; // reloads after Reset to gate
  onJobStarted: () => void;
  onNotify: (text: string) => void; // the outcome of Send / Reset, shown on the page
}

/**
 * The Gate tab: the working copy's state, Send to gate and Reset to gate (admins), the pulls, progress and live relays.
 * Its buttons close the sheet first, so their confirmations show on their own.
 *
 * @param props - Component props.
 * @param props.open - Whether the layer/dialog is open.
 * @param props.onOpenChange - On open change.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.job - Job.
 * @param props.readOnly - Read only.
 * @param props.workingCopy - Working copy.
 * @param props.hasWorkingCopy - Has working copy.
 * @param props.onPull - On pull.
 * @param props.onShowProgress - On show progress.
 * @param props.onLiveRelays - On live relays.
 * @param props.onReset - On reset.
 * @param props.onJobStarted - On job started.
 * @param props.onNotify - On notify.
 * @returns Rendered React element.
 */
export function GateSheet({ open, onOpenChange, gapi, job, readOnly, isAdmin, workingCopy, hasWorkingCopy, draft, onPull, onShowProgress, onLiveRelays, onReset,
  onJobStarted, onNotify }: GateSheetProps) {
  const running = job?.state === 'running';
  const actions = useGateActions({ gapi, workingCopy, hasWorkingCopy, running, onReset, onJobStarted, onNotify });
  const closeThen = (action: () => void) => () => { onOpenChange(false); onNotify(''); action(); };
  return (
    <>
      {actions.dialog}
      <Drawer
        anchor="bottom"
        open={open}
        onClose={() => onOpenChange(false)}
        slotProps={{
          paper: {
            sx: {
              maxHeight: '85dvh',
              overflowY: 'auto',
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              pb: 'env(safe-area-inset-bottom)',
            },
          },
        }}
      >
        <Stack spacing={1.5} sx={{ p: 2.5 }}>
          <Typography variant="h6" component="h2">Gate connection</Typography>
          <Typography variant="body2" color="text.secondary">
            {running ? `${jobLabel(job)}. You can keep working; the data reloads when it finishes.` : 'Get the latest data from the gate.'}
          </Typography>
          <Typography variant="body2" sx={{ color: WORKING_COPY_COLOR[workingCopy.color], display: 'flex', alignItems: 'center' }}>
            <Box component="span" sx={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', bgcolor: 'currentColor', mr: 0.75, flexShrink: 0 }} />
            Working copy: {workingCopy.label}
          </Typography>
          {!readOnly && draft && (
            <>
              <Button
                variant="contained"
                color="success"
                size="large"
                fullWidth
                disabled={!draft.unsaved || Boolean(draft.blocked)}
                onClick={closeThen(() => { void draft.save(); })}
              >
                Save to working copy{draft.unsaved ? ` (${draft.unsaved})` : ''}
              </Button>
              <Button
                variant="contained"
                color="error"
                size="large"
                fullWidth
                disabled={!draft.unsaved}
                onClick={closeThen(draft.discard)}
              >
                Discard unsaved
              </Button>
            </>
          )}
          {!readOnly && (
            <>
              <Button variant="contained" size="large" fullWidth disabled={!isAdmin || !actions.canSend} onClick={closeThen(actions.send)}>
                Send to gate
              </Button>
              {!isAdmin && <Typography variant="body2" color="text.secondary">Ask a gate admin to Send to gate.</Typography>}
              {workingCopy.conflicts.length > 0 && (
                <Typography variant="body2" color="error">Decide the conflicts on the Residents page first.</Typography>
              )}
              <Button variant="outlined" color="error" size="large" fullWidth disabled={!actions.canReset} onClick={closeThen(actions.reset)}>
                Reset to gate
              </Button>
            </>
          )}
          <Button variant="outlined" size="large" fullWidth disabled={running} onClick={() => onPull('residents')}>Pull residents</Button>
          <Button variant="outlined" size="large" fullWidth disabled={running} onClick={() => onPull('transactions')}>Pull transactions</Button>
          {job && job.log.length > 0 && (
            <Button variant="outlined" color="inherit" size="large" fullWidth onClick={closeThen(onShowProgress)}>Show progress</Button>
          )}
          <Button variant="outlined" color="inherit" size="large" fullWidth onClick={onLiveRelays}>Live relays</Button>
          <Button variant="text" color="inherit" size="large" fullWidth onClick={() => onOpenChange(false)}>Close</Button>
        </Stack>
      </Drawer>
    </>
  );
}

interface PhoneMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * The More drawer: the sidebar's items in a drawer at the left edge.
 *
 * @param props - Component props.
 * @param props.open - Whether the layer/dialog is open.
 * @param props.onOpenChange - On open change.
 * @param props.children - Children.
 * @returns Rendered React element.
 */
export function PhoneMenu({ open, onOpenChange, children }: PhoneMenuProps) {
  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={() => onOpenChange(false)}
      slotProps={{ paper: { sx: { width: 'min(280px, 85vw)', display: 'flex', flexDirection: 'column' } } }}
    >
      <Box component="nav" aria-label="Menu" sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {children}
      </Box>
    </Drawer>
  );
}
