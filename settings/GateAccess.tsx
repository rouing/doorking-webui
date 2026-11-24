/**
 * @module web/ui/settings/GateAccess
 *
 * Who can reach the gate (admins): its DKS login and master code, gate users and API keys.
 */
import { useEffect, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Link,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ApiKeyInfo, GateLogin, GateRole, GateUser } from '../types.ts';
import { ApiError, errorText, type GateApi } from '../api.ts';
import { fmtIntlPhone, fmtTime } from '../format.ts';
import { Choice, Field } from '../panes/fields.tsx';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';

const ROLE_LABELS: Record<GateRole, string> = {
  readonly: 'Read only',
  editor: 'Editor',
  admin: 'Admin',
  resident: 'Resident',
};

const ROLE_SENTENCE: Record<GateRole, string> = {
  readonly: 'read only',
  editor: 'an editor',
  admin: 'an admin',
  resident: 'a resident',
};

function roleLabel(role: GateRole): string {
  return ROLE_LABELS[role] ?? role;
}

interface GateLoginCardProps {
  gapi: GateApi;
  onJobStarted: () => void;
}

/**
 * The gate's DKS login and master code (admins). A new DKS login is checked with DKS Cloud before it is saved; a new
 * master code is checked by pulling residents with it and saved only when that works. Neither is ever shown.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onJobStarted - On job started.
 * @returns Rendered React element.
 */
export function GateLoginCard({ gapi, onJobStarted }: GateLoginCardProps) {
  const [login, setLogin] = useState<GateLogin | null>(null);
  const [form, setForm] = useState({ dksUser: '', dksPassword: '', masterCode: '' });
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const load = () => gapi<GateLogin>('GET', '/login').then((reply) => {
    setLogin(reply);
    setForm({ dksUser: reply.dksUser, dksPassword: '', masterCode: '' });
    setError('');
  }, (err) => setError(errorText(err)));
  useEffect(() => { load(); }, [gapi]);
  const save = async () => {
    setError('');
    setInfo('Checking with DKS Cloud…');
    try {
      const reply = await gapi<{ changed?: boolean; checking?: boolean }>('PUT', '/login', form);
      setInfo(reply.checking ? 'Checking the new master code with a residents pull. It is saved when the pull succeeds (see Gate connection).'
        : reply.changed ? 'DKS login saved.' : 'Nothing changed.');
      if (reply.checking) onJobStarted();
      await load();
    } catch (err) {
      setInfo('');
      setError(`Not saved: ${errorText(err)}`);
    }
  };
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        The DKS Cloud login and master code this gate&apos;s pulls, sends, relay changes and scheduled transfers use, for every user of the gate.
        Leave the password and master code empty to keep the saved ones.
      </Typography>
      {login && !login.dksPasswordSet && (
        <Alert severity="warning">No DKS login saved yet: pulls and sends fail until you set one.</Alert>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
        <Field label="DKS user">
          <TextField
            size="small"
            value={form.dksUser}
            autoComplete="off"
            slotProps={{ htmlInput: { 'aria-label': 'DKS user' } }}
            onChange={(event) => setForm({ ...form, dksUser: event.target.value })}
          />
        </Field>
        <Field label="DKS password">
          <TextField
            size="small"
            type="password"
            value={form.dksPassword}
            autoComplete="new-password"
            placeholder={login && login.dksPasswordSet ? 'saved (leave empty to keep)' : ''}
            slotProps={{ htmlInput: { 'aria-label': 'DKS password' } }}
            onChange={(event) => setForm({ ...form, dksPassword: event.target.value })}
          />
        </Field>
        <Field label="Master code" help="gateMasterCode">
          <TextField
            size="small"
            type="password"
            value={form.masterCode}
            autoComplete="off"
            placeholder="saved (leave empty to keep)"
            slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 4, 'aria-label': 'Master code' } }}
            onChange={(event) => setForm({ ...form, masterCode: event.target.value })}
          />
        </Field>
      </Box>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="contained" onClick={save}>Save gate login</Button>
        {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}

interface RoleSelectProps {
  value: GateRole;
  onChange: (role: GateRole) => void;
  ariaLabel?: string;
}

function RoleSelect({ value, onChange, ariaLabel }: RoleSelectProps) {
  return (
    <Choice
      value={value}
      ariaLabel={ariaLabel}
      onChange={(next) => onChange(next as GateRole)}
      options={[['readonly', 'Read only'], ['editor', 'Editor'], ['admin', 'Admin']]}
    />
  );
}

const USERS_PAGE = 10;

interface GateUsersCardProps {
  gapi: GateApi;
  me: string;
  emailEnabled: boolean;
  refreshKey?: number;
  onSessionChange: () => void;
}

/**
 * Collapsible, compact list of who may use this gate (admins, editors, read-only staff, and residents), rendered as
 * paged bubble cards matching the Login Audit Log style.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function GateUsersCard({ gapi, me, emailEnabled, refreshKey = 0, onSessionChange }: GateUsersCardProps) {
  const [users, setUsers] = useState<GateUser[]>([]);
  const [filter, setFilter] = useState<'all' | 'staff' | 'resident'>('all');
  const [shown, setShown] = useState(USERS_PAGE);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [dialog, confirm] = useConfirm();
  const load = () => gapi<{ users: GateUser[] }>('GET', '/users').then((reply) => { setUsers(reply.users); setError(''); }, (err) => setError(errorText(err)));
  useEffect(() => { load(); }, [gapi, refreshKey]);
  useEffect(() => { setShown(USERS_PAGE); }, [filter]);
  const run = async (fn: () => Promise<{ users: GateUser[] }>, done: string) => {
    setError('');
    try { setUsers((await fn()).users); setInfo(done); return true; } catch (err) { setInfo(''); setError(errorText(err)); return false; }
  };
  const changeRole = async (user: GateUser, role: GateRole) => {
    await run(() => gapi('PUT', `/users/${encodeURIComponent(user.username)}`, { role }),
      `${user.username} is now ${ROLE_SENTENCE[role] ?? role}.`);
    if (user.username === me) onSessionChange();
  };
  const remove = async (user: GateUser) => {
    if (!await confirm({ title: `Remove ${user.username} from this gate?`, action: 'Remove', color: 'red',
      body: 'They will no longer see this gate. Their account stays (it may have other gates).' })) return;
    await run(() => gapi('DELETE', `/users/${encodeURIComponent(user.username)}`), `${user.username} removed.`);
    if (user.username === me) onSessionChange();
  };
  const resendInvite = (user: GateUser) => run(() => gapi('POST', `/users/${encodeURIComponent(user.username)}/invite`, {}),
    `Invitation sent again to ${user.pendingEmail}.`);

  const staffCount = users.filter((u) => u.role !== 'resident').length;
  const residentCount = users.length - staffCount;
  const filtered = users.filter((u) => (filter === 'all' ? true : filter === 'resident' ? u.role === 'resident' : u.role !== 'resident'));
  const visible = filtered.slice(0, shown);

  return (
    <Accordion variant="outlined" disableGutters>
      {dialog}
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', pr: 1 }}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center' }}>
            Gate users<HelpTip of="gateRole" />
          </Typography>
          <Chip size="small" label={`${staffCount} staff`} color="primary" />
          {residentCount > 0 && <Chip size="small" label={`${residentCount} resident${residentCount === 1 ? '' : 's'}`} color="success" />}
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">
              <strong>Admin</strong>: full access. <strong>Editor</strong>: edits working copy only. <strong>Read only</strong>: view, pull &amp; cameras.
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={filter}
              aria-label="Filter gate users"
              onChange={(_, next) => { if (next) setFilter(next); }}
            >
              <ToggleButton value="all">All ({users.length})</ToggleButton>
              <ToggleButton value="staff">Staff ({staffCount})</ToggleButton>
              <ToggleButton value="resident">Residents ({residentCount})</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          <Stack spacing={1}>
            {visible.map((user) => (
              <Paper key={user.username} elevation={0} sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{user.username}</Typography>
                      {user.username === me && <Chip size="small" label="you" />}
                      {user.ssoProviders && user.ssoProviders.length > 0 && (
                        <Tooltip title={`Linked SSO: ${user.ssoProviders.join(', ')}`}>
                          <Chip size="small" label="SSO" color="primary" />
                        </Tooltip>
                      )}
                      {user.invited && <Chip size="small" label="invited" color="warning" />}
                      {user.role === 'resident' && (
                        <Tooltip title="Resident Portal access — manage on the Residents page, or grant staff access via Add / Share account">
                          <Chip size="small" color="success" label="Resident" />
                        </Tooltip>
                      )}
                    </Stack>
                    {user.role !== 'resident' && (
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <RoleSelect
                          value={user.role}
                          ariaLabel={`Role for ${user.username}`}
                          onChange={(role) => changeRole(user, role)}
                        />
                        <Button size="small" variant="outlined" color="error" onClick={() => remove(user)}>Remove</Button>
                      </Stack>
                    )}
                  </Stack>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    {(user.email || user.pendingEmail) && (
                      <Typography variant="caption" color="text.secondary">
                        {user.email || `${user.pendingEmail} (unconfirmed)`}
                      </Typography>
                    )}
                    {user.phone && (
                      <Link href={`tel:${user.phone}`} variant="caption">{fmtIntlPhone(user.phone)}</Link>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      Added by {user.grantedBy} · Last sign-in {user.lastSignIn ? fmtTime(user.lastSignIn) : 'never'}
                    </Typography>
                    {user.invited && emailEnabled && (
                      <Button size="small" variant="outlined" onClick={() => resendInvite(user)}>Send invite again</Button>
                    )}
                    {user.role === 'resident' && (
                      <Typography variant="caption" color="text.secondary">Managed in Residents</Typography>
                    )}
                  </Stack>
                </Stack>
              </Paper>
            ))}
          </Stack>
          {filtered.length > shown && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Button size="small" variant="outlined" onClick={() => setShown((n) => n + USERS_PAGE)}>
                Show {Math.min(USERS_PAGE, filtered.length - shown)} more
              </Button>
              <Typography variant="caption" color="text.secondary">
                Showing {shown} of {filtered.length}
              </Typography>
            </Stack>
          )}
          {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

interface AddGateUserCardProps {
  gapi: GateApi;
  emailEnabled: boolean;
  onChanged: () => void;
}

/**
 * Separate card for creating a new staff account for this gate or sharing the gate with an existing account
 * (including upgrading a resident account to staff via Share).
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function AddGateUserCard({ gapi, emailEnabled, onChanged }: AddGateUserCardProps) {
  const [create, setCreate] = useState({ username: '', password: '', email: '', role: 'readonly' as GateRole });
  const [createInfo, setCreateInfo] = useState('');
  const [createError, setCreateError] = useState('');
  const [exists, setExists] = useState('');
  const [share, setShare] = useState({ username: '', role: 'readonly' as GateRole });
  const [shareInfo, setShareInfo] = useState('');
  const [shareError, setShareError] = useState('');

  const shareWith = async (username: string, role: GateRole, setOk: (text: string) => void, setErr: (text: string) => void) => {
    setErr('');
    try {
      await gapi('POST', '/share', { username, role });
      setOk(`Shared with ${username.trim().toLowerCase()}.`);
      onChanged();
      return true;
    } catch (err) {
      setOk('');
      setErr(errorText(err));
      return false;
    }
  };

  const createUser = async () => {
    setExists('');
    setCreateError('');
    try {
      const reply = await gapi<{ users: GateUser[]; invited: boolean }>('POST', '/users', create);
      const who = create.username.trim().toLowerCase();
      setCreateInfo(reply.invited ? `Invitation sent to ${create.email.trim()}. ${who} chooses their password with the link (valid 72 hours).`
        : `Account ${who} created. Give them the username and temporary password; they choose their own at their first sign-in.`);
      setCreate({ username: '', password: '', email: '', role: 'readonly' });
      onChanged();
    } catch (err) {
      setCreateInfo('');
      setCreateError(errorText(err));
      if (err instanceof ApiError && err.body.exists) setExists(create.username.trim().toLowerCase());
      if (err instanceof ApiError && Array.isArray(err.body.users)) onChanged();
    }
  };

  return (
    <Stack spacing={2.5}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>Create an account for this gate</Typography>
            <Typography variant="body2" color="text.secondary">
              {emailEnabled ? 'With an email and no password, they get an invitation link to choose their own password. Without an email, set a temporary password; they choose their own at their first sign-in.'
                : 'Set a temporary password; they choose their own at their first sign-in. (Email invitations need email set up on the server.)'}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }, gap: 2 }}>
              <Field label="Username">
                <TextField
                  size="small"
                  value={create.username}
                  autoComplete="off"
                  slotProps={{ htmlInput: { 'aria-label': 'New account username' } }}
                  onChange={(event) => setCreate({ ...create, username: event.target.value })}
                />
              </Field>
              <Field label={emailEnabled ? 'Temporary password (only without an invitation)' : 'Temporary password (12+ characters)'}>
                <TextField
                  size="small"
                  type="password"
                  value={create.password}
                  autoComplete="new-password"
                  slotProps={{ htmlInput: { 'aria-label': 'Temporary password' } }}
                  onChange={(event) => setCreate({ ...create, password: event.target.value })}
                />
              </Field>
              <Field label={emailEnabled ? 'Email (sends an invitation)' : 'Email (optional)'}>
                <TextField
                  size="small"
                  type="email"
                  value={create.email}
                  slotProps={{ htmlInput: { 'aria-label': 'New account email' } }}
                  onChange={(event) => setCreate({ ...create, email: event.target.value })}
                />
              </Field>
              <Field label="Role">
                <RoleSelect value={create.role} ariaLabel="New account role" onChange={(role) => setCreate({ ...create, role })} />
              </Field>
            </Box>
            <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="contained" onClick={createUser}>Create account</Button>
              {exists && (
                <Button variant="outlined" onClick={async () => { if (await shareWith(exists, create.role, setCreateInfo, setCreateError)) setExists(''); }}>
                  Share this gate with {exists} instead
                </Button>
              )}
              {createInfo && <Typography variant="body2" color="text.secondary">{createInfo}</Typography>}
            </Stack>
            {createError && <Alert severity="error">{createError}</Alert>}
          </Stack>

          <Stack spacing={1.5}>
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>Share with an existing account</Typography>
            <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Username">
                <TextField
                  size="small"
                  value={share.username}
                  autoComplete="off"
                  slotProps={{ htmlInput: { 'aria-label': 'Existing username to share with' } }}
                  onChange={(event) => setShare({ ...share, username: event.target.value })}
                />
              </Field>
              <Field label="Role">
                <RoleSelect value={share.role} ariaLabel="Shared account role" onChange={(role) => setShare({ ...share, role })} />
              </Field>
              <Button variant="contained" onClick={async () => { if (await shareWith(share.username, share.role, setShareInfo, setShareError)) setShare({ username: '', role: 'readonly' }); }}>
                Share
              </Button>
              {shareInfo && <Typography variant="body2" color="text.secondary">{shareInfo}</Typography>}
            </Stack>
            {shareError && <Alert severity="error">{shareError}</Alert>}
          </Stack>
        </Stack>
  );
}

interface ApiKeysCardProps {
  phone: string;
  gapi: GateApi;
}

/**
 * API keys for scripts and other systems (admins). A key belongs to this gate, not to a person; it is shown once when
 * created and works only on this gate's routes, with its own role. Revoking stops it at once.
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @returns Rendered React element.
 */
const SCOPE_PRESETS: Record<string, { label: string; scopes: string[] | null; minRole?: GateRole }> = {
  full: { label: 'Full role access', scopes: null },
  mcpRead: {
    label: 'MCP Read-Only',
    scopes: ['gate:read', 'directory:read', 'transactions:read', 'insights:read', 'history:read', 'settings:read', 'relays:read', 'schedules:read', 'cameras:read'],
  },
  mcpStaging: {
    label: 'MCP Working-Copy Staging (no Send/Relays)',
    scopes: ['gate:read', 'directory:read', 'directory:write', 'transactions:read', 'insights:read', 'history:read', 'settings:read', 'settings:write', 'relays:read', 'schedules:read', 'cameras:read', 'gate:pull'],
    minRole: 'editor',
  },
};

export function ApiKeysCard({ phone, gapi }: ApiKeysCardProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [form, setForm] = useState({ name: '', role: 'readonly' as GateRole, expiresDays: '0', scopePreset: 'full' });
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [dialog, confirm] = useConfirm();
  const load = () => gapi<{ apiKeys: ApiKeyInfo[] }>('GET', '/api-keys').then((reply) => { setKeys(reply.apiKeys); setError(''); }, (err) => setError(errorText(err)));
  useEffect(() => { load(); }, [gapi]);
  const create = async () => {
    setError('');
    try {
      const preset = SCOPE_PRESETS[form.scopePreset] || SCOPE_PRESETS.full;
      const body: Record<string, unknown> = { name: form.name, role: form.role, expiresDays: Number(form.expiresDays) };
      if (preset.scopes) body.scopes = preset.scopes;
      const reply = await gapi<{ key: string; apiKey: ApiKeyInfo }>('POST', '/api-keys', body);
      setCreated({ key: reply.key, name: reply.apiKey.name });
      setForm({ name: '', role: 'readonly', expiresDays: '0', scopePreset: 'full' });
      setInfo('');
      await load();
    } catch (err) {
      setInfo('');
      setError(errorText(err));
    }
  };
  const revoke = async (apiKey: ApiKeyInfo) => {
    if (!await confirm({ title: `Revoke the API key "${apiKey.name}"?`, action: 'Revoke', color: 'red',
      body: 'Anything using it stops working at once. This can\'t be undone; create a new key if needed.' })) return;
    setError('');
    try {
      setKeys((await gapi<{ apiKeys: ApiKeyInfo[] }>('DELETE', `/api-keys/${encodeURIComponent(apiKey.id)}`)).apiKeys);
      setInfo(`Revoked "${apiKey.name}".`);
    } catch (err) {
      setInfo('');
      setError(errorText(err));
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created!.key);
      setError('');
      setInfo('Copied.');
    } catch {
      setError('Copy failed: select the key and copy it.');
    }
  };
  return (
    <Card>
      {dialog}
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center' }}>
            API keys<HelpTip of="apiKeys" />
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Keys let scripts and other systems use this gate&apos;s API without a username or password. A key belongs to the gate (it keeps working if
            the person who made it leaves) and works only on this gate. <strong>Read only</strong> keys can view and pull; <strong>Editor</strong> keys can edit
            the working copy; <strong>Admin</strong> keys can also send. No key can change the gate login, users, API keys, or delete the gate&apos;s data. Send it as the header{' '}
            <code>Authorization: Bearer &lt;key&gt;</code> to <code>/api/gates/{phone}/…</code>.{' '}
            <Link href="/api/docs" target="_blank" rel="noopener">API documentation ↗</Link> (try calls there with a key).
          </Typography>
          {created && (
            <Alert severity="success">
              <Stack spacing={1}>
                <Typography variant="body2">
                  Key &ldquo;{created.name}&rdquo; created. <strong>Copy it now: it won&apos;t be shown again.</strong>
                </Typography>
                <Box component="code" sx={{ display: 'block', wordBreak: 'break-all', userSelect: 'all', fontFamily: 'monospace' }}>
                  {created.key}
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" onClick={copy}>Copy</Button>
                  <Button size="small" variant="outlined" color="inherit" onClick={() => setCreated(null)}>Done</Button>
                </Stack>
              </Stack>
            </Alert>
          )}
          {keys.length > 0 && (
            <Stack spacing={1}>
              {keys.map((apiKey) => {
                const expired = Boolean(apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= Date.now());
                const roleColor = apiKey.role === 'admin' ? 'primary' : apiKey.role === 'editor' ? 'warning' : 'default';
                return (
                  <Paper key={apiKey.id} elevation={0} sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{apiKey.name}</Typography>
                        <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                          <Chip size="small" color={roleColor} label={roleLabel(apiKey.role)} />
                          {apiKey.scopes && apiKey.scopes.length > 0 && (
                            <Tooltip title={apiKey.scopes.join(', ')}>
                              <Chip size="small" color="info" label={`Scoped (${apiKey.scopes.length})`} />
                            </Tooltip>
                          )}
                          <Chip size="small" label={`Created ${fmtTime(apiKey.createdAt)} · ${apiKey.createdBy}`} />
                          {apiKey.expiresAt ? (
                            <Chip
                              size="small"
                              color={expired ? 'error' : 'default'}
                              label={`${expired ? 'Expired' : 'Expires'} ${fmtTime(apiKey.expiresAt)}`}
                            />
                          ) : (
                            <Chip size="small" label="No expiry" />
                          )}
                          <Chip size="small" label={apiKey.lastUsedAt ? `Used ${fmtTime(apiKey.lastUsedAt)}` : 'Unused'} />
                        </Stack>
                      </Stack>
                      <Button size="small" variant="contained" color="error" sx={{ flexShrink: 0 }} onClick={() => revoke(apiKey)}>
                        Revoke
                      </Button>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Name">
              <TextField
                size="small"
                value={form.name}
                placeholder="e.g. Home Assistant"
                slotProps={{ htmlInput: { maxLength: 40, 'aria-label': 'API key name' } }}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <Field label="Role">
              <RoleSelect value={form.role} ariaLabel="API key role" onChange={(role) => setForm({ ...form, role })} />
            </Field>
            <Field label="Scopes">
              <Choice
                value={form.scopePreset}
                ariaLabel="API key scopes"
                onChange={(scopePreset) => {
                  const minRole = SCOPE_PRESETS[scopePreset]?.minRole;
                  const role = minRole && form.role === 'readonly' ? minRole : form.role;
                  setForm({ ...form, scopePreset, role });
                }}
                options={Object.entries(SCOPE_PRESETS).map(([k, v]) => [k, v.label] as [string, string])}
              />
            </Field>
            <Field label="Expires">
              <Choice
                value={form.expiresDays}
                ariaLabel="API key expiration"
                onChange={(value) => setForm({ ...form, expiresDays: value })}
                options={[['0', 'Never'], ['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In 1 year']]}
              />
            </Field>
            <Button variant="contained" onClick={create}>Create API key</Button>
            {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}
