import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { DeviceRange, GateFeatures, ResidentRow } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { phoneFull, securityText } from '../format.ts';
import { CardsEditor, Choice, Field, PhoneField } from './fields.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { generateSafeEntryCode, NOTE_MAX } from '../../../src/shared.ts';
import { WelcomeInstructionsDialog } from './WelcomeInstructionsDialog.tsx';

/**
 * Directory codes 0 and 1 (000, 001, ...) always get the maximum talk time; the DoorKing manual keeps them for the
 * manager's office or an emergency number, so new entries aren't offered them first.
 *
 * @param code - Directory code string.
 * @returns Computed result.
 */
const reservedCode = (code: string) => /^\d+$/.test(code) && Number(code) <= 1;

interface ResidentFormProps {
  resident: ResidentRow | null;
  vendor: boolean;
  gatePhone: string;
  siteName: string;
  dirDigits: number;
  emptyCodes: string[];
  usedEntryCodes: string[];
  adminPhone: string;
  grantAccessDigit: string;
  devices: DeviceRange[];
  features: GateFeatures;
  gapi: GateApi;
  onDone: () => Promise<void>;
  onAdminPhoneSaved?: () => Promise<void>;
  onCancel?: () => void;
}

/**
 * Edits a resident (every field) or vendor (name, entry code, security level, cards) in the working copy, or adds a new one
 * (r null). Nothing goes to the gate until Send. Floor and elevator reference are hidden when the gate's features
 * turn them off; their values are kept.
 *
 * @param props - Component props.
 * @param props.resident - Resident/vendor row.
 * @param props.vendor - Whether the entry is a vendor.
 * @param props.dirDigits - Number of digits in directory codes (1–4).
 * @param props.emptyCodes - List of currently vacant directory codes.
 * @param props.devices - Configured Device Association card ranges.
 * @param props.features - Visible feature toggles (`floors`, `elevators`).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onDone - Callback invoked when the action completes.
 * @param props.onCancel - Callback invoked when the user cancels.
 * @returns Rendered React element.
 */
export function ResidentForm({
  resident, vendor, gatePhone, siteName, dirDigits, emptyCodes, usedEntryCodes, adminPhone, grantAccessDigit,
  devices, features, gapi, onDone, onAdminPhoneSaved, onCancel,
}: ResidentFormProps) {
  const [code, setCode] = useState(resident ? resident.directoryCode : emptyCodes.find((emptyCode) => !reservedCode(emptyCode)) || '');
  const [name, setName] = useState(resident ? resident.name : '');
  const [phone, setPhone] = useState(resident ? phoneFull(resident) : '');
  const [entryCode, setEntryCode] = useState(resident ? resident.entryCode : '');
  const [securityLevel, setSecurity] = useState(resident && resident.securityLevel !== '' ? String(resident.securityLevel) : '1');
  const [floor, setFloor] = useState(resident ? String(resident.floor) : '');
  const [elevatorRef, setElevator] = useState(String((resident && resident.elevatorRef) || 1));
  const [cards, setCards] = useState((resident ? resident.cards : []).map((card) => String(Number(card))));
  const [note, setNote] = useState(resident ? resident.note || '' : '');
  const [email, setEmail] = useState(resident ? resident.email || '' : '');
  const [portalEnabled, setPortalEnabled] = useState(Boolean(resident?.portalEnabled));
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [dialog, confirm] = useConfirm();
  const noun = vendor ? 'vendor' : 'resident';

  const prevEmail = (resident?.email || '').trim().toLowerCase();
  const nextEmail = email.trim().toLowerCase();
  const willDisablePortal = Boolean(resident?.portalEnabled) && (!portalEnabled || !nextEmail);
  const willReplaceResident = Boolean(resident?.portalEnabled) && portalEnabled && Boolean(prevEmail && nextEmail && prevEmail !== nextEmail);

  const resendInvite = async () => {
    if (!resident) return;
    setBusy(true);
    setError('');
    setInfo('Resending invitation…');
    try {
      await gapi('POST', `/residents/${encodeURIComponent(resident.directoryCode)}/resend-invite`, {});
      setInfo('Resident Portal invitation resent.');
    } catch (err) {
      setInfo('');
      setError(errorText(err));
    }
    setBusy(false);
  };

  const generateCode = () => {
    setError('');
    try {
      const taken = [...usedEntryCodes, ...(entryCode ? [entryCode] : [])];
      const next = generateSafeEntryCode(taken);
      setEntryCode(next);
      setInfo(`Generated safe entry code ${next}.`);
    } catch (err) {
      setInfo('');
      setError(errorText(err));
    }
  };

  const run = async (busyText: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setInfo(busyText);
    try {
      await fn();
      await onDone();
    } catch (err) {
      setInfo('');
      setError(errorText(err));
      setBusy(false);
    }
  };

  /**
   * The edit payload; the combined phone is split into area code (3 digits, or 1 + area code for long distance)
   * and the 7-digit number.
   *
   * @returns `Record<string, unknown> | null` result.
   */
  function payload(): Record<string, unknown> | null {
    const out: Record<string, unknown> = { name, entryCode, cards, securityLevel: Number(securityLevel || 0) };
    if (vendor) return out;
    const full = phone.replace(/\D/g, '');
    if (full && full.length !== 7 && full.length !== 10 && !(full.length === 11 && full[0] === '1')) {
      setInfo('');
      setError('Phone must be 7 digits, 10 with area code, or 11 starting with 1 for long distance.');
      return null;
    }
    return {
      ...out,
      areaCode: full.slice(0, -7), phone: full.slice(-7), floor, elevatorRef: Number(elevatorRef),
      email: nextEmail,
      portalEnabled: Boolean(nextEmail && portalEnabled),
    };
  }

  /**
   * The note is local (not in the working copy), saved after the entry when it changed.
   *
   * @param dirCode - `string` value.
   * @returns Rendered React element.
   */
  const saveNote = (dirCode: string) => (note.trim() === ((resident && resident.note) || '') ? Promise.resolve()
    : gapi('PUT', `/residents/${encodeURIComponent(dirCode)}/note`, { note }));

  function save() {
    const body = payload();
    if (!body) return;
    if (note.trim().length > NOTE_MAX) { setInfo(''); setError(`A note is at most ${NOTE_MAX} characters.`); return; }
    if (resident) {
      run('Saving…', async () => {
        await gapi('PUT', `/residents/${encodeURIComponent(resident.directoryCode)}`, { ...body, directoryCode: resident.directoryCode });
        await saveNote(resident.directoryCode);
      });
      return;
    }
    if (!new RegExp(`^\\d{${dirDigits}}$`).test(code)) { setInfo(''); setError(`Enter a ${dirDigits}-digit directory code.`); return; }
    if (!name.trim()) { setInfo(''); setError('A name is required.'); return; }
    run('Creating…', async () => {
      await gapi('POST', '/residents', { ...body, directoryCode: code, vendor });
      await saveNote(code);
    });
  }

  const who = resident ? `${resident.name || '(no name)'} · code ${resident.directoryCode}` : '';
  /** Delete: empties the slot (the directory code stays, as the gate marks an empty slot). */
  async function clearSlot() {
    if (!resident || !await confirm({
      title: `Delete ${noun} "${who}"?`, action: `Delete ${noun}`, color: 'red',
      body: 'This clears the name, phone, entry code and all cards for this directory slot in the working copy. The slot (directory code) itself stays, matching how the gate marks an empty slot. Nothing is sent to the gate until you Send.',
    })) return;
    run('Deleting…', () => gapi('DELETE', `/residents/${encodeURIComponent(resident.directoryCode)}`));
  }
  /** Remove code: takes the directory code itself off the gate. */
  async function removeCode() {
    if (!resident || !await confirm({
      title: `Remove directory code ${resident.directoryCode}?`, action: 'Remove code', color: 'red',
      body: `"${who}": this deletes the entry, phone record and all cards, and takes code ${resident.directoryCode} off the gate (it will no longer be a vacant slot). Nothing is sent to the gate until you Send.`,
    })) return;
    run('Removing…', () => gapi('DELETE', `/directory-codes/${encodeURIComponent(resident.directoryCode)}`));
  }

  return (
    <Stack spacing={2} onClick={(event) => event.stopPropagation()}>
      {dialog}
      {!resident && <Typography variant="h6">Add {noun}</Typography>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
        {!resident && (
          <Field label="Directory code (vacant or new)" help="directoryCode">
            <TextField
              size="small"
              fullWidth
              placeholder={`e.g. ${'5'.repeat(dirDigits)}`}
              slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: dirDigits, list: 'dk-empty-codes', 'aria-label': 'Directory code' } }}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <datalist id="dk-empty-codes">
              {[...emptyCodes.filter((emptyCode) => !reservedCode(emptyCode)), ...emptyCodes.filter(reservedCode)].map((emptyCode) => (
                <option key={emptyCode} value={emptyCode} />
              ))}
            </datalist>
            {reservedCode(code) && (
              <Typography variant="caption" color="warning.main">
                Codes {'0'.padStart(dirDigits, '0')} and {'1'.padStart(dirDigits, '0')} always get the maximum talk time; best kept for the office or an emergency number.
              </Typography>
            )}
          </Field>
        )}
        <Field label="Name">
          <TextField
            size="small"
            fullWidth
            slotProps={{ htmlInput: { maxLength: 15, 'aria-label': 'Name' } }}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {!vendor && (
          <Field label="Phone (area + number)">
            <PhoneField value={phone} onChange={setPhone} ariaLabel="Phone number" />
          </Field>
        )}
        <Field label="Entry code" help="entryCode">
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField
              size="small"
              slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 4, 'aria-label': 'Entry code' } }}
              value={entryCode}
              onChange={(event) => setEntryCode(event.target.value)}
              sx={{ flex: 1 }}
            />
            <Button
              type="button"
              variant="outlined"
              color="inherit"
              size="small"
              onClick={generateCode}
              disabled={busy}
              title="Generate a random non-colliding 4-digit code (avoids repeating digits and sequences)"
            >
              Generate
            </Button>
          </Stack>
        </Field>
        <Field label="Security level" help="securityLevel">
          <Choice
            value={securityLevel}
            onChange={setSecurity}
            ariaLabel="Security level"
            options={Array.from({ length: 31 }, (_, i) => [String(i), securityText(i)] as const)}
          />
        </Field>
        {!vendor && (
          <>
            {features.floors && (
              <Field label="Floor (blank = none)" help="floor">
                <TextField
                  size="small"
                  fullWidth
                  type="number"
                  slotProps={{ htmlInput: { min: 1, max: 64, 'aria-label': 'Floor' } }}
                  value={floor}
                  onChange={(event) => setFloor(event.target.value)}
                />
              </Field>
            )}
            {features.elevators && (
              <Field label="Elevator reference" help="elevatorRef">
                <Choice
                  value={elevatorRef}
                  onChange={setElevator}
                  ariaLabel="Elevator reference"
                  options={Array.from({ length: 8 }, (_, i) => String(i + 1))}
                />
              </Field>
            )}
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minHeight: '100%' }}>
              <Typography variant="body2" color="text.secondary">
                {name.trim() && phone.replace(/\D/g, '') ? 'Shown in the entry-panel directory' : 'Hidden from the entry-panel directory (no phone number)'}
              </Typography>
              <HelpTip of="hidden" />
            </Stack>
          </>
        )}
      </Box>
      {!vendor && (
        <Paper variant="outlined" sx={{ p: 2, bgcolor: 'action.hover' }}>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>Resident Portal &amp; Email</Typography>
              {resident?.portalEnabled && (
                <Chip
                  size="small"
                  color={resident.portalInvited ? 'warning' : 'success'}
                  label={resident.portalInvited ? 'Invited' : 'Active'}
                />
              )}
              {resident?.portalEnabled && resident.portalInvited && (
                <Button type="button" size="small" variant="text" disabled={busy} onClick={resendInvite}>Resend invite</Button>
              )}
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, alignItems: 'end' }}>
              <Field label="Resident email (local only)">
                <TextField
                  size="small"
                  fullWidth
                  type="email"
                  placeholder="resident@example.com"
                  slotProps={{ htmlInput: { 'aria-label': 'Resident email' } }}
                  value={email}
                  onChange={(event) => {
                    const val = event.target.value;
                    setEmail(val);
                    if (!val.trim()) setPortalEnabled(false);
                  }}
                />
              </Field>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={Boolean(nextEmail && portalEnabled)}
                    disabled={!nextEmail}
                    onChange={(event) => setPortalEnabled(event.target.checked)}
                  />
                }
                label={<Typography variant="body2">Enable Resident Portal / gate access for this resident</Typography>}
              />
            </Box>
            {willDisablePortal && (
              <Alert severity="warning">
                Disabling portal access (or clearing email) immediately revokes this unit&apos;s access and permanently wipes
                the previous resident&apos;s password, passkeys, and active sessions if they have no other units.
              </Alert>
            )}
            {willReplaceResident && (
              <Alert severity="warning">
                Changing email will revoke and wipe the previous resident&apos;s access (password &amp; passkeys) and start
                fresh onboarding for <strong>{nextEmail}</strong> (binding automatically if they already have an account).
              </Alert>
            )}
          </Stack>
        </Paper>
      )}
      <CardsEditor cards={cards} devices={devices} onChange={setCards} />
      <Field label="Notes" help="notes">
        <TextField
          multiline
          minRows={2}
          fullWidth
          slotProps={{ htmlInput: { maxLength: NOTE_MAX, 'aria-label': 'Notes' } }}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          sx={{ maxWidth: 640 }}
        />
      </Field>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="contained" onClick={save} disabled={busy}>{resident ? 'Save to working copy' : `Create ${noun}`}</Button>
        {!vendor && (
          <Button type="button" variant="outlined" onClick={() => setWelcomeOpen(true)} disabled={busy}>
            Welcome &amp; PDF…
          </Button>
        )}
        {resident && <Button color="error" variant="outlined" onClick={clearSlot} disabled={busy}>Delete {noun}</Button>}
        {resident && (
          <Button
            color="error"
            variant="outlined"
            onClick={removeCode}
            disabled={busy}
            title="Delete the entry and take the directory code off the gate"
          >
            Remove code
          </Button>
        )}
        {onCancel && <Button variant="text" color="inherit" onClick={onCancel}>{resident ? 'Close editor' : 'Cancel'}</Button>}
        {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
      </Stack>
      {!vendor && (
        <WelcomeInstructionsDialog
          open={welcomeOpen}
          onOpenChange={setWelcomeOpen}
          phone={gatePhone}
          siteName={siteName}
          resident={{
            name: name.trim(),
            directoryCode: (resident ? resident.directoryCode : code).trim(),
            entryCode: entryCode.trim(),
            hidden: !(name.trim() && phone.replace(/\D/g, '')),
            cards: cards.map((card) => card.trim()).filter(Boolean),
          }}
          defaultAdminPhone={adminPhone}
          defaultGrantDigit={grantAccessDigit}
          onAdminPhoneSaved={onAdminPhoneSaved}
        />
      )}
    </Stack>
  );
}
