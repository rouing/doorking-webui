import { useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { ConflictView, ResidentsReply, SendPreview } from '../../../src/types.ts';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';

interface ConflictListProps {
  conflicts: ConflictView[];
  gapi: GateApi;
  onDecided: () => Promise<void> | void;
}

/**
 * Items changed differently at the gate and in the working copy, each with Keep mine / Take the gate's (admins).
 * Sending waits until every one is decided.
 *
 * @param props - Component props.
 * @param props.conflicts - Conflicts.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onDecided - On decided.
 * @returns Rendered React element.
 */
export function ConflictList({ conflicts, gapi, onDecided }: ConflictListProps) {
  const readOnly = useReadOnly();
  const [error, setError] = useState('');
  if (!conflicts.length) return null;
  const decide = async (conflict: ConflictView, choice: 'mine' | 'gate') => {
    try {
      await gapi('POST', '/working-copy/conflicts', { kind: conflict.kind, key: conflict.key, choice });
      setError('');
      await onDecided();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Alert severity="error" role="alert">
      <Stack spacing={1}>
        <Typography variant="body2">
          <strong>{conflicts.length} change{conflicts.length === 1 ? '' : 's'} to decide before sending.</strong> Since your last pull,
          these were changed at the gate and differently here. Your change is kept until you choose.
        </Typography>
        {conflicts.map((conflict) => (
          <Stack key={`${conflict.kind}-${conflict.key}`} direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2">
              <strong>{conflict.label}</strong>: at the gate {conflict.gate}; yours {conflict.mine}
            </Typography>
            {!readOnly && (
              <Button size="small" variant="outlined" onClick={() => decide(conflict, 'mine')}>Keep mine</Button>
            )}
            {!readOnly && (
              <Button size="small" variant="outlined" color="inherit" onClick={() => decide(conflict, 'gate')}>Take the gate&apos;s</Button>
            )}
          </Stack>
        ))}
        {error && <Alert severity="error" sx={{ py: 0 }}>{error}</Alert>}
      </Stack>
    </Alert>
  );
}

/** The working copy's state: a label and colour for it, whether it has unsent changes, and its conflicts. */
export interface WorkingCopyState {
  edited: boolean;
  conflicts: ConflictView[];
  label: string;
  color: 'gray' | 'red' | 'amber' | 'green';
}

/**
 * Working copy state.
 *
 * @param cache - `ResidentsReply['cache'] | null` value.
 * @returns `WorkingCopyState` result.
 */
export function workingCopyState(cache: ResidentsReply['cache'] | null): WorkingCopyState {
  const edited = Boolean(cache && cache.edited);
  const conflicts = cache ? cache.conflicts : [];
  const [label, color] = !cache ? ['no working copy', 'gray'] as const
    : conflicts.length ? [`${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} to decide`, 'red'] as const
      : edited ? ['changes not sent to the gate', 'amber'] as const : ['matches the gate', 'green'] as const;
  return { edited, conflicts, label, color };
}

export interface WorkingCopyActionsOptions {
  gapi: GateApi;
  onReload: () => Promise<void> | void; // after a reset
  onJobStarted: () => void; // after a send started
  notify: (text: string) => void; // progress and success
  onError: (text: string) => void;
  sendLines?: string[]; // more lines for the send confirmation
}

/**
 * Reset to gate (drops the unsent changes) and Send to gate (then a residents pull checks the gate holds it), each
 * after a confirmation. Render `dialog` once.
 *
 * @param options - Options object.
 * @param options.gapi - Gate-scoped API fetch helper.
 * @param options.onReload - Callback to reload the gate data.
 * @param options.onJobStarted - On job started.
 * @param options.notify - Notify.
 * @param options.onError - On error.
 * @param [options.sendLines] - Send lines.
 * @returns Operation result.
 */
export function useWorkingCopyActions({ gapi, onReload, onJobStarted, notify, onError, sendLines = [] }: WorkingCopyActionsOptions) {
  const [dialog, confirm] = useConfirm();
  async function reset() {
    if (!await confirm({
      title: 'Reset to gate?', action: 'Reset', color: 'red',
      body: 'Throw away every change not sent to the gate (on every page), so the working copy matches what the gate holds (as of the last pull)?',
    })) return;
    notify('Resetting…');
    try {
      await gapi('DELETE', '/working-copy');
      await onReload();
      notify('Working copy reset to the gate.');
    } catch (err) { onError(errorText(err)); }
  }
  async function send() {
    let preview: SendPreview;
    try { preview = await gapi<SendPreview>('GET', '/send'); } catch (err) { onError(errorText(err)); return; }
    if (!await confirm({
      title: 'Send the working copy to the gate?', action: 'Send to gate', maxWidth: '680px',
      body: <SendSummary preview={preview} lines={sendLines} />,
    })) return;
    try {
      await gapi('POST', '/send', { confirm: true });
      notify('Sending to the gate; see the progress window.');
      onJobStarted();
    } catch (err) { onError(errorText(err)); }
  }
  return { dialog, reset, send };
}

export interface GateActionsOptions {
  gapi: GateApi;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  running: boolean; // a gate connection is running
  onReset: () => Promise<void> | void;
  onJobStarted: () => void;
  onNotify: (text: string) => void; // progress, success and errors
}

const SEND_NOTE = 'Only changes saved to the working copy are sent; unsaved edits on a page stay there.';

/**
 * Send to gate and Reset to gate for the sidebar's gate connection and the phone's Gate sheet: the actions, and when
 * each is unavailable (canSend, canReset; sendHint says why Send can't run).
 *
 * @param options - Options object.
 * @param options.gapi - Gate-scoped API fetch helper.
 * @param options.workingCopy - Working copy.
 * @param options.hasWorkingCopy - Has working copy.
 * @param options.running - Running.
 * @param options.onReset - On reset.
 * @param options.onJobStarted - On job started.
 * @param options.onNotify - On notify.
 * @returns Operation result.
 */
export function useGateActions({ gapi, workingCopy, hasWorkingCopy, running, onReset, onJobStarted, onNotify }: GateActionsOptions) {
  const actions = useWorkingCopyActions({ gapi, onReload: onReset, onJobStarted, notify: onNotify, onError: onNotify, sendLines: [SEND_NOTE] });
  const conflicts = workingCopy.conflicts.length > 0;
  return {
    ...actions,
    canSend: !running && workingCopy.edited && !conflicts,
    canReset: !running && hasWorkingCopy,
    sendHint: conflicts ? 'Decide the conflicts first' : workingCopy.edited ? undefined : 'Nothing to send: the working copy matches the gate',
  };
}

interface SendSummaryProps { preview: SendPreview; lines: string[] }

/**
 * What a send changes, for its confirmation dialog: human-readable From -> To changes plus changed block summary.
 *
 * @param props - Component props.
 * @param props.preview - Preview returned by `GET /send`.
 * @param props.lines - Extra informational lines.
 * @returns Rendered React element.
 */
function SendSummary({ preview, lines }: SendSummaryProps) {
  const blocks = Object.entries(preview.changedBlocks).filter(([, changed]) => changed.length);
  const changes = preview.changes || [];
  return (
    <Stack spacing={1.5}>
      <Typography variant="body1">This changes the physical gate.</Typography>
      {lines.map((line) => <Typography key={line} variant="body2" color="text.secondary">{line}</Typography>)}
      {changes.length > 0 && (
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 280 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell>
                <TableCell>Field</TableCell>
                <TableCell>Gate</TableCell>
                <TableCell>New</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {changes.flatMap((item) => (item.fields.length ? item.fields : [{ field: '', from: '', to: '' }]).map((field, index) => (
                <TableRow key={`${item.key}-${field.field}-${index}`}>
                  <TableCell>
                    {index === 0 && (
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>{item.label}</Typography>
                        {item.change !== 'changed' && (
                          <Chip size="small" label={item.change} color={item.change === 'added' ? 'success' : 'error'} />
                        )}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell>{field.field}</TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">{field.from || '—'}</Typography>
                  </TableCell>
                  <TableCell>{field.to || '—'}</TableCell>
                </TableRow>
              )))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Stack spacing={0.5}>
        {blocks.map(([file, changed]) => (
          <Typography key={file} variant="caption" color="text.secondary">{file}: block(s) {changed.join(', ')}</Typography>
        ))}
        <Typography variant="caption" color="text.secondary">
          Resident / vendor counts (from names.bin): {preview.residentCounts.join(', ')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          A residents pull runs afterwards to verify the gate holds these changes.
        </Typography>
      </Stack>
    </Stack>
  );
}

interface WorkingCopyBarProps {
  cache: ResidentsReply['cache'] | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
}

/**
 * The working copy's conflicts, on the Residents and Vendors pages. Its state, Reset to gate and Send to gate are in
 * the sidebar (phones: the top bar and the Gate tab, GateApp).
 *
 * @param props - Component props.
 * @param props.cache - Cache.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReload - Callback to reload the gate data.
 * @returns Rendered React element.
 */
export function WorkingCopyBar({ cache, gapi, onReload }: WorkingCopyBarProps) {
  return <ConflictList conflicts={workingCopyState(cache).conflicts} gapi={gapi} onDecided={onReload} />;
}
