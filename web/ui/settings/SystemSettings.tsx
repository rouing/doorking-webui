import { useState, type ReactNode } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Button,
  Card,
  CardContent,
  Link,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { CameraSettings, GateConfig as Config, GatePrefs, ResidentsReply } from '../../../src/types.ts';
import { errorText, gateUrl, useIsAdmin, useReadOnly, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { CameraForm } from './CameraForm.tsx';
import { GateConfig } from './GateConfig.tsx';
import { GateSettingsEditor } from './GateSettingsEditor.tsx';
import { DeviceAssociation } from './LocalPrefs.tsx';
import { useGateSettings } from './useGateSettings.ts';
import { AddGateUserCard, ApiKeysCard, GateLoginCard, GateUsersCard } from './GateAccess.tsx';
import { LoginAuditCard, ResidentPortalSettingsCard } from './PortalAdminCards.tsx';
import { WebhooksCard } from './Webhooks.tsx';

interface DeleteGateDataProps {
  phone: string;
  gapi: GateApi;
  onDeleted: () => void;
}

/**
 * Deletes everything this app stores about the gate (database rows for every user and the gate's folder), after a
 * warning. Nothing on the gate changes. Afterwards the gate is gone from every list, so the page returns to the list.
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onDeleted - On deleted.
 * @returns Rendered React element.
 */
function DeleteGateData({ phone, gapi, onDeleted }: DeleteGateDataProps) {
  const [dialog, confirm] = useConfirm();
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const remove = async () => {
    if (!await confirm({ title: `Delete everything stored about gate ${phone}?`, action: 'Delete all gate data', color: 'red',
      body: 'This permanently deletes, for every account on this computer: the gate and everyone\'s access to it (with its DKS login and master code), '
        + 'gate configuration, relay names, Device association, notes, the transaction history, History, scheduled transfers, '
        + 'camera settings, the pulled files, the working copy with any unsent changes, and every camera picture and video. '
        + 'It can\'t be undone (only from a backup). Nothing on the gate itself changes.' })) return;
    setError('');
    setInfo('Deleting…');
    try {
      const reply = await gapi<{ filesError?: string }>('POST', '/delete-data', { confirm: true });
      if (reply.filesError) {
        setInfo('');
        setError(`Database data deleted, but some files could not be deleted: ${reply.filesError}`);
        return;
      }
      onDeleted();
    } catch (err) {
      setInfo('');
      setError(`Not deleted: ${errorText(err)}`);
    }
  };
  return (
    <Card>
      {dialog}
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" color="error" sx={{ display: 'flex', alignItems: 'center' }}>
            Delete stored gate data<HelpTip of="deleteGateData" />
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Removes everything this app has stored about this gate, for <strong>every account</strong> on this computer, and takes it off
            every gate list. Use it when the gate is no longer managed here. Nothing on the gate changes; to manage it again, add it and pull.
          </Typography>
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="contained" color="error" onClick={remove}>Delete all data for this gate…</Button>
            {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

interface WorkingCopyFilesProps {
  phone: string;
  available: boolean;
}

/**
 * Downloads of the working copy's board files (names.map flags the 128-byte blocks of names.bin that changed).
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.available - Available.
 * @returns Rendered React element.
 */
function WorkingCopyFiles({ phone, available }: WorkingCopyFilesProps) {
  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Working copy files</Typography>
          <Typography variant="body2" color="text.secondary">
            {available ? 'Download the working copy\'s files, with every change saved to it.' : 'No working copy yet. Pull residents from the gate.'}
          </Typography>
          {available && (
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {['names.bin', 'names.map', 'phone.bin', 'cards.bin'].map((file) => (
                <Link key={file} variant="body2" underline="hover" href={gateUrl(phone, `/files/${file}`)} download={file}>{file}</Link>
              ))}
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

interface StrongAdminPolicyCardProps {
  prefs: GatePrefs;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

function StrongAdminPolicyCard({ prefs, gapi, onSaved }: StrongAdminPolicyCardProps) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const enabled = Boolean(prefs.requireStrongAdmin);
  const toggle = async (next: boolean) => {
    setBusy(true);
    setInfo('');
    setError('');
    try {
      await gapi('PUT', '/prefs', { requireStrongAdmin: next });
      await onSaved();
      setInfo(next ? 'Strong confirmation is now required for all admin actions on this gate.' : 'Standard step-up rules restored.');
    } catch (err) {
      setError(`Not saved: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <Typography variant="h6" component="h2">Admin security</Typography>
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Stack spacing={0.5} sx={{ flex: '1 1 20rem' }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>Require strong sign-in for all admin actions</Typography>
              <Typography variant="body2" color="text.secondary">
                When enabled, every admin change on this gate requires a recent passkey confirmation or MFA single sign-in
                (within the server&apos;s step-up window). API keys are unaffected.
              </Typography>
            </Stack>
            <Switch
              checked={enabled}
              disabled={busy}
              onChange={(_, checked) => toggle(checked)}
              slotProps={{ input: { 'aria-label': 'Require strong sign-in for all admin actions' } }}
            />
          </Stack>
          {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

function SettingsSection({
  title, help, defaultExpanded = false, children,
}: { title: string; help?: string; defaultExpanded?: boolean; children: ReactNode }) {
  return (
    <Accordion variant="outlined" defaultExpanded={defaultExpanded} disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600, display: 'flex', alignItems: 'center' }}>
          {title}{help && <HelpTip of={help} />}
        </Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Stack spacing={2}>{children}</Stack>
      </AccordionDetails>
    </Accordion>
  );
}

interface SystemSettingsProps {
  phone: string;
  gapi: GateApi;
  prefs: GatePrefs;
  defaults: Config;
  list: ResidentsReply | null;
  cameras: CameraSettings | null;
  user: string;
  emailEnabled: boolean;
  onReload: () => Promise<void>;
  onSessionChange: () => void;
  onJobStarted: () => void;
}

/**
 * System Settings: gate login and users (admins), gate configuration, gate settings (working copy), working copy
 * files, device association, cameras and deleting the gate's stored data. Relay names are on the
 * Relays page; dark mode is in User Settings. Read-only users see the gate's configuration and settings, disabled.
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.defaults - Defaults.
 * @param props.list - List of input items.
 * @param props.cameras - Camera runner instance.
 * @param props.user - Local account username (or actor name for audit logs).
 * @param props.emailEnabled - Email enabled.
 * @param props.onReload - Callback to reload the gate data.
 * @param props.onSessionChange - On session change.
 * @param props.onJobStarted - On job started.
 * @returns Rendered React element.
 */
export function SystemSettings({ phone, gapi, prefs, defaults, list, cameras, user, emailEnabled, onReload, onSessionChange, onJobStarted }: SystemSettingsProps) {
  const settings = useGateSettings(gapi);
  const readOnly = useReadOnly();
  const isAdmin = useIsAdmin();
  const [usersRefresh, setUsersRefresh] = useState(0);
  const reloadAll = async () => { await onReload(); await settings.load(); };
  const shared = (
    <>
      <GateConfig key={`${JSON.stringify(prefs.gateConfig)}-${list?.dirDigits}`} prefs={prefs} defaults={defaults} list={list} gapi={gapi}
        gate={{ memory: settings.field('systemMemory')?.gate, chips: settings.field('memoryChips')?.gate }}
        onSaved={async () => { onSessionChange(); await reloadAll(); }} />
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">Gate settings</Typography>
            <GateSettingsEditor settings={settings} view="prefs" gapi={gapi} onReload={onReload} />
          </Stack>
        </CardContent>
      </Card>
    </>
  );
  if (readOnly) {
    return (
      <Stack spacing={3}>
        <Typography variant="h5" component="h1">System Settings</Typography>
        <fieldset disabled className="readonly-page">
          <Stack spacing={3}>
            {shared}
            <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
          </Stack>
        </fieldset>
      </Stack>
    );
  }
  if (!isAdmin) {
    return (
      <Stack spacing={3}>
        <Typography variant="h5" component="h1">System Settings</Typography>
        {shared}
        <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
      </Stack>
    );
  }
  return (
    <Stack spacing={2}>
      <Typography variant="h5" component="h1" sx={{ mb: 1.5 }}>System Settings</Typography>
      <SettingsSection title="Gate login" help="dksLogin" defaultExpanded>
        <GateLoginCard gapi={gapi} onJobStarted={onJobStarted} />
      </SettingsSection>
      <GateUsersCard gapi={gapi} me={user} emailEnabled={emailEnabled} refreshKey={usersRefresh} onSessionChange={onSessionChange} />
      <SettingsSection title="Create or share a gate account">
        <AddGateUserCard gapi={gapi} emailEnabled={emailEnabled} onChanged={() => setUsersRefresh((n) => n + 1)} />
      </SettingsSection>
      <SettingsSection title="Security & Resident Portal">
        <StrongAdminPolicyCard prefs={prefs} gapi={gapi} onSaved={onReload} />
        <ResidentPortalSettingsCard key={JSON.stringify(prefs.residentPortal)} prefs={prefs} gapi={gapi}
          onSaved={async () => { await onReload(); onSessionChange(); }} />
      </SettingsSection>
      <LoginAuditCard gapi={gapi} />
      <SettingsSection title="Integrations (API keys & Webhooks)">
        <ApiKeysCard phone={phone} gapi={gapi} />
        <WebhooksCard gapi={gapi} />
      </SettingsSection>
      <SettingsSection title="Gate configuration & board settings">
        {shared}
        <WorkingCopyFiles phone={phone} available={Boolean(settings.reply)} />
        <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
      </SettingsSection>
      <SettingsSection title="Cameras">
        <CameraForm key={JSON.stringify(cameras)} settings={cameras} phone={phone} gapi={gapi} onSaved={onReload} />
      </SettingsSection>
      <SettingsSection title="Danger zone">
        <DeleteGateData phone={phone} gapi={gapi} onDeleted={onSessionChange} />
      </SettingsSection>
    </Stack>
  );
}
