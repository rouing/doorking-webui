import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { CameraSettings } from '../types.ts';
import { errorText, gateUrl, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { Choice, Field } from '../panes/fields.tsx';

type LiveFrame = { channel: number; name?: string; file?: string; error?: string };

const nums = (list: number[]): string[] => list.map(String);

interface CameraFormProps {
  settings: CameraSettings | null;
  phone: string;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

/**
 * Gate cameras: a Dahua/Amcrest recorder reached through Dahua's P2P cloud. Up to 4 channels. The password is
 * never sent back; leaving it blank keeps the saved one.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onSaved - On saved.
 * @returns Rendered React element.
 */
export function CameraForm({ settings, phone, gapi, onSaved }: CameraFormProps) {
  const saved = settings;
  const [form, setForm] = useState(() => ({
    serial: saved?.serial || '', username: saved?.username || '', password: '', clockOffset: String(saved?.clockOffset ?? 0), mode: saved?.mode || 'snapshots',
    frames: String(saved?.frames ?? 3), framesAfter: String(saved?.framesAfter ?? 0), clipTries: String(saved?.clipTries ?? 2), events: saved?.events || 'access',
    backfillHours: String(saved?.backfillHours ?? 24), keepDays: String(saved?.keepDays ?? 0), enabled: saved ? saved.enabled !== false : true,
  }));
  /** Four rows, or as many as are saved (up to 8 through the API), so saving keeps every channel. */
  const [channels, setChannels] = useState(() => Array.from({ length: Math.max(4, saved?.channels?.length || 0) }, (_, i) => {
    const channel = (saved?.channels || [{ channel: 1, name: '' }])[i];
    return { channel: channel ? String(channel.channel) : '', name: channel ? channel.name : '' };
  }));
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [live, setLive] = useState<{ frames: LiveFrame[]; stamp: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [dialog, confirm] = useConfirm();
  const set = (key: keyof typeof form, value: string | boolean) => setForm({ ...form, [key]: value });
  const video = form.mode === 'video';

  const run = async (fn: () => Promise<void>) => {
    setError('');
    try { await fn(); } catch (err) { setInfo(''); setError(errorText(err)); }
  };
  const save = () => run(async () => {
    const keep = Number(form.keepDays);
    if (keep && keep !== (settings?.keepDays || 0) && !await confirm({ title: `Keep pictures for ${keep} days?`, action: 'Save', color: 'red',
      body: `Pictures and videos older than ${keep} days are deleted now, and each day from then on. This cannot be undone.` })) return;
    setInfo('Saving…');
    try { await gapi('PUT', '/cameras', { ...form, channels: channels.map((channel) => ({ channel: channel.channel.trim(), name: channel.name })) }); } catch (err) {
      setInfo('');
      setError(`Save failed: ${errorText(err)}`);
      return;
    }
    set('password', '');
    setInfo('Saved. Use Test to check the login and channels.');
    await onSaved();
  });
  const test = () => run(async () => {
    setInfo('Connecting to the recorder… (up to a minute)');
    setTesting(true);
    try {
      const reply = await gapi<{ channels: LiveFrame[] }>('POST', '/cameras/test', {});
      setLive({ frames: reply.channels, stamp: Date.now() });
      setInfo(`Live pictures from ${reply.channels.filter((channel) => channel.file).length} of ${reply.channels.length} channels.`);
    } catch (err) {
      setInfo('');
      setError(`Test failed: ${errorText(err)}`);
    }
    setTesting(false);
  });
  const remove = () => run(async () => {
    if (!await confirm({ title: 'Remove the camera settings for this gate?', body: 'Saved snapshots are kept.', action: 'Remove', color: 'red' })) return;
    await gapi('DELETE', '/cameras');
    setLive(null);
    setInfo('Removed.');
    await onSaved();
  });
  const deleteSnaps = () => run(async () => {
    if (!await confirm({ title: 'Delete all saved camera pictures for this gate?', action: 'Delete all', color: 'red',
      body: 'This cannot be undone. Transactions still in the look-back period get new pictures on the next snapshot run.' })) return;
    try {
      const reply = await gapi<{ files: number; minutes: number }>('DELETE', '/snapshots');
      setLive(null);
      setInfo(`Deleted ${reply.files} pictures (${reply.minutes} minutes).`);
      await onSaved();
    } catch (err) {
      setInfo('');
      setError(`Delete failed: ${errorText(err)}`);
    }
  });

  return (
    <Stack spacing={2}>
      {dialog}
      <Typography variant="body2" color="text.secondary">
        A Dahua/Amcrest recorder reached through Dahua&apos;s P2P cloud (as DMSS/SmartPSS do). After each transactions pull, including
        scheduled pulls, frames (or a 2-minute video) from each channel for every new transaction&apos;s minute are saved and shown on the
        Transactions page. Stored locally and <strong>shared by every account that manages this gate</strong>; the password is
        encrypted in the local database.
      </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' }, gap: 2 }}>
            <Field label="Recorder serial" help="cameraSerial">
              <TextField size="small" autoComplete="off" value={form.serial} slotProps={{ htmlInput: { 'aria-label': 'Recorder serial' } }} onChange={(event) => set('serial', event.target.value)} />
            </Field>
            <Field label="Username">
              <TextField size="small" autoComplete="off" value={form.username} slotProps={{ htmlInput: { 'aria-label': 'Recorder username' } }} onChange={(event) => set('username', event.target.value)} />
            </Field>
            <Field label="Password">
              <TextField
                size="small"
                type="password"
                autoComplete="new-password"
                value={form.password}
                placeholder={settings ? 'saved (leave blank to keep)' : ''}
                slotProps={{ htmlInput: { 'aria-label': 'Recorder password' } }}
                onChange={(event) => set('password', event.target.value)}
              />
            </Field>
            <Field label="Clock offset (seconds)" help="clockOffset">
              <TextField size="small" type="number" value={form.clockOffset} slotProps={{ htmlInput: { step: 1, 'aria-label': 'Clock offset (seconds)' } }} onChange={(event) => set('clockOffset', event.target.value)} />
            </Field>
            <Field label="Save" help="cameraMode">
              <Choice value={form.mode} ariaLabel="Camera save mode" onChange={(value) => set('mode', value)} options={[['snapshots', 'Snapshots (pictures)'], ['video', '2-minute video clips']]} />
            </Field>
            <Field label="Frames per transaction" help="cameraFrames">
              <Choice value={form.frames} ariaLabel="Frames per transaction" onChange={(value) => set('frames', value)} options={nums([1, 2, 3, 4, 6])} disabled={video} />
            </Field>
            <Field label="Frames after the minute" help="cameraFramesAfter">
              <Choice value={form.framesAfter} ariaLabel="Frames after the minute" onChange={(value) => set('framesAfter', value)} options={nums([0, 1, 2, 3, 4, 6])} disabled={video} />
            </Field>
            <Field label="Video tries">
              <Choice value={form.clipTries} ariaLabel="Video tries" onChange={(value) => set('clipTries', value)} options={nums([1, 2, 3, 4, 5])} disabled={!video} />
            </Field>
            <Field label="Transactions" help="cameraEvents">
              <Choice value={form.events} ariaLabel="Transactions to capture" onChange={(value) => set('events', value)} options={[['access', 'Admitted and denied entries'], ['all', 'All']]} />
            </Field>
            <Field label="Keep pictures" help="cameraKeep">
              <Choice value={form.keepDays} ariaLabel="Keep pictures" onChange={(value) => set('keepDays', value)}
                options={[['15', '15 days'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days'], ['0', 'Forever']]} />
            </Field>
            <Field label="Look back (hours)" help="cameraLookBack">
              <TextField size="small" type="number" value={form.backfillHours} slotProps={{ htmlInput: { min: 0, max: 720, step: 1, 'aria-label': 'Look back (hours)' } }} onChange={(event) => set('backfillHours', event.target.value)} />
            </Field>
          </Box>
          <Stack spacing={1} sx={{ width: '100%', maxWidth: 540 }}>
            {channels.map((channel, i) => {
              const active = Boolean(channel.channel.trim());
              return (
                <Paper key={i} variant="outlined" sx={{ px: 1.5, py: 0.75, width: '100%', boxSizing: 'border-box' }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
                    <Chip size="small" label={`Ch ${i + 1}`} sx={{ minWidth: 48, flexShrink: 0 }} />
                    <TextField
                      size="small"
                      placeholder="#"
                      value={channel.channel}
                      slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': `Channel row ${i + 1} number` } }}
                      sx={{
                        width: '6.5ch',
                        flexShrink: 0,
                        '& .MuiInputBase-input': { py: 0.5, px: 0.75, fontSize: '0.85rem', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
                      }}
                      onChange={(event) => setChannels(channels.map((entry, j) => (j === i ? { ...entry, channel: event.target.value } : entry)))}
                    />
                    <TextField
                      size="small"
                      placeholder="Channel name"
                      value={channel.name}
                      slotProps={{ htmlInput: { maxLength: 40, 'aria-label': `Channel row ${i + 1} name` } }}
                      sx={{ flex: '1 1 auto', minWidth: 0, '& .MuiInputBase-input': { py: 0.5, px: 1, fontSize: '0.85rem' } }}
                      onChange={(event) => setChannels(channels.map((entry, j) => (j === i ? { ...entry, name: event.target.value } : entry)))}
                    />
                    <Chip
                      size="small"
                      color={active ? 'success' : 'default'}
                      label={active ? 'Active' : 'Unused'}
                      sx={{ minWidth: 64, flexShrink: 0 }}
                    />
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
          <FormControlLabel
            sx={{ mr: 0, alignSelf: 'flex-start' }}
            control={<Switch size="small" checked={form.enabled} onChange={(_, checked) => set('enabled', checked)} />}
            label="Save snapshots after transaction pulls"
          />
          <Typography variant="body2" color="text.secondary">
            Clock offset is added to the gate&apos;s transaction time to match the recorder&apos;s clock. Look back limits which transactions get
            snapshots (recorders keep only so many days). Leave the password blank to keep the saved one.
          </Typography>
          {video && (
            <Typography variant="body2" color="text.secondary">
              Videos run from the start of the transaction&apos;s minute for 2 minutes, at the recorder&apos;s full quality without re-encoding (about
              65 MB per channel for a 4 Mbit/s camera). The recorder sends them at normal playback speed, so each video takes about 2 minutes
              to fetch, one at a time. H.265 cameras need a browser that plays H.265 (current Safari, and Chrome or Edge on most computers
              with hardware support).
            </Typography>
          )}
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <Button variant="contained" onClick={save}>Save camera settings</Button>
            <Button variant="outlined" onClick={test} disabled={!settings || testing}>Test (live picture)</Button>
            <Button variant="outlined" color="inherit" onClick={remove} disabled={!settings}>Remove</Button>
            <Button variant="outlined" color="error" onClick={deleteSnaps}>Delete all pictures</Button>
            {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
          {live && (
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {live.frames.map((frame) => (frame.file ? (
                <figure key={frame.channel} className="snap-figure">
                  <img src={`${gateUrl(phone, `/snapshots/live/${frame.file}`)}?t=${live.stamp}`} alt={frame.name || `Channel ${frame.channel}`} style={{ maxWidth: 320 }} />
                  <figcaption>{frame.name || `Channel ${frame.channel}`} (channel {frame.channel})</figcaption>
                </figure>
              ) : (
                <Alert key={frame.channel} severity="error">Channel {frame.channel}: {frame.error}</Alert>
              )))}
            </Stack>
          )}
    </Stack>
  );
}
