/**
 * @module web/ui/nav/PhoneNav
 *
 * Mobile/PWA navigation matching the native Android Material 3 app 1:1:
 * - PhoneTopBar: 64px borderless TopAppBar (`var(--md-surface)`), 22px title + 12px subtitle, optional Back + right action.
 * - PhoneTabBar: 80px Material 3 NavigationBar (`var(--md-surface-container)`), 64x32 secondaryContainer active pill,
 *   filled active icons + outlined inactive icons.
 * - GateSheet: Material 3 slide-up sheet with job status pill to the left of the working-copy pill.
 */
import type { ReactNode } from 'react';
import {
  AppBar,
  Badge,
  BottomNavigation,
  BottomNavigationAction,
  Box,
  Button,
  ButtonBase,
  Chip,
  Divider,
  Drawer,
  IconButton,
  Paper,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import FenceIcon from '@mui/icons-material/Fence';
import FenceOutlinedIcon from '@mui/icons-material/FenceOutlined';
import ListAltIcon from '@mui/icons-material/ListAlt';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PeopleIcon from '@mui/icons-material/People';
import PeopleOutlinedIcon from '@mui/icons-material/PeopleOutlined';
import RestoreOutlinedIcon from '@mui/icons-material/RestoreOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import UploadOutlinedIcon from '@mui/icons-material/UploadOutlined';
import WorkIcon from '@mui/icons-material/Work';
import WorkOutlinedIcon from '@mui/icons-material/WorkOutlined';
import type { Job } from '../types.ts';
import type { DraftActions, GateApi } from '../api.ts';
import { JOB_COLORS, jobLabel } from '../JobDock.tsx';
import { useGateActions, type WorkingCopyState } from '../panes/WorkingCopyBar.tsx';

/** The pages with a tab of their own in the bottom bar; More is highlighted for every other page. */
export type TabPage = 'residents' | 'vendors' | 'transactions';
export const TAB_PAGES: readonly string[] = ['residents', 'vendors', 'transactions'] satisfies TabPage[];

const WORKING_COPY_CHIP_COLOR: Record<WorkingCopyState['color'], 'default' | 'error' | 'warning' | 'success'> = {
  gray: 'default',
  red: 'error',
  amber: 'warning',
  green: 'success',
};

interface PhoneTopBarProps {
  gateName: string;
  pageTitle?: string;
  onBack?: () => void;
  workingCopy: WorkingCopyState;
  running: boolean;
  rightAction?: ReactNode;
  onOpenGate: () => void;
}

/**
 * Borderless 64px Material 3 TopAppBar matching Android `StaffGateShell`:
 * - Surface background (`var(--md-surface)`), zero bottom border.
 * - 22px title + 12px muted subtitle (`Matches gate` / `Unsent working-copy changes` / `Connection running…`).
 * - Optional Back arrow on More sub-pages and right-aligned action icon (Download CSV/Cameras, or Live Camera on More).
 */
export function PhoneTopBar({
  gateName,
  pageTitle,
  onBack,
  workingCopy,
  running,
  rightAction,
  onOpenGate,
}: PhoneTopBarProps) {
  const title = pageTitle || gateName;
  const subtitle = pageTitle
    ? gateName
    : running
      ? 'Connection running…'
      : workingCopy.label;

  return (
    <AppBar
      position="sticky"
      color="default"
      elevation={0}
      sx={{
        bgcolor: 'var(--md-surface)',
        color: 'text.primary',
        borderBottom: 'none',
        pt: 'env(safe-area-inset-top)',
      }}
    >
      <Toolbar
        sx={{
          gap: 0.5,
          minHeight: '64px !important',
          pl: onBack ? 'calc(env(safe-area-inset-left) + 4px)' : 'calc(env(safe-area-inset-left) + 16px)',
          pr: rightAction ? 'calc(env(safe-area-inset-right) + 4px)' : 'calc(env(safe-area-inset-right) + 16px)',
        }}
      >
        {onBack && (
          <IconButton edge="start" aria-label="Back to More" onClick={onBack} sx={{ color: 'text.primary', mr: 0.5 }}>
            <ArrowBackIcon />
          </IconButton>
        )}
        <ButtonBase
          type="button"
          onClick={onOpenGate}
          aria-label={`${title}, ${subtitle}. Open gate connection`}
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
          <Typography
            noWrap
            sx={{
              fontSize: '1.375rem',
              lineHeight: 1.25,
              fontWeight: 500,
              letterSpacing: 0,
              width: '100%',
            }}
          >
            {title}
          </Typography>
          <Typography
            noWrap
            sx={{
              fontSize: '0.75rem',
              lineHeight: 1.33,
              fontWeight: 500,
              color: 'text.secondary',
              width: '100%',
            }}
          >
            {subtitle}
          </Typography>
        </ButtonBase>
        {rightAction && (
          <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {rightAction}
          </Box>
        )}
      </Toolbar>
    </AppBar>
  );
}

interface PhoneTabBarProps {
  page: string;
  menuOpen: boolean;
  gateOpen: boolean;
  running: boolean;
  unsavedCount: number;
  onGo: (page: TabPage) => void;
  onOpenGate: () => void;
  onOpenMore: () => void;
}

/**
 * Pixel-matched Material 3 80px bottom NavigationBar (`var(--md-surface-container)`):
 * - 64x32px active pill in `var(--md-secondary-container)` / `var(--md-on-secondary-container)`.
 * - Filled icons when selected, outlined icons when unselected.
 */
export function PhoneTabBar({ page, menuOpen, gateOpen, running, unsavedCount, onGo, onOpenGate, onOpenMore }: PhoneTabBarProps) {
  const value = gateOpen ? 'gate' : menuOpen || !TAB_PAGES.includes(page) ? 'more' : page;
  const pill = (active: boolean, icon: ReactNode) => (
    <Box
      component="span"
      sx={{
        width: 64,
        height: 32,
        borderRadius: '999px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: active ? 'var(--md-secondary-container)' : 'transparent',
        color: active ? 'var(--md-on-secondary-container)' : 'text.secondary',
        transition: 'background-color 150ms ease, color 150ms ease',
        '& .MuiSvgIcon-root': { fontSize: 24 },
      }}
    >
      {icon}
    </Box>
  );

  return (
    <Paper
      component="nav"
      aria-label="Main"
      elevation={0}
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1100,
        bgcolor: 'var(--md-surface-container)',
        borderTop: 'none',
        pb: 'env(safe-area-inset-bottom)',
      }}
    >
      <BottomNavigation
        showLabels
        value={value}
        onChange={(_event, next: string) => {
          if (next === 'residents' || next === 'vendors' || next === 'transactions') onGo(next);
          else if (next === 'gate') onOpenGate();
          else if (next === 'more') onOpenMore();
        }}
        sx={{
          height: 80,
          bgcolor: 'transparent',
          '& .MuiBottomNavigationAction-root': {
            minWidth: 0,
            px: 0.5,
            pt: '12px',
            pb: '16px',
            gap: '4px',
            color: 'text.secondary',
            '& .MuiBottomNavigationAction-label': {
              fontSize: '0.75rem',
              lineHeight: '16px',
              fontWeight: 500,
              mt: '4px',
            },
            '&.Mui-selected': {
              color: 'text.primary',
              '& .MuiBottomNavigationAction-label': {
                fontSize: '0.75rem',
                fontWeight: 600,
              },
            },
          },
        }}
      >
        <BottomNavigationAction
          value="residents"
          label="Residents"
          icon={pill(value === 'residents', value === 'residents' ? <PeopleIcon /> : <PeopleOutlinedIcon />)}
        />
        <BottomNavigationAction
          value="vendors"
          label="Vendors"
          icon={pill(value === 'vendors', value === 'vendors' ? <WorkIcon /> : <WorkOutlinedIcon />)}
        />
        <BottomNavigationAction
          value="transactions"
          label="Activity"
          icon={pill(value === 'transactions', value === 'transactions' ? <ListAltIcon /> : <ListAltOutlinedIcon />)}
        />
        <BottomNavigationAction
          value="gate"
          label="Gate"
          aria-label={running ? 'Gate (connection running)' : unsavedCount ? `Gate (${unsavedCount} unsaved)` : 'Gate'}
          icon={pill(
            value === 'gate',
            unsavedCount > 0 ? (
              <Badge badgeContent={unsavedCount} color="success">
                {value === 'gate' ? <FenceIcon /> : <FenceOutlinedIcon />}
              </Badge>
            ) : (
              <Badge variant="dot" color="primary" invisible={!running}>
                {value === 'gate' ? <FenceIcon /> : <FenceOutlinedIcon />}
              </Badge>
            ),
          )}
        />
        <BottomNavigationAction
          value="more"
          label="More"
          icon={pill(value === 'more', <MoreHorizIcon />)}
        />
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
  onReset: () => Promise<void>;
  onJobStarted: () => void;
  onNotify: (text: string) => void;
}

/**
 * The Gate tab slide-up sheet matching Android's `GateControlSheetContent`:
 * - Top header shows "Gate connection" on the left, and the job status pill to the left of the working-copy pill.
 */
export function GateSheet({
  open,
  onOpenChange,
  gapi,
  job,
  readOnly,
  isAdmin,
  workingCopy,
  hasWorkingCopy,
  draft,
  onPull,
  onShowProgress,
  onLiveRelays,
  onReset,
  onJobStarted,
  onNotify,
}: GateSheetProps) {
  const running = job?.state === 'running';
  const statusLabel = jobLabel(job);
  const actions = useGateActions({ gapi, workingCopy, hasWorkingCopy, running, onReset, onJobStarted, onNotify });
  const closeThen = (action: () => void) => () => { onOpenChange(false); onNotify(''); action(); };

  const tonalBtnSx = {
    bgcolor: 'var(--md-secondary-container)',
    color: 'var(--md-on-secondary-container)',
    boxShadow: 'none',
    '&:hover': {
      bgcolor: 'var(--md-primary-container)',
      color: 'var(--md-on-primary-container)',
      boxShadow: 'none',
    },
  };

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
              maxHeight: '88dvh',
              overflowY: 'auto',
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              bgcolor: 'var(--md-surface-low)',
              pb: 'env(safe-area-inset-bottom)',
            },
          },
        }}
      >
        <Box sx={{ width: 32, height: 4, borderRadius: 2, bgcolor: 'text.disabled', mx: 'auto', mt: 1.5, mb: 0.5, opacity: 0.4 }} />
        <Stack spacing={1.25} sx={{ px: 2.5, py: 1.5 }}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>Gate connection</Typography>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              {statusLabel && job && (
                <Chip
                  size="small"
                  clickable
                  label={statusLabel}
                  color={JOB_COLORS[job.state]}
                  onClick={closeThen(onShowProgress)}
                />
              )}
              <Chip
                size="small"
                label={workingCopy.label}
                color={WORKING_COPY_CHIP_COLOR[workingCopy.color]}
              />
            </Stack>
          </Stack>

          {running && (
            <Typography variant="body2" color="text.secondary">
              Connection running ({job?.what || 'gate'}). Data reloads automatically when finished.
            </Typography>
          )}

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
              <Divider />
            </>
          )}

          {!readOnly && (
            <>
              <Button
                variant="contained"
                size="large"
                fullWidth
                startIcon={<UploadOutlinedIcon />}
                disabled={!isAdmin || !actions.canSend}
                onClick={closeThen(actions.send)}
              >
                Send to gate
              </Button>
              {!isAdmin && <Typography variant="body2" color="text.secondary">Ask a gate admin to review and Send to gate.</Typography>}
              {workingCopy.conflicts.length > 0 && (
                <Typography variant="body2" color="error">Decide the conflicts on the Residents page first.</Typography>
              )}
              <Button
                variant="contained"
                size="large"
                fullWidth
                startIcon={<RestoreOutlinedIcon />}
                disabled={!actions.canReset}
                onClick={closeThen(actions.reset)}
                sx={{
                  bgcolor: 'var(--md-error-container)',
                  color: 'var(--md-on-error-container)',
                  boxShadow: 'none',
                  '&:hover': { bgcolor: 'var(--md-error-container)', filter: 'brightness(0.95)', boxShadow: 'none' },
                }}
              >
                Reset to gate
              </Button>
              <Divider />
            </>
          )}

          <Button
            variant="contained"
            size="large"
            fullWidth
            startIcon={<PeopleIcon />}
            disabled={running}
            onClick={() => onPull('residents')}
            sx={tonalBtnSx}
          >
            Pull residents
          </Button>
          <Button
            variant="contained"
            size="large"
            fullWidth
            startIcon={<ListAltIcon />}
            disabled={running}
            onClick={() => onPull('transactions')}
            sx={tonalBtnSx}
          >
            Pull transactions
          </Button>
          {job && job.log.length > 0 && (
            <Button
              variant="text"
              color="inherit"
              size="large"
              fullWidth
              startIcon={<TerminalOutlinedIcon />}
              onClick={closeThen(onShowProgress)}
            >
              Show progress
            </Button>
          )}
          <Button
            variant="contained"
            size="large"
            fullWidth
            startIcon={<LockOpenOutlinedIcon />}
            onClick={closeThen(onLiveRelays)}
            sx={tonalBtnSx}
          >
            Live relays
          </Button>
          <Button variant="text" color="inherit" size="medium" fullWidth onClick={() => onOpenChange(false)}>
            Close
          </Button>
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
