/**
 * @module web/ui/panes/Audit
 *
 * Access Hygiene & Audit Dashboard: surfaces dormant credentials, active unknown/unassigned cards (with snapshot
 * shortcuts), high-frequency / possibly leaked entry codes, and gate traffic & cycle volume from `tx_history`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Typography,
} from '@mui/material';
import type { AccessAuditReply, ResidentRequest, ResidentRow, SuspiciousReport, TransactionRow } from '../types.ts';
import { errorText, useIsAdmin, useReadOnly, type GateApi } from '../api.ts';
import { fmtTime } from '../format.ts';

interface AuditProps {
  gapi: GateApi;
  residents: ResidentRow[];
  transactions: TransactionRow[];
  onOpenResident: (resident: ResidentRow) => void;
  onOpenSnap: (transaction: TransactionRow) => void;
}

type AuditTab = 'dormant' | 'unknown' | 'codes' | 'traffic';

function fmtHourShort(hour: number): string {
  const h = hour % 12 || 12;
  return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
}

function fmtHourFull(hour: number): string {
  const h = hour % 12 || 12;
  return `${h}:00 ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * Access Hygiene & Insights page (`GET /api/gates/:phone/audit`).
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.residents - Loaded resident/vendor rows for one-click navigation.
 * @param props.transactions - Loaded transaction rows for opening unknown-card snapshots.
 * @param props.onOpenResident - Jumps to a resident/vendor entry.
 * @param props.onOpenSnap - Opens the snapshot viewer for a transaction minute.
 * @returns Rendered React element.
 */
export function Audit({ gapi, residents, transactions, onOpenResident, onOpenSnap }: AuditProps) {
  const [days, setDays] = useState('90');
  const [tab, setTab] = useState<AuditTab>('dormant');
  const [audit, setAudit] = useState<AccessAuditReply | null>(null);
  const [reports, setReports] = useState<SuspiciousReport[]>([]);
  const [requests, setRequests] = useState<ResidentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [partialWarning, setPartialWarning] = useState('');
  const isAdmin = useIsAdmin();
  const readOnly = useReadOnly();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setPartialWarning('');
    try {
      const [auditRes, repsRes, reqsRes] = await Promise.allSettled([
        gapi<AccessAuditReply>('GET', `/audit?days=${days}`),
        gapi<{ reports: SuspiciousReport[] }>('GET', '/suspicious-reports'),
        gapi<{ requests: ResidentRequest[] }>('GET', '/resident-requests'),
      ]);
      if (auditRes.status === 'rejected') throw auditRes.reason;
      setAudit(auditRes.value);
      const warnings: string[] = [];
      if (repsRes.status === 'fulfilled') setReports(repsRes.value.reports);
      else warnings.push(`Suspicious reports unavailable: ${errorText(repsRes.reason)}`);
      if (reqsRes.status === 'fulfilled') setRequests(reqsRes.value.requests);
      else warnings.push(`Resident requests unavailable: ${errorText(reqsRes.reason)}`);
      if (warnings.length) setPartialWarning(warnings.join(' · '));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [gapi, days]);
  useEffect(() => { load(); }, [load]);

  const resolveReport = async (id: number) => {
    setError('');
    try {
      await gapi('POST', `/suspicious-reports/${id}/resolve`, {});
      await load();
    } catch (err) { setError(errorText(err)); }
  };

  const reviewRequest = async (id: number, decision: 'approved' | 'rejected') => {
    setError('');
    try {
      await gapi('POST', `/resident-requests/${id}/review`, { decision, apply: decision === 'approved' });
      await load();
    } catch (err) { setError(errorText(err)); }
  };

  const byCode = new Map(residents.map((res) => [res.directoryCode, res]));
  const openByCode = (code: string) => { const found = byCode.get(code); if (found) onOpenResident(found); };
  const openMinuteSnap = (minute: string, cardNumber: string) => {
    const match = transactions.find((tx) => tx.minute === minute && tx.number === cardNumber)
      || transactions.find((tx) => tx.minute === minute);
    if (match) onOpenSnap(match);
  };

  const maxHour = audit ? Math.max(1, ...audit.traffic.byHour) : 1;

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Access Insights</Typography>
      {reports.length > 0 && (
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="h6">Suspicious activity reports</Typography>
                <Chip size="small" color="error" label={`${reports.filter((report) => report.status === 'open').length} open`} />
              </Stack>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Reported</TableCell>
                      <TableCell>Unit</TableCell>
                      <TableCell>Transaction</TableCell>
                      <TableCell>Note</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {reports.slice(0, 20).map((rep) => (
                      <TableRow key={rep.id}>
                        <TableCell>{fmtTime(rep.createdAt)}</TableCell>
                        <TableCell>
                          <Link href="#" onClick={(event) => { event.preventDefault(); openByCode(rep.directoryCode); }}>
                            {rep.directoryCode}{rep.residentName ? ` · ${rep.residentName}` : ''}
                          </Link>
                        </TableCell>
                        <TableCell>{rep.txSummary}</TableCell>
                        <TableCell>{rep.note || '—'}</TableCell>
                        <TableCell>
                          <Chip size="small" color={rep.status === 'open' ? 'error' : 'success'} label={rep.status} />
                        </TableCell>
                        <TableCell>
                          {isAdmin && rep.status === 'open' && (
                            <Button size="small" variant="outlined" onClick={() => resolveReport(rep.id)}>Resolve</Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Stack>
          </CardContent>
        </Card>
      )}
      {requests.length > 0 && (
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="h6">Resident change requests</Typography>
                <Chip size="small" color="warning" label={`${requests.filter((request) => request.status === 'pending').length} pending`} />
              </Stack>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Submitted</TableCell>
                      <TableCell>Unit</TableCell>
                      <TableCell>Request</TableCell>
                      <TableCell>Details</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {requests.slice(0, 20).map((req) => (
                      <TableRow key={req.id}>
                        <TableCell>{fmtTime(req.createdAt)}</TableCell>
                        <TableCell>
                          <Link href="#" onClick={(event) => { event.preventDefault(); openByCode(req.directoryCode); }}>
                            {req.directoryCode}{req.residentName ? ` · ${req.residentName}` : ''}
                          </Link>
                        </TableCell>
                        <TableCell><Chip size="small" variant="outlined" label={req.kind} /></TableCell>
                        <TableCell>
                          {typeof req.payload?.phone === 'string' && req.payload.phone ? `Phone: ${req.payload.phone} ` : ''}
                          {req.note || '—'}
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            color={req.status === 'approved' ? 'success' : req.status === 'rejected' ? 'error' : 'warning'}
                            label={req.status}
                          />
                        </TableCell>
                        <TableCell>
                          {!readOnly && req.status === 'pending' && (
                            <Stack direction="row" spacing={1}>
                              <Button size="small" variant="outlined" color="success" onClick={() => reviewRequest(req.id, 'approved')}>Approve</Button>
                              <Button size="small" variant="outlined" color="error" onClick={() => reviewRequest(req.id, 'rejected')}>Reject</Button>
                            </Stack>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Stack>
          </CardContent>
        </Card>
      )}
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          size="small"
          value={days}
          onChange={(event) => setDays(String(event.target.value))}
          inputProps={{ 'aria-label': 'Audit period' }}
        >
          {[['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 180 days'], ['365', 'Last 365 days']].map(([val, label]) => (
            <MenuItem key={val} value={val}>{label}</MenuItem>
          ))}
        </Select>
        <Button variant="outlined" color="inherit" onClick={load}>Refresh</Button>
        {loading && <Typography variant="body2" color="text.secondary">Loading…</Typography>}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {partialWarning && <Alert severity="warning">{partialWarning}</Alert>}

      {audit && (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 2 }}>
            <Card>
              <CardContent>
                <Typography variant="caption" color="text.secondary">Dormant credentials</Typography>
                <Typography variant="h4">{audit.dormant.length}</Typography>
                <Typography variant="caption" color="text.secondary">Unused in {audit.days}d</Typography>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <Typography variant="caption" color="text.secondary">Unknown cards</Typography>
                <Typography variant="h4" color={audit.unknownCards.length ? 'warning.main' : undefined}>
                  {audit.unknownCards.length}
                </Typography>
                <Typography variant="caption" color="text.secondary">Unassigned in working copy</Typography>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <Typography variant="caption" color="text.secondary">Flagged entry codes</Typography>
                <Typography variant="h4" color={audit.entryCodes.some((code) => code.flagged) ? 'error.main' : undefined}>
                  {audit.entryCodes.filter((code) => code.flagged).length}
                </Typography>
                <Typography variant="caption" color="text.secondary">High-frequency / off-hours</Typography>
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <Typography variant="caption" color="text.secondary">Gate open cycles</Typography>
                <Typography variant="h4">{audit.traffic.openCycles.toLocaleString()}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {audit.traffic.admits} admits · {audit.traffic.denies} denies
                </Typography>
              </CardContent>
            </Card>
          </Box>

          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>Activity by hour of day ({audit.days} days)</Typography>
              <Stack
                direction="row"
                spacing={0.5}
                sx={{
                  alignItems: 'flex-end',
                  height: 112,
                  pt: 1,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                {audit.traffic.byHour.map((count, hour) => (
                  <Box
                    key={hour}
                    title={`${fmtHourFull(hour)} — ${count} event${count === 1 ? '' : 's'}`}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      height: '100%',
                      display: 'flex',
                      alignItems: 'flex-end',
                    }}
                  >
                    <Box
                      sx={{
                        width: '100%',
                        height: count > 0 ? Math.max(4, Math.round((count / maxHour) * 100)) : 2,
                        bgcolor: count > 0 ? 'primary.main' : 'action.disabledBackground',
                        borderRadius: '3px 3px 0 0',
                      }}
                    />
                  </Box>
                ))}
              </Stack>
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
                {audit.traffic.byHour.map((_, hour) => (
                  <Box
                    key={hour}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      height: 18,
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      overflow: 'visible',
                    }}
                  >
                    {hour % 3 === 0 && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontSize: 10, lineHeight: 1, whiteSpace: 'nowrap' }}
                      >
                        {fmtHourShort(hour)}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            </CardContent>
          </Card>

          <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <Tabs value={tab} onChange={(_, next: AuditTab) => setTab(next)} variant="scrollable" scrollButtons="auto">
              <Tab value="dormant" label={`Dormant (${audit.dormant.length})`} />
              <Tab value="unknown" label={`Unknown cards (${audit.unknownCards.length})`} />
              <Tab value="codes" label={`Entry codes (${audit.entryCodes.length})`} />
              <Tab value="traffic" label="Traffic" />
            </Tabs>
          </Box>

          {tab === 'dormant' && (
            <Card>
              <CardContent>
                <Stack spacing={1.5}>
                  <Typography variant="body2" color="text.secondary">
                    Active residents and vendors with cards or an entry code who have had zero recorded events in the last {audit.days} days.
                  </Typography>
                  {audit.dormant.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">No dormant credentials found.</Typography>
                  ) : (
                    <TableContainer component={Paper} variant="outlined">
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Code</TableCell>
                            <TableCell>Name</TableCell>
                            <TableCell>Type</TableCell>
                            <TableCell>Entry code</TableCell>
                            <TableCell>Cards</TableCell>
                            <TableCell>Last seen</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {audit.dormant.map((entry) => (
                            <TableRow key={entry.directoryCode}>
                              <TableCell>{entry.directoryCode}</TableCell>
                              <TableCell>
                                <Link href="#" onClick={(event) => { event.preventDefault(); openByCode(entry.directoryCode); }}>{entry.name}</Link>
                              </TableCell>
                              <TableCell>{entry.type}</TableCell>
                              <TableCell>{entry.entryCode || '—'}</TableCell>
                              <TableCell>{entry.cards.join(', ') || '—'}</TableCell>
                              <TableCell>{entry.lastSeen ? fmtTime(entry.lastSeen) : 'Never'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}

          {tab === 'unknown' && (
            <Card>
              <CardContent>
                <Stack spacing={1.5}>
                  <Typography variant="body2" color="text.secondary">
                    Card numbers seen in transaction history during the last {audit.days} days that are not assigned to any resident in the working copy.
                  </Typography>
                  {audit.unknownCards.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">No unknown cards seen.</Typography>
                  ) : (
                    <TableContainer component={Paper} variant="outlined">
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Card</TableCell>
                            <TableCell>Uses</TableCell>
                            <TableCell>Admits / Denies</TableCell>
                            <TableCell>Last seen</TableCell>
                            <TableCell>Camera</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {audit.unknownCards.map((card) => (
                            <TableRow key={card.cardNumber}>
                              <TableCell><Typography variant="body2" sx={{ fontWeight: 500 }}>{card.cardNumber}</Typography></TableCell>
                              <TableCell>{card.uses}</TableCell>
                              <TableCell>{card.admits} / {card.denies}</TableCell>
                              <TableCell>{fmtTime(card.lastSeen)}</TableCell>
                              <TableCell>
                                {card.hasSnapshot
                                  ? <Button size="small" variant="outlined" onClick={() => openMinuteSnap(card.lastMinute, card.cardNumber)}>View snapshot</Button>
                                  : <Typography variant="caption" color="text.secondary">—</Typography>}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}

          {tab === 'codes' && (
            <Card>
              <CardContent>
                <Stack spacing={1.5}>
                  <Typography variant="body2" color="text.secondary">
                    Admitted entry codes ranked by usage in the last {audit.days} days. High-frequency or heavy off-hours codes are flagged as potential leaks.
                  </Typography>
                  {audit.entryCodes.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">No admitted entry-code uses in this period.</Typography>
                  ) : (
                    <TableContainer component={Paper} variant="outlined">
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Entry code</TableCell>
                            <TableCell>Owner</TableCell>
                            <TableCell>Uses</TableCell>
                            <TableCell>Active days</TableCell>
                            <TableCell>Off-hours (11p–5a)</TableCell>
                            <TableCell>Status</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {audit.entryCodes.map((entry) => (
                            <TableRow key={entry.entryCode}>
                              <TableCell><Typography variant="body2" sx={{ fontWeight: 500 }}>{entry.entryCode}</Typography></TableCell>
                              <TableCell>
                                {entry.directoryCode
                                  ? (
                                    <Link href="#" onClick={(event) => { event.preventDefault(); openByCode(entry.directoryCode); }}>
                                      {entry.name || entry.directoryCode} ({entry.directoryCode})
                                    </Link>
                                  )
                                  : <Typography variant="body2" color="text.secondary">Unassigned</Typography>}
                              </TableCell>
                              <TableCell>{entry.uses}</TableCell>
                              <TableCell>{entry.distinctDays}</TableCell>
                              <TableCell>{entry.offHoursUses}</TableCell>
                              <TableCell>
                                {entry.flagged ? <Chip size="small" color="error" label="High usage" /> : <Chip size="small" label="Normal" />}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}

          {tab === 'traffic' && (
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>Recent daily volume (last 30 days)</Typography>
                {audit.traffic.byDay.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No daily volume recorded in this period.</Typography>
                ) : (
                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Date</TableCell>
                          <TableCell>Admits</TableCell>
                          <TableCell>Denies</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {[...audit.traffic.byDay].reverse().map((day) => (
                          <TableRow key={day.date}>
                            <TableCell>{day.date}</TableCell>
                            <TableCell>{day.admits}</TableCell>
                            <TableCell>{day.denies}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
