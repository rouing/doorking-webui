/**
 * @module web/ui/portal/PortalRequestsTab
 *
 * Resident Portal "Requests" tab: self-service change request form and request history.
 */
import { useState, type FormEvent } from 'react';
import {
  Box, Button, Card, CardContent, Chip, CircularProgress, Divider, FormControl, InputLabel, MenuItem,
  Select, Skeleton, Stack, TextField, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { PortalMeReply, ResidentRequest } from '../types.ts';
import { fmtPhone, parseNanpPhone } from '../lib/shared.ts';
import { fmtTime } from '../format.ts';

type RequestKind = ResidentRequest['kind'];

const REQUEST_KIND_LABELS: Record<RequestKind, string> = {
  phone: 'Phone update',
  hidden: 'Directory listing',
  cardIssue: 'Lost remote / card',
  other: 'Other',
};

interface PortalRequestsTabProps {
  me: PortalMeReply | null;
  loadingMe: boolean;
  requests: ResidentRequest[];
  loadingRequests: boolean;
  offline: boolean;
  submitting: boolean;
  onRefresh: () => void;
  onSubmit: (input: { kind: RequestKind; phone: string; note: string }) => Promise<boolean>;
}

export function PortalRequestsTab({
  me, loadingMe, requests, loadingRequests, offline, submitting, onRefresh, onSubmit,
}: PortalRequestsTabProps) {
  const [reqKind, setReqKind] = useState<RequestKind>('phone');
  const [reqPhone, setReqPhone] = useState('');
  const [reqPhoneError, setReqPhoneError] = useState('');
  const [reqNote, setReqNote] = useState('');

  if (loadingMe && !me) {
    return (
      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Skeleton variant="text" width="45%" height={30} />
            <Skeleton variant="rounded" height={40} />
            <Skeleton variant="rounded" height={80} />
          </Stack>
        </CardContent>
      </Card>
    );
  }
  if (!me) return null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (reqKind === 'phone' && !parseNanpPhone(reqPhone)) {
      setReqPhoneError('Enter a valid 7- or 10-digit phone number (e.g. (214) 555-0100).');
      return;
    }
    setReqPhoneError('');
    if (await onSubmit({ kind: reqKind, phone: reqPhone.trim(), note: reqNote.trim() })) {
      setReqPhone('');
      setReqNote('');
    }
  };

  return (
    <Stack spacing={2}>
      {me.portal.allowRequests ? (
        <Card>
          <CardContent>
            <form onSubmit={handleSubmit} autoComplete="off">
              <Stack spacing={2}>
                <Typography variant="h6" component="h2">Request a Change</Typography>
                <FormControl size="small" fullWidth>
                  <InputLabel id="portal-request-kind-label">What do you need?</InputLabel>
                  <Select
                    labelId="portal-request-kind-label"
                    label="What do you need?"
                    value={reqKind}
                    onChange={(event) => {
                      setReqKind(event.target.value as RequestKind);
                      setReqPhoneError('');
                    }}
                  >
                    <MenuItem value="phone">{REQUEST_KIND_LABELS.phone}</MenuItem>
                    <MenuItem value="hidden">{REQUEST_KIND_LABELS.hidden}</MenuItem>
                    <MenuItem value="cardIssue">{REQUEST_KIND_LABELS.cardIssue}</MenuItem>
                    <MenuItem value="other">{REQUEST_KIND_LABELS.other}</MenuItem>
                  </Select>
                </FormControl>

                {reqKind === 'phone' && (
                  <TextField
                    size="small"
                    fullWidth
                    type="tel"
                    label="New call-box phone number"
                    placeholder="(214) 555-0100"
                    value={reqPhone}
                    required
                    error={Boolean(reqPhoneError)}
                    helperText={reqPhoneError || 'Enter a 7- or 10-digit phone number.'}
                    slotProps={{ htmlInput: { inputMode: 'tel' } }}
                    onChange={(event) => {
                      setReqPhone(event.target.value);
                      if (reqPhoneError) setReqPhoneError('');
                    }}
                  />
                )}

                <TextField
                  size="small"
                  fullWidth
                  multiline
                  minRows={2}
                  label="Details for management (optional)"
                  value={reqNote}
                  onChange={(event) => setReqNote(event.target.value)}
                />

                <Box>
                  <Button
                    type="submit"
                    variant="contained"
                    disabled={offline || submitting}
                    startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : undefined}
                  >
                    Send request to management
                  </Button>
                </Box>
              </Stack>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="h6" component="h2">Change Requests</Typography>
              <Typography variant="body2" color="text.secondary">
                Online change requests are currently turned off for this community.
                {me.gate.adminPhone ? ` Contact management at ${fmtPhone(me.gate.adminPhone)} for updates.` : ' Contact management directly for updates.'}
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="h6" component="h2">Your Past Requests</Typography>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={offline || loadingRequests}
                startIcon={loadingRequests ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
                onClick={onRefresh}
              >
                Refresh
              </Button>
            </Stack>
            {loadingRequests && !requests.length ? (
              <Stack spacing={1}>
                <Skeleton variant="rounded" height={48} />
                <Skeleton variant="rounded" height={48} />
              </Stack>
            ) : !requests.length ? (
              <Typography variant="body2" color="text.secondary">
                You haven&apos;t submitted any change requests yet.
              </Typography>
            ) : (
              <Stack spacing={1.25} divider={<Divider flexItem />}>
                {requests.map((req) => (
                  <Stack key={req.id} direction="row" spacing={1.5} useFlexGap sx={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <Box sx={{ minWidth: 0, flex: '1 1 200px' }}>
                      <Typography variant="body2">
                        <strong>{REQUEST_KIND_LABELS[req.kind] || req.kind}</strong> · {fmtTime(req.createdAt)}
                      </Typography>
                      {req.note && <Typography variant="body2" color="text.secondary">{req.note}</Typography>}
                      {req.reviewNote && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          Management: {req.reviewNote}
                        </Typography>
                      )}
                    </Box>
                    <Chip
                      size="small"
                      color={req.status === 'approved' ? 'success' : req.status === 'rejected' ? 'error' : 'warning'}
                      label={req.status}
                    />
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
