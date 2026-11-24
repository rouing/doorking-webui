/**
 * @module web/ui/portal/PortalActivityTab
 *
 * Resident Portal "Activity" tab: own-unit gate events, suspicious-activity reporting dialog,
 * and multi-file camera snapshot/video viewer backed by actual saved `row.snapshotFiles`.
 */
import { useState, type FormEvent } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, Divider, IconButton, Skeleton, Stack, TextField, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FlagIcon from '@mui/icons-material/Flag';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import RefreshIcon from '@mui/icons-material/Refresh';
import VideocamIcon from '@mui/icons-material/Videocam';
import type { PortalActivityReply, TransactionRow } from '../types.ts';
import { posterFile } from '../lib/shared.ts';
import { useBackLayer } from '../back.ts';
import { portalUrl } from './usePortalData.ts';

interface PortalActivityTabProps {
  gatePhone: string;
  unitCode: string;
  activity: PortalActivityReply | null;
  loading: boolean;
  offline: boolean;
  reporting: boolean;
  onRefresh: () => void;
  onSubmitReport: (row: TransactionRow, note: string) => Promise<boolean>;
}

const isVideoFile = (file: string) => file.endsWith('.mp4');

export function PortalActivityTab({
  gatePhone, unitCode, activity, loading, offline, reporting, onRefresh, onSubmitReport,
}: PortalActivityTabProps) {
  const [reportRow, setReportRow] = useState<TransactionRow | null>(null);
  const [reportNote, setReportNote] = useState('');
  const [snapRow, setSnapRow] = useState<TransactionRow | null>(null);
  const [activeFile, setActiveFile] = useState('');

  useBackLayer(reportRow !== null, () => { if (!reporting) setReportRow(null); });
  useBackLayer(snapRow !== null, () => setSnapRow(null));

  const openSnapshots = (row: TransactionRow) => {
    const files = row.snapshotFiles && row.snapshotFiles.length ? row.snapshotFiles : [];
    setSnapRow(row);
    setActiveFile(files[0] || '');
  };

  const handleReportSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reportRow) return;
    if (await onSubmitReport(reportRow, reportNote)) {
      setReportRow(null);
      setReportNote('');
    }
  };

  const snapFiles = snapRow?.snapshotFiles || [];
  const fileUrl = (minute: string, file: string) =>
    portalUrl(gatePhone, `/snapshots/${minute}/${encodeURIComponent(file)}?code=${encodeURIComponent(unitCode)}`);

  return (
    <>
      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="h6" component="h2">Recent Activity</Typography>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={offline || loading}
                startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
                onClick={onRefresh}
              >
                Refresh
              </Button>
            </Stack>
            {loading && !activity ? (
              <Stack spacing={1}>
                <Skeleton variant="rounded" height={56} />
                <Skeleton variant="rounded" height={56} />
              </Stack>
            ) : !activity || !activity.rows.length ? (
              <Typography variant="body2" color="text.secondary">
                No recent gate activity recorded for your unit yet.
              </Typography>
            ) : (
              <Stack spacing={1.25} divider={<Divider flexItem />}>
                {activity.rows.map((row) => {
                  const files = row.snapshotFiles || [];
                  const hasVideo = files.some(isVideoFile);
                  return (
                    <Box key={`${row.source || 'gate'}-${row.txKey || row.ts}`} sx={{ pt: 0.5 }}>
                      <Stack spacing={0.75}>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            {row.source === 'portal' ? (
                              <Chip size="small" color="primary" label="Portal Open" />
                            ) : (
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {row.eventType}{row.number ? ` #${row.number}` : ''}
                              </Typography>
                            )}
                            <Chip size="small" color={row.access === 'Admit' ? 'success' : 'error'} label={row.access} />
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            {row.date} · {row.time}
                          </Typography>
                        </Stack>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                          <Typography variant="caption" color="text.secondary">{row.relay || ''}</Typography>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            {activity.showSnapshots && files.length > 0 && (
                              <Button
                                size="small"
                                variant="text"
                                startIcon={hasVideo ? <VideocamIcon fontSize="small" /> : <PhotoCameraIcon fontSize="small" />}
                                onClick={() => openSnapshots(row)}
                              >
                                {hasVideo ? 'Video' : 'Photo'}
                              </Button>
                            )}
                            {row.reported ? (
                              <Chip size="small" color="error" variant="outlined" label="Reported" />
                            ) : (
                              <Button
                                size="small"
                                variant="text"
                                color="error"
                                disabled={offline}
                                startIcon={<FlagIcon fontSize="small" />}
                                onClick={() => { setReportRow(row); setReportNote(''); }}
                              >
                                Report suspicious
                              </Button>
                            )}
                          </Stack>
                        </Stack>
                      </Stack>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={reportRow !== null} onClose={() => { if (!reporting) setReportRow(null); }} maxWidth="xs" fullWidth>
        <form onSubmit={handleReportSubmit} autoComplete="off">
          <DialogTitle>Report suspicious activity</DialogTitle>
          <DialogContent>
            {reportRow && (
              <DialogContentText sx={{ mb: 2 }}>
                Flagging <strong>{reportRow.eventType} ({reportRow.access})</strong> on {reportRow.date} at {reportRow.time}.
                Community administrators will be alerted immediately.
              </DialogContentText>
            )}
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={3}
              size="small"
              label="Optional note"
              placeholder="e.g., I was out of town, lost remote, unknown visitor"
              value={reportNote}
              onChange={(event) => setReportNote(event.target.value)}
            />
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button color="inherit" disabled={reporting} onClick={() => setReportRow(null)}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              color="error"
              disabled={reporting || offline}
              startIcon={reporting ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              Alert administrators
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={snapRow !== null} onClose={() => setSnapRow(null)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, pr: 1.5 }}>
          <span>Gate camera footage ({snapRow?.minute})</span>
          <IconButton aria-label="Close snapshot viewer" onClick={() => setSnapRow(null)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 1.5 }}>
            Camera footage captured near this gate event.
          </DialogContentText>
          {snapRow && snapFiles.length === 0 ? (
            <Alert severity="info">No camera snapshot or video clip is available for this event.</Alert>
          ) : snapRow && activeFile ? (
            <Stack spacing={1.5}>
              {snapFiles.length > 1 && (
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {snapFiles.map((file) => (
                    <Button
                      key={file}
                      size="small"
                      variant={activeFile === file ? 'contained' : 'outlined'}
                      startIcon={isVideoFile(file) ? <VideocamIcon fontSize="small" /> : <PhotoCameraIcon fontSize="small" />}
                      onClick={() => setActiveFile(file)}
                    >
                      {file.replace(/\.(jpg|mp4)$/i, '').toUpperCase()}
                    </Button>
                  ))}
                </Stack>
              )}
              {isVideoFile(activeFile) ? (
                <Box
                  component="video"
                  key={activeFile}
                  src={fileUrl(snapRow.minute, activeFile)}
                  poster={fileUrl(snapRow.minute, posterFile(activeFile))}
                  controls
                  playsInline
                  sx={{ width: '100%', borderRadius: 1.5, display: 'block', bgcolor: '#000' }}
                />
              ) : (
                <Box
                  component="img"
                  key={activeFile}
                  src={fileUrl(snapRow.minute, activeFile)}
                  alt={`Gate snapshot ${snapRow.minute} (${activeFile})`}
                  sx={{ width: '100%', borderRadius: 1.5, display: 'block', bgcolor: '#000' }}
                />
              )}
            </Stack>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
