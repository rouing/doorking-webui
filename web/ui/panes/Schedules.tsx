import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Checkbox,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { Schedule, ScheduleAction, SchedulesReply } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import { SCHEDULE_ACTIONS } from '../../../src/shared.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface SchedulesProps {
  gapi: GateApi;
  video: boolean;
}

/**
 * This gate's scheduled transfers (days 0-6 = Sun-Sat, 24-hour time), run by the server with the gate's DKS login.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.video - Clip duration in seconds (`0` for a single still frame).
 * @returns Rendered React element.
 */
export function Schedules({ gapi, video }: SchedulesProps) {
  const NAMES: Record<ScheduleAction, string> = { send: 'Send to gate', residents: 'Pull residents', transactions: 'Pull transactions',
    snapshots: video ? 'Camera videos' : 'Camera snapshots' };
  const LABELS: Record<ScheduleAction, string> = { send: 'Send working copy to gate', residents: 'Pull residents',
    transactions: 'Pull transactions', snapshots: video ? 'Get camera videos' : 'Get camera snapshots' };
  const [list, setList] = useState<SchedulesReply | null>(null);
  const [info, setInfo] = useState('Loading…');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null); // id in the form, or null when adding
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [time, setTime] = useState('02:00');
  const [actions, setActions] = useState<ScheduleAction[]>(['transactions']);
  const [enabled, setEnabled] = useState(true);
  const [formInfo, setFormInfo] = useState('');
  const [formError, setFormError] = useState('');
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    setError('');
    try {
      const reply = await gapi<SchedulesReply>('GET', '/schedules');
      setList(reply);
      setInfo(`${reply.schedules.length} schedule${reply.schedules.length === 1 ? '' : 's'}`);
    } catch (err) {
      setInfo('');
      setError(errorText(err));
    }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  const fill = (schedule: Schedule | null) => {
    setEditing(schedule ? schedule.id : null);
    setDays(schedule ? schedule.days : [0, 1, 2, 3, 4, 5, 6]);
    setTime(schedule ? schedule.time : '02:00');
    setActions(schedule ? schedule.actions : ['transactions']);
    setEnabled(schedule ? schedule.enabled : true);
    setFormInfo('');
    setFormError('');
  };
  const toggle = <T,>(items: T[], item: T, on: boolean) => (on ? [...items.filter((other) => other !== item), item] : items.filter((other) => other !== item));

  async function save() {
    const body = { days: [...days].sort((a, b) => a - b), time, actions: SCHEDULE_ACTIONS.filter((action) => actions.includes(action)), enabled };
    if (body.actions.includes('send') && !await confirm({
      title: 'Save this schedule?', action: 'Save',
      body: 'This schedule sends the working copy to the gate without asking.',
    })) return;
    setFormError('');
    setFormInfo('Saving…');
    try {
      await (editing ? gapi('PUT', `/schedules/${encodeURIComponent(editing)}`, body) : gapi('POST', '/schedules', body));
      fill(null);
      setFormInfo('Saved. It runs with the gate\'s DKS login.');
      await load();
    } catch (err) {
      setFormInfo('');
      setFormError(`Save failed: ${errorText(err)}`);
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); } catch (err) { setError(errorText(err)); }
  };
  const runNow = (schedule: Schedule) => act(async () => {
    await gapi('POST', `/schedules/${encodeURIComponent(schedule.id)}/run`, {});
    await load();
    setInfo('Queued. Progress shows under Gate connection.');
  });
  const remove = (schedule: Schedule) => act(async () => {
    if (!await confirm({ title: 'Delete this schedule?', action: 'Delete', color: 'red' })) return;
    await gapi('DELETE', `/schedules/${encodeURIComponent(schedule.id)}`);
    if (editing === schedule.id) fill(null);
    await load();
  });

  return (
    <Stack spacing={2}>
      {dialog}
      <Typography variant="h5">Scheduled Transfers</Typography>
      <Typography variant="body2" color="text.secondary">
        The server runs these at the set days and time (the server&apos;s local time), even when no one is signed in. They use the
        gate&apos;s DKS login (System Settings → Gate login). A time missed while the server was stopped runs once when it starts. Send to gate runs
        only when the working copy has changes, and runs before the pulls.
      </Typography>
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">{editing ? 'Edit schedule' : 'Add a schedule'}</Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 500, mr: 0.5 }}>Days:</Typography>
              {DAYS.map((day, i) => (
                <FormControlLabel
                  key={day}
                  control={<Checkbox size="small" checked={days.includes(i)} onChange={(event) => setDays(toggle(days, i, event.target.checked))} />}
                  label={<Typography variant="body2">{day}</Typography>}
                />
              ))}
            </Stack>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>Time</Typography>
              <TextField
                size="small"
                type="time"
                value={time}
                slotProps={{ htmlInput: { 'aria-label': 'Schedule time' } }}
                onChange={(event) => setTime(event.target.value)}
              />
              <Typography variant="body2" sx={{ fontWeight: 500 }}>Transfers:</Typography>
              {SCHEDULE_ACTIONS.map((action) => (
                <FormControlLabel
                  key={action}
                  control={<Switch size="small" checked={actions.includes(action)} onChange={(event) => setActions(toggle(actions, action, event.target.checked))} />}
                  label={<Typography variant="body2">{LABELS[action]}</Typography>}
                />
              ))}
              <FormControlLabel
                control={<Switch size="small" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />}
                label={<Typography variant="body2">Enabled</Typography>}
              />
            </Stack>
            {formError && <Alert severity="error">{formError}</Alert>}
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="contained" onClick={save}>Save schedule</Button>
              {editing && <Button variant="outlined" color="inherit" onClick={() => fill(null)}>Cancel edit</Button>}
              {formInfo && <Typography variant="body2" color="text.secondary">{formInfo}</Typography>}
            </Stack>
          </Stack>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>Schedules for this gate</Typography>
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}>
            <Button variant="outlined" color="inherit" onClick={load}>Refresh</Button>
            {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          </Stack>
          {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['Days', 'Time', 'Transfers', 'Enabled', 'Saved by', 'Next run', 'Last run', 'Last result', ''].map((header, i) => (
                    <TableCell key={i}>{header}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {(list?.schedules || []).map((schedule) => {
                  const result = schedule.queued ? 'Queued' : schedule.lastResult === 'failed' ? `Failed: ${schedule.lastError || ''}`
                    : schedule.lastResult === 'done' ? `OK${schedule.lastError ? ` — ${schedule.lastError}` : ''}` : '';
                  return (
                    <TableRow
                      key={schedule.id}
                      sx={{
                        bgcolor: schedule.lastResult === 'failed' && !schedule.queued ? (theme) => alpha(theme.palette.error.main, 0.12) : undefined,
                        color: schedule.enabled ? undefined : 'text.secondary',
                      }}
                    >
                      <TableCell>{schedule.days.length === 7 ? 'Every day' : schedule.days.map((day) => DAYS[day]).join(', ')}</TableCell>
                      <TableCell>{schedule.time}</TableCell>
                      <TableCell>{schedule.actions.map((action) => NAMES[action]).join(', ')}</TableCell>
                      <TableCell>{schedule.enabled ? 'Yes' : 'No'}</TableCell>
                      <TableCell>{schedule.user}</TableCell>
                      <TableCell>{fmtTime(schedule.nextRun)}</TableCell>
                      <TableCell>{fmtTime(schedule.lastRun)}</TableCell>
                      <TableCell>{result}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          <Button size="small" variant="outlined" color="inherit" onClick={() => fill(schedule)}>Edit</Button>
                          <Button size="small" variant="outlined" color="inherit" onClick={() => runNow(schedule)}>Run now</Button>
                          <Button size="small" variant="outlined" color="error" onClick={() => remove(schedule)}>Delete</Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Stack>
  );
}
