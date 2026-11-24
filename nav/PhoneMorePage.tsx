/**
 * @module web/ui/nav/PhoneMorePage
 *
 * Mobile/PWA "More" hub screen adopting the native Android app's clean grouped navigation:
 * Management & Monitoring (Insights, History, Schedules, Board Settings, System Settings) and
 * Gate & Account (Live Relays, Quick Jump, Switch Gate, Resident Portal, User Settings, Sign out).
 */
import type { ReactNode } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import AnalyticsOutlinedIcon from '@mui/icons-material/AnalyticsOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FenceOutlinedIcon from '@mui/icons-material/FenceOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import PersonOutlinedIcon from '@mui/icons-material/PersonOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import type { GateInfo } from '../types.ts';
import type { NavKey } from './pages.ts';

interface PhoneMorePageProps {
  gate: GateInfo;
  user: string;
  onGo: (page: NavKey) => void;
  onOpenSearch: () => void;
  onAllGates: () => void;
  onOpenPortal?: () => void;
  onSignOut: () => void;
}

interface MoreItemProps {
  title: string;
  subtitle: string;
  icon: ReactNode;
  onClick: () => void;
}

function MoreRow({ title, subtitle, icon, onClick }: MoreItemProps) {
  return (
    <ListItemButton onClick={onClick} sx={{ py: 1.25, px: 2 }}>
      <ListItemIcon sx={{ minWidth: 40, color: 'primary.main' }}>{icon}</ListItemIcon>
      <ListItemText
        primary={title}
        secondary={subtitle}
        slotProps={{
          primary: { variant: 'subtitle2', sx: { fontWeight: 600 } },
          secondary: { variant: 'caption', color: 'text.secondary' },
        }}
      />
      <ChevronRightIcon fontSize="small" sx={{ color: 'text.secondary', ml: 1 }} />
    </ListItemButton>
  );
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  editor: 'Editor',
  readonly: 'Read only',
  resident: 'Resident',
};

/**
 * Full-page mobile/PWA "More" hub matching the Android app's borderless tonal navigation cards.
 */
export function PhoneMorePage({
  gate,
  user,
  onGo,
  onOpenSearch,
  onAllGates,
  onOpenPortal,
  onSignOut,
}: PhoneMorePageProps) {
  const roleLabel = ROLE_LABELS[gate.role] || gate.role;

  return (
    <Stack spacing={2} sx={{ pb: 2 }}>
      <Card elevation={0} sx={{ border: 'none' }}>
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.25 }}>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>
              Management &amp; Monitoring
            </Typography>
            {roleLabel && <Chip size="small" color="primary" label={roleLabel} />}
          </Stack>
          <Box sx={{ bgcolor: 'background.default', borderRadius: 2, overflow: 'hidden' }}>
            <List disablePadding>
              <MoreRow
                title="Access Insights"
                subtitle="Dormant credentials, unknown cards & traffic"
                icon={<AnalyticsOutlinedIcon />}
                onClick={() => onGo('audit')}
              />
              <Divider component="li" />
              <MoreRow
                title="History & Pull Archive"
                subtitle="Events, Revert, point-in-time restore"
                icon={<HistoryOutlinedIcon />}
                onClick={() => onGo('history')}
              />
              <Divider component="li" />
              <MoreRow
                title="Scheduled Transfers"
                subtitle="Automatic pulls, clips & sends"
                icon={<ScheduleOutlinedIcon />}
                onClick={() => onGo('schedules')}
              />
              <Divider component="li" />
              <MoreRow
                title="Board Settings"
                subtitle="Facility codes, Holidays, Security, Hold open, Display, APB"
                icon={<TuneOutlinedIcon />}
                onClick={() => onGo('facility')}
              />
              <Divider component="li" />
              <MoreRow
                title="System Settings"
                subtitle="DKS login, Users, Portal, Cameras, API keys, Webhooks"
                icon={<SettingsOutlinedIcon />}
                onClick={() => onGo('prefs')}
              />
            </List>
          </Box>
        </CardContent>
      </Card>

      <Card elevation={0} sx={{ border: 'none' }}>
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 700, mb: 1.25 }}>
            Gate &amp; Account
          </Typography>
          <Box sx={{ bgcolor: 'background.default', borderRadius: 2, overflow: 'hidden', mb: 1.5 }}>
            <List disablePadding>
              <MoreRow
                title="Live Relays"
                subtitle="Hold open, timed release & relay settings"
                icon={<LockOpenOutlinedIcon />}
                onClick={() => onGo('relays')}
              />
              <Divider component="li" />
              <MoreRow
                title="Quick Jump Search"
                subtitle="Find residents, codes, cards, or pages"
                icon={<SearchOutlinedIcon />}
                onClick={onOpenSearch}
              />
              <Divider component="li" />
              <MoreRow
                title="Switch Gate"
                subtitle="Return to all gates"
                icon={<SwapHorizOutlinedIcon />}
                onClick={onAllGates}
              />
              {onOpenPortal && (
                <>
                  <Divider component="li" />
                  <MoreRow
                    title="Resident Portal"
                    subtitle="Switch to your unit's resident view"
                    icon={<FenceOutlinedIcon />}
                    onClick={onOpenPortal}
                  />
                </>
              )}
              <Divider component="li" />
              <MoreRow
                title="User Settings"
                subtitle={user}
                icon={<PersonOutlinedIcon />}
                onClick={() => onGo('user')}
              />
            </List>
          </Box>
          <Button
            variant="outlined"
            color="inherit"
            fullWidth
            startIcon={<LogoutOutlinedIcon />}
            onClick={onSignOut}
          >
            Sign out
          </Button>
        </CardContent>
      </Card>
    </Stack>
  );
}
