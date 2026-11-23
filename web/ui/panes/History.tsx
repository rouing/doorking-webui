import { useCallback, useEffect, useState } from 'react';
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
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
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
import { alpha } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { HistoryEvent, HistoryReply, PullArchiveEntry, SendChange } from '../../../src/types.ts';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import { roleLabel } from '../Gates.tsx';

export const ACTIONS: Record<string, string> = {
  change: 'Change', revert: 'Revert', pull: 'Pull', send: 'Send', relay: 'Relay', camera: 'Camera',
  access: 'Users', login: 'Gate login', apikey: 'API key', webhook: 'Webhook', note: 'Note',
};

const EVENTS_PAGE = 20;

interface HistoryProps {
  gapi: GateApi;
  onReverted: () => void;
}

/**
 * The gate's users, events (newest first), and archived pulls rendered as compact pill-driven bubble cards.
 * Events with change details expand inline on click; Revert sits on the right and undoes in the working copy only.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function History({ gapi, onReverted }: HistoryProps) {
  const readOnly = useReadOnly();
  const [history, setHistory] = useState<HistoryReply | null>(null);
  const [pulls, setPulls] = useState<PullArchiveEntry[]>([]);
  const [diffView, setDiffView] = useState<{ pull: PullArchiveEntry; changes: SendChange[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(EVENTS_PAGE);
  const [info, setInfo] = useState('Loading…');
  const [error, setError] = useState('');
  const [dialog, confirm] = useConfirm();

  useBackLayer(diffView !== null, () => setDiffView(null));

  const load = useCallback(async () => {
    setInfo('Loading…');
    setError('');
    try {
      const [reply, archive] = await Promise.all([
        gapi<HistoryReply>('GET', '/history'),
        gapi<{ pulls: PullArchiveEntry[] }>('GET', '/pull-archive').catch(() => ({ pulls: [] })),
      ]);
      setHistory(reply);
      setPulls(archive.pulls);
      setShown(EVENTS_PAGE);
      setInfo(`${reply.events.length} event${reply.events.length === 1 ? '' : 's'}, most recent first`);
    } catch (err) {
      setInfo('');
      setError(errorText(err));
    }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  async function previewPull(pull: PullArchiveEntry) {
    setError('');
    try {
      const reply = await gapi<{ pull: PullArchiveEntry; changes: SendChange[] }>('GET', `/pull-archive/${pull.id}/diff`);
      setDiffView(reply);
    } catch (err) { setError(errorText(err)); }
  }

  async function restorePull(pull: PullArchiveEntry) {
    if (!await confirm({
      title: `Restore pull from ${fmtTime(pull.pulledAt)}?`, action: 'Restore to working copy', color: 'red',
      body: 'This replaces the working copy with this archived pull. The physical gate is not changed until you Send to gate, and this restore can be reverted in History.',
    })) return;
    setError('');
    try {
      await gapi('POST', `/pull-archive/${pull.id}/restore`, {});
      setDiffView(null);
      await load();
      setInfo(`Restored pull #${pull.id} into the working copy. Review it, then Send to gate.`);
      onReverted();
    } catch (err) { setError(errorText(err)); }
  }

  async function revert(event: HistoryEvent) {
    if (!await confirm({
      title: `Revert "${event.summary}"?`, action: 'Revert',
      body: 'This undoes the change in the working copy. The gate is not changed until you Send to gate.',
    })) return;
    setError('');
    try {
      await gapi('POST', `/history/${encodeURIComponent(event.id)}/revert`, {});
      await load();
      setInfo('Reverted in the working copy. Review it, then Send to gate.');
      onReverted();
    } catch (err) { setError(errorText(err)); }
  }

  const users = history?.users || [];
  const events = history?.events || [];
  const visibleEvents = events.slice(0, shown);

  return (
    <Stack spacing={2}>
      {dialog}
      <Typography variant="h5" component="h1">History</Typography>
      <Typography variant="body2" color="text.secondary">
        Pulls, sends, live relay changes and working-copy changes for this gate. Tap an event with changes to inspect
        details. <strong>Revert</strong> undoes a change in the working copy only; review it, then use Send to gate.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}

      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', pr: 1 }}>
            <Typography variant="h6" component="h2">Gate users</Typography>
            <Chip size="small" label={`${users.length}`} />
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          {!users.length ? (
            <Typography variant="body2" color="text.secondary">No gate users.</Typography>
          ) : (
            <Stack spacing={1}>
              {users.map((user) => (
                <Paper key={user.username} elevation={0} sx={{ p: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{user.username}</Typography>
                      <Chip
                        size="small"
                        label={roleLabel(user.role)}
                        color={user.role === 'admin' ? 'primary' : user.role === 'editor' ? 'warning' : user.role === 'resident' ? 'success' : 'default'}
                      />
                    </Stack>
                    <Chip size="small" label={`Last sign-in: ${user.lastSignIn ? fmtTime(user.lastSignIn) : 'never'}`} />
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
        </AccordionDetails>
      </Accordion>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="h6" component="h2">Events</Typography>
                {info && <Chip size="small" label={info} />}
              </Stack>
              <Button size="small" variant="outlined" color="inherit" onClick={load}>Refresh</Button>
            </Stack>
            {!events.length ? (
              <Typography variant="body2" color="text.secondary">No history events yet.</Typography>
            ) : (
              <Stack spacing={1}>
                {visibleEvents.map((entry) => {
                  const details = entry.details || [];
                  const expanded = open === entry.id && details.length > 0;
                  const failed = entry.result === 'failed';
                  return (
                    <Paper
                      key={entry.id}
                      elevation={0}
                      onClick={details.length ? () => setOpen(expanded ? null : entry.id) : undefined}
                      sx={(theme) => ({
                        p: 1.5,
                        borderRadius: 2,
                        cursor: details.length ? 'pointer' : 'default',
                        bgcolor: failed ? alpha(theme.palette.error.main, 0.14) : theme.palette.action.hover,
                        opacity: entry.revertedBy ? 0.72 : 1,
                      })}
                    >
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                          <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                              {entry.summary || ACTIONS[entry.action] || entry.action}
                            </Typography>
                            <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                              <Chip size="small" color="primary" label={ACTIONS[entry.action] || entry.action} />
                              {entry.user && <Chip size="small" label={entry.user} />}
                              <Chip size="small" label={fmtTime(entry.time)} />
                              {entry.result === 'done' && <Chip size="small" color="success" label="OK" />}
                              {failed && <Chip size="small" color="error" label="Failed" />}
                              {entry.revertedBy && (
                                <Chip
                                  size="small"
                                  color="warning"
                                  label={`Reverted by ${entry.revertedBy.user}`}
                                  title={`${entry.revertedBy.user} · ${fmtTime(entry.revertedBy.time)}`}
                                />
                              )}
                              {details.length > 0 && (
                                <Chip size="small" label={expanded ? 'Hide changes' : `${details.length} detail${details.length === 1 ? '' : 's'}`} />
                              )}
                            </Stack>
                            {failed && entry.error && (
                              <Typography variant="caption" color="error.main">{entry.error}</Typography>
                            )}
                          </Stack>
                          {!entry.revertedBy && entry.revertible && !readOnly && (
                            <Box sx={{ flexShrink: 0, ml: 'auto' }}>
                              <Button
                                size="small"
                                variant="outlined"
                                onClick={(event) => { event.stopPropagation(); revert(entry); }}
                              >
                                Revert
                              </Button>
                            </Box>
                          )}
                        </Stack>
                        {expanded && (
                          <>
                            <Divider />
                            <Stack spacing={1}>
                              {details.map((detail) => (
                                <Paper key={detail.key + detail.label} elevation={0} sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'background.paper' }}>
                                  <Stack spacing={0.75}>
                                    <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{detail.label}</Typography>
                                      {detail.change && detail.change !== 'changed' && (
                                        <Chip size="small" color={detail.change === 'added' ? 'success' : 'error'} label={detail.change} />
                                      )}
                                    </Stack>
                                    {detail.fields.length > 0 && (
                                      <Stack spacing={0.5}>
                                        {detail.fields.map((field, i) => (
                                          <Typography key={i} variant="caption" color="text.secondary">
                                            <strong>{field.field}:</strong> {field.from || '—'} → <strong>{field.to || '—'}</strong>
                                          </Typography>
                                        ))}
                                      </Stack>
                                    )}
                                  </Stack>
                                </Paper>
                              ))}
                            </Stack>
                          </>
                        )}
                      </Stack>
                    </Paper>
                  );
                })}
                {events.length > shown && (
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', pt: 0.5 }}>
                    <Button size="small" variant="outlined" onClick={() => setShown((n) => n + EVENTS_PAGE)}>
                      Show {Math.min(EVENTS_PAGE, events.length - shown)} more
                    </Button>
                    <Typography variant="caption" color="text.secondary">
                      Showing {shown} of {events.length}
                    </Typography>
                  </Stack>
                )}
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>

      {pulls.length > 0 && (
        <Accordion variant="outlined" disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', pr: 1 }}>
              <Typography variant="h6" component="h2">Past pulls (point-in-time rollback)</Typography>
              <Chip size="small" label={`${pulls.length}`} />
            </Stack>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 0 }}>
            <Stack spacing={1.5}>
              <Typography variant="body2" color="text.secondary">
                Up to 50 distinct residents pulls are archived per gate. Compare any past pull against your current working
                copy, or restore it to the working copy (nothing touches the gate until Send to gate).
              </Typography>
              <Stack spacing={1}>
                {pulls.map((pull) => (
                  <Paper key={pull.id} elevation={0} sx={{ p: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}>
                    <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Chip size="small" label={fmtTime(pull.pulledAt)} />
                        <Chip size="small" label={pull.actor} />
                        <Chip size="small" label={`${pull.residentsCount} entries`} />
                        <Chip size="small" label={`${pull.cardsCount} cards`} />
                      </Stack>
                      <Stack direction="row" spacing={1} sx={{ flexShrink: 0, ml: 'auto' }}>
                        <Button size="small" variant="outlined" color="inherit" onClick={() => previewPull(pull)}>Compare</Button>
                        {!readOnly && <Button size="small" variant="outlined" onClick={() => restorePull(pull)}>Restore</Button>}
                      </Stack>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}

      <Dialog open={diffView !== null} onClose={() => setDiffView(null)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
          <span>{diffView ? `Changes to restore pull from ${fmtTime(diffView.pull.pulledAt)}` : ''}</span>
          <IconButton size="small" aria-label="Close" onClick={() => setDiffView(null)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {diffView && (diffView.changes.length === 0 ? (
            <Typography variant="body2" color="text.secondary">The working copy already matches this pull.</Typography>
          ) : (
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 380 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Item</TableCell>
                    <TableCell>Field</TableCell>
                    <TableCell>Current</TableCell>
                    <TableCell>Archived</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {diffView.changes.flatMap((item) => (item.fields.length ? item.fields : [{ field: '', from: '', to: '' }]).map((field, index) => (
                    <TableRow key={`${item.key}-${field.field}-${index}`}>
                      <TableCell>
                        {index === 0 && (
                          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>{item.label}</Typography>
                            {item.change !== 'changed' && (
                              <Chip size="small" color={item.change === 'added' ? 'success' : 'error'} label={item.change} />
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
          ))}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button color="inherit" onClick={() => setDiffView(null)}>Close</Button>
          {diffView && !readOnly && diffView.changes.length > 0 && (
            <Button variant="contained" color="error" onClick={() => restorePull(diffView.pull)}>
              Restore to working copy
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
