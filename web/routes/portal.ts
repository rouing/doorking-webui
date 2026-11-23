/**
 * @module web/routes/portal
 *
 * Resident Self-Service Portal & "Buzz Me In" routes (`/api/portal/gates/:phone/*`) plus admin review endpoints for
 * login audit logs, suspicious activity reports, and resident self-service change requests.
 */
import * as dk from '../../index.ts';
import type { PortalActivityReply, PortalMeReply, PortalStatusReply, ResidentRow, SnapshotMinute } from '../../src/types.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route, webOnly } from '../routing.ts';
import type { Gate, Reply } from '../context.ts';
import { logger } from '../../src/logging.ts';

const P = '/api/portal/gates/:phone';
const BUZZ_COOLDOWN_MS = 30000;

/**
 * Portal and admin-portal routes.
 *
 * @param modules - Composed server modules.
 * @returns Registered route definitions for the resident portal and admin review queues.
 */
export function portalRoutes(modules: Modules): Route[] {
  const { logged, prefsOf, siteNameOf, store } = modules.context;
  const { stepUpRefusal, strongUntil } = modules.auth;
  const { editOpts, editResidentInCache, editorResidents, gateData, sendInstructionsPdf, withHistory } = modules.editing;
  const { gateAlert, notifyResidentCodeChanged, notifyResidentRequestReviewed } = modules.mail;
  const { sendMedia } = modules.snapshots;
  const { busy, jobStatusFor, prepareGateSend, pulseRelay, startSend } = modules.jobs;
  const { emitWebhook } = modules.webhooks;

  // Per-resident Buzz Me In cooldown tracker (key: `${phone}:${username}` -> last buzz ms).
  const lastBuzzAt = new Map<string, number>();

  /** Loads the gate's normalized portal prefs and verifies the resident owns at least one enabled unit. */
  async function resolveResidentContext(gate: Gate, username: string, requestedCode?: string) {
    const prefs = await prefsOf(gate.phoneNumber);
    const portal = dk.normalizeResidentPortalPrefs(prefs.residentPortal);
    if (!portal.enabled) throw dk.httpError('The Resident Portal is currently turned off for this gate.', 403);
    const owned = await dk.ownedPortalUnits(store, gate.phoneNumber, username);
    if (!owned.length) throw dk.httpError('Your Resident Portal access for this gate is disabled.', 403);
    const [, list] = await editorResidents(gate);
    const rows = list.rows || [];
    const ownedRows = owned
      .map((codeKey) => rows.find((r) => dk.noteKey(r.directoryCode) === codeKey))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (!ownedRows.length) throw dk.httpError('Your unit was not found in the gate directory.', 404);
    const wantKey = requestedCode ? dk.noteKey(requestedCode) : '';
    const unit = wantKey ? ownedRows.find((r) => dk.noteKey(r.directoryCode) === wantKey) : ownedRows[0];
    if (!unit) throw dk.httpError('You do not have access to that directory code.', 403);
    return { prefs, portal, list, ownedRows, unit };
  }

  /** Filters gate transactions + portal opens strictly to this resident's own unit. */
  async function ownActivityRows(gate: Gate, unit: ResidentRow, limit = 60) {
    const [data, reports] = await Promise.all([
      gateData(gate.phoneNumber, { limit: 2000 }),
      dk.listSuspiciousReports(store, gate.phoneNumber, { codes: [unit.directoryCode], limit: 200 }),
    ]);
    const unitKey = dk.noteKey(unit.directoryCode);
    const unitCards = new Set(unit.cards.map((c) => String(Number(c))));
    const reportedKeys = new Set(reports.map((r) => `${r.txSource}:${r.txKey}`));
    const matched = (data.transactions?.rows || [])
      .filter((row) => {
        if (row.directoryCode && dk.noteKey(row.directoryCode) === unitKey) return true;
        if (row.lookup === 'card' && row.number && unitCards.has(String(Number(row.number)))) return true;
        if (row.lookup === 'entryCode' && unit.entryCode && row.number && Number(row.number) === Number(unit.entryCode)) return true;
        return false;
      })
      .slice(0, limit)
      .map((row) => {
        const source = row.source || 'gate';
        const txKey = row.txKey || (row.raw ? `${row.ts}:${row.raw}` : `${row.ts}:${row.eventType}:${row.number || ''}`);
        return { ...row, source, txKey, reported: reportedKeys.has(`${source}:${txKey}`) };
      });
    return matched;
  }

  return [
    // Resident's own unit overview, portal capabilities, reroll quota, and scheduled-send ETA.
    webOnly(route('GET', `${P}/me`, 'gate-resident', async ({ session, gate, req }) => {
      const code = String((req.query as Record<string, string | undefined>).code || '');
      const { prefs, portal, list, ownedRows, unit } = await resolveResidentContext(gate, session.user, code);
      const devices = prefs.deviceAssociation || dk.DEFAULT_DEVICE_ASSOCIATION;
      const labels = prefs.relayLabels || {};
      const [usedToday, pendingSend, nextSend, portalRec, siteName] = await Promise.all([
        dk.countRerollsToday(store, gate.phoneNumber, unit.directoryCode),
        dk.hasPendingReroll(store, gate.phoneNumber, unit.directoryCode),
        dk.nextScheduledSend(store, gate.phoneNumber),
        dk.getResidentPortal(store, gate.phoneNumber, unit.directoryCode),
        siteNameOf(gate.phoneNumber),
      ]);
      const reply: PortalMeReply = {
        gate: {
          phoneNumber: gate.phoneNumber,
          siteName: siteName || `Gate ${gate.phoneNumber}`,
          adminPhone: prefs.adminPhone || '',
          grantAccessDigit: list.grantAccessDigit || '9',
        },
        units: ownedRows.map((r) => ({ directoryCode: r.directoryCode, name: r.name })),
        unit: {
          directoryCode: unit.directoryCode,
          name: unit.name,
          phone: unit.areaCode ? `${unit.areaCode}${unit.phone}` : unit.phone,
          entryCode: unit.entryCode,
          hidden: unit.hidden,
          cards: unit.cards.map((c) => ({ number: String(Number(c)), device: dk.deviceNameFor(devices, c) || 'Card' })),
          email: portalRec?.email || '',
        },
        portal: {
          ...portal,
          buzzRelayLabels: portal.buzzRelays.map((relay) => ({ relay, name: labels[String(relay)] || `Relay ${relay}` })),
        },
        reroll: {
          usedToday,
          maxPerDay: portal.maxRerollsPerDay,
          remainingToday: Math.max(0, portal.maxRerollsPerDay - usedToday),
          pendingSend,
          nextScheduledSend: nextSend,
        },
      };
      return [200, reply];
    })),

    // Live gate availability + % progress (polled while gate is pushing/pulling so relays show unavailable).
    webOnly(route('GET', `${P}/status`, 'gate-resident', async ({ session, gate }) => {
      await resolveResidentContext(gate, session.user);
      const status = jobStatusFor(gate);
      const last = lastBuzzAt.get(`${gate.phoneNumber}:${session.user}`) || 0;
      const cooldownSeconds = Math.max(0, Math.ceil((last + BUZZ_COOLDOWN_MS - Date.now()) / 1000));
      return [200, { ...status, cooldownSeconds } as PortalStatusReply];
    })),

    // "Buzz Me In": momentary fail-safe pulse with Portal Open synthetic event + relay_timers safety net.
    webOnly(route('POST', `${P}/buzz`, 'gate-resident', async ({ session, gate, body }): Promise<Reply> => {
      const { prefs, portal, unit } = await resolveResidentContext(gate, session.user, body.code ? String(body.code) : undefined);
      if (!portal.buzzEnabled) return [403, { error: 'Remote gate opening is not enabled for this community.' }];
      if (portal.requirePasskeyForBuzz && !strongUntil(session)) return stepUpRefusal(session);
      const relay = Number(body.relay ?? portal.buzzRelays[0] ?? 0);
      if (!portal.buzzRelays.includes(relay)) return [403, { error: 'That entrance is not enabled for resident opening.' }];
      const status = jobStatusFor(gate);
      if (!status.available) {
        return [409, { error: `The gate is currently ${status.busyReason || 'busy'}${status.percent !== null ? ` (${status.percent}%)` : ''}. Try again once it finishes.`, status }];
      }
      const key = `${gate.phoneNumber}:${session.user}`;
      const last = lastBuzzAt.get(key) || 0;
      const waitSec = Math.ceil((last + BUZZ_COOLDOWN_MS - Date.now()) / 1000);
      if (waitSec > 0) return [429, { error: `Please wait ${waitSec} seconds before opening the gate again.` }];
      lastBuzzAt.set(key, Date.now());
      const relayName = prefs.relayLabels?.[String(relay)] || `Relay ${relay}`;
      try {
        const res = await pulseRelay(gate, relay, portal.pulseSeconds);
        const ev = await dk.recordPortalEvent(store, { phone: gate.phoneNumber, directoryCode: unit.directoryCode, username: session.user, relay, result: 'done' });
        await dk.addEvent(store, gate.phoneNumber, {
          user: session.user, action: 'relay', result: 'done',
          summary: res.alreadyOpen ? `Portal Open (${relayName}) by unit ${unit.directoryCode} (already open)` : `Portal Open (${relayName}) by unit ${unit.directoryCode}`,
        });
        emitWebhook(gate.phoneNumber, 'relay.changed', { actor: session.user, source: 'portal', directoryCode: unit.directoryCode, relay, alreadyOpen: res.alreadyOpen });
        logger('gate').info`Gate ${gate.phoneNumber}: Portal Open (${relayName}) by ${session.user} (unit ${unit.directoryCode})`;
        return [200, { ok: true, alreadyOpen: res.alreadyOpen, event: ev }];
      } catch (err) {
        const msg = (err as Error).message;
        const onAuditErr = logged('gate', `Gate ${gate.phoneNumber}: failed buzz audit write`);
        await dk.recordPortalEvent(store, { phone: gate.phoneNumber, directoryCode: unit.directoryCode, username: session.user, relay, result: 'failed', error: msg }).catch(onAuditErr);
        await dk.addEvent(store, gate.phoneNumber, {
          user: session.user, action: 'relay', result: 'failed', error: msg,
          summary: `Portal Open (${relayName}) by unit ${unit.directoryCode}`,
        }).catch(onAuditErr);
        return [502, { error: msg }];
      }
    })),

    // "Reroll my gate code": serialized inside `withHistory` so concurrent double-taps cannot bypass the daily cap
    // or collide on generated codes, and re-checks `busy(gate)` immediately before `startSend`.
    webOnly(route('POST', `${P}/reroll-code`, 'gate-resident', async ({ session, gate, body }): Promise<Reply> => {
      const { portal, unit } = await resolveResidentContext(gate, session.user, body.code ? String(body.code) : undefined);
      if (portal.maxRerollsPerDay <= 0) return [403, { error: 'Entry code rerolling is turned off for this gate.' }];
      let nextCode = '';
      let remainingToday = 0;
      const editReply = await withHistory(session, gate,
        { summary: `Resident ${session.user} (unit ${unit.directoryCode}) rerolled entry code` }, async (ctx) => {
          const usedToday = await dk.countRerollsToday(store, gate.phoneNumber, unit.directoryCode);
          if (usedToday >= portal.maxRerollsPerDay) {
            return [429, { error: `You have reached the limit of ${portal.maxRerollsPerDay} gate code change${portal.maxRerollsPerDay === 1 ? '' : 's'} per 24 hours. Contact management if you need another change.` }];
          }
          const [, latestList] = await editorResidents(gate);
          const latestUnit = (latestList.rows || []).find((r) => dk.noteKey(r.directoryCode) === dk.noteKey(unit.directoryCode)) || unit;
          const taken = (latestList.rows || []).map((r) => r.entryCode).filter(Boolean);
          if (latestUnit.entryCode) taken.push(latestUnit.entryCode);
          nextCode = dk.generateSafeEntryCode(taken);
          const opts = await editOpts(gate);
          const out = await editResidentInCache(gate.phoneNumber, unit.directoryCode, { entryCode: nextCode }, opts, ctx);
          if (out[0] < 300) {
            await dk.recordCodeReroll(store, { phone: gate.phoneNumber, directoryCode: unit.directoryCode, username: session.user, oldCode: latestUnit.entryCode, newCode: nextCode });
            remainingToday = Math.max(0, portal.maxRerollsPerDay - (usedToday + 1));
          }
          return out;
        });
      if (editReply[0] >= 300) return editReply;
      const nextSend = await dk.nextScheduledSend(store, gate.phoneNumber);
      let syncing = false;
      if (portal.autoSendReroll && !busy(gate)) {
        try {
          const prepared = await prepareGateSend(gate);
          if (!busy(gate)) {
            void startSend(gate, prepared, {});
            syncing = true;
          }
        } catch (err) {
          logger('gate').warn`Gate ${gate.phoneNumber}: auto-send after reroll skipped: ${(err as Error).message}`;
        }
      }
      if (!syncing) {
        await gateAlert(gate.phoneNumber, `Resident rerolled entry code (Unit ${unit.directoryCode})`,
          `${unit.name || session.user} (directory code ${unit.directoryCode}) generated a new entry code in the working copy.${nextSend ? ` Next scheduled send: ${new Date(nextSend).toLocaleString('en-US')}.` : ' Please review and click Send to gate.'}`);
      }
      await notifyResidentCodeChanged(gate.phoneNumber, unit.directoryCode, { synced: false, nextScheduledSend: syncing ? null : nextSend });
      return [200, { entryCode: nextCode, syncedToGate: syncing ? 'sending' : false, nextScheduledSend: nextSend, remainingToday }];
    })),

    // Resident's own transaction history (merged with Portal Open events + saved snapshot filenames when enabled).
    webOnly(route('GET', `${P}/activity`, 'gate-resident', async ({ session, gate, req }) => {
      const code = String((req.query as Record<string, string | undefined>).code || '');
      const { portal, unit } = await resolveResidentContext(gate, session.user, code);
      const [rows, snapshots] = await Promise.all([
        ownActivityRows(gate, unit, 80),
        portal.showSnapshots ? dk.listSnapshots(store, gate.phoneNumber) : Promise.resolve<Record<string, SnapshotMinute>>({}),
      ]);
      const enriched = portal.showSnapshots
        ? rows.map((row) => {
          const snap = snapshots[row.minute];
          const files = snap && snap.status !== 'removed' ? snap.files : [];
          return files.length ? { ...row, snapshotFiles: files } : row;
        })
        : rows;
      return [200, { rows: enriched, showSnapshots: portal.showSnapshots } as PortalActivityReply];
    })),

    // Own-unit snapshot image/video download (strictly verifies the minute belongs to this resident's own activity
    // and resolves the file via `dk.snapshotFile` so default frame names like `ch1-00.jpg` and `ch1-a20.jpg` work).
    webOnly(route('GET', `${P}/snapshots/:minute/:file`, 'gate-resident', async ({ session, gate, params, req, reply }) => {
      const code = String((req.query as Record<string, string | undefined>).code || '');
      const { portal, unit } = await resolveResidentContext(gate, session.user, code);
      if (!portal.showSnapshots) return [403, { error: 'Snapshots are not enabled for residents on this gate.' }];
      const file = dk.snapshotFile(gate.dir, params.minute, params.file);
      if (!file) return [404, { error: 'Snapshot not found' }];
      const rows = await ownActivityRows(gate, unit, 200);
      if (!rows.some((r) => r.minute === params.minute)) return [403, { error: 'That snapshot does not belong to your unit.' }];
      return sendMedia(reply, file);
    })),

    // "Report as suspicious" on one of the resident's own transactions -> alerts gate admins.
    webOnly(route('POST', `${P}/activity/report`, 'gate-resident', async ({ session, gate, body }) => {
      const { unit } = await resolveResidentContext(gate, session.user, body.code ? String(body.code) : undefined);
      const txSource = body.txSource === 'portal' ? 'portal' : 'gate';
      const txKey = String(body.txKey || '').trim();
      const rows = await ownActivityRows(gate, unit, 200);
      const match = rows.find((r) => (r.source || 'gate') === txSource && r.txKey === txKey);
      if (!match) return [404, { error: 'Transaction not found in your unit\'s activity.' }];
      const txSummary = `${match.eventType} (${match.access}) · ${match.date} ${match.time}${match.number ? ` · #${match.number}` : ''}`;
      const { report, created } = await dk.reportSuspiciousActivity(store, {
        phone: gate.phoneNumber, directoryCode: unit.directoryCode, username: session.user,
        txSource, txKey, txTs: new Date(match.ts).toISOString(), txSummary, note: String(body.note ?? ''),
      });
      if (created) {
        await gateAlert(gate.phoneNumber, `Suspicious activity reported (Unit ${unit.directoryCode})`,
          `${unit.name || session.user} flagged: ${txSummary}.${report.note ? `\nResident note: ${report.note}` : ''}`);
        emitWebhook(gate.phoneNumber, 'suspicious.reported', { directoryCode: unit.directoryCode, username: session.user, report });
      }
      return [created ? 201 : 200, { report, created }];
    })),

    // Self-service change requests (phone, directory visibility, lost remote, other).
    webOnly(route('GET', `${P}/requests`, 'gate-resident', async ({ session, gate }) => {
      await resolveResidentContext(gate, session.user);
      return [200, { requests: await dk.listResidentRequests(store, gate.phoneNumber, { username: session.user }) }];
    })),
    webOnly(route('POST', `${P}/requests`, 'gate-resident', async ({ session, gate, body }) => {
      const { portal, unit } = await resolveResidentContext(gate, session.user, body.code ? String(body.code) : undefined);
      if (!portal.allowRequests) return [403, { error: 'Change requests are not enabled on this gate.' }];
      const request = await dk.createResidentRequest(store, {
        phone: gate.phoneNumber, directoryCode: unit.directoryCode, username: session.user,
        kind: body.kind, payload: body.payload, note: body.note,
      });
      await gateAlert(gate.phoneNumber, `Resident request from Unit ${unit.directoryCode}`,
        `${unit.name || session.user} submitted a "${request.kind}" request.${request.note ? `\nNote: ${request.note}` : ''}`);
      return [201, { request }];
    })),

    // Pre-filled ResidentInstructions.pdf locked to the resident's own unit.
    webOnly(route('POST', `${P}/instructions.pdf`, 'gate-resident', async ({ session, gate, body, reply }) => {
      const { prefs, list, unit } = await resolveResidentContext(gate, session.user, body.code ? String(body.code) : undefined);
      return sendInstructionsPdf(reply, {
        residentName: unit.name,
        directoryCode: unit.directoryCode,
        entryCode: unit.entryCode,
        adminPhone: prefs.adminPhone || '',
        grantAccessDigit: list.grantAccessDigit || '9',
      });
    })),

    // --- Admin / Staff review endpoints ---

    // Admin login audit log for this gate's users (staff + residents + unmatched failures).
    webOnly(route('GET', `${G}/login-audit`, 'gate-admin', async ({ gate, req }) => {
      const query = req.query as Record<string, string | undefined>;
      const entries = await dk.listLoginAudit(store, gate.phoneNumber, {
        limit: Number(query.limit) || 100,
        outcome: query.outcome === 'failed' ? 'failed' : '',
      });
      return [200, { entries }];
    })),

    // Suspicious activity reports filed by residents.
    webOnly(route('GET', `${G}/suspicious-reports`, 'gate', async ({ gate }) => {
      const [reports, working] = await Promise.all([
        dk.listSuspiciousReports(store, gate.phoneNumber),
        dk.loadWorkingState(store, gate.phoneNumber),
      ]);
      const names = new Map((working?.state.residents || []).map((r) => [dk.noteKey(r.directoryCode), r.name]));
      return [200, { reports: reports.map((r) => ({ ...r, residentName: names.get(dk.noteKey(r.directoryCode)) || '' })) }];
    })),
    webOnly(route('POST', `${G}/suspicious-reports/:id/resolve`, 'gate-admin', async ({ session, gate, params, body }) => {
      const report = await dk.resolveSuspiciousReport(store, gate.phoneNumber, Number(params.id), session.user, String(body.reviewNote ?? ''));
      return [200, { report }];
    })),

    // Resident change requests queue + Approve (optionally auto-applying phone/hidden to working copy) / Reject.
    webOnly(route('GET', `${G}/resident-requests`, 'gate', async ({ gate }) => {
      const [requests, working] = await Promise.all([
        dk.listResidentRequests(store, gate.phoneNumber),
        dk.loadWorkingState(store, gate.phoneNumber),
      ]);
      const names = new Map((working?.state.residents || []).map((r) => [dk.noteKey(r.directoryCode), r.name]));
      return [200, { requests: requests.map((r) => ({ ...r, residentName: names.get(dk.noteKey(r.directoryCode)) || '' })) }];
    })),
    webOnly(route('POST', `${G}/resident-requests/:id/review`, 'gate-editor', async ({ session, gate, params, body }) => {
      const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : '';
      if (!decision) return [400, { error: 'decision must be approved or rejected' }];
      const reviewNote = String(body.reviewNote ?? '').trim();
      const request = await dk.reviewResidentRequest(store, gate.phoneNumber, Number(params.id), decision, session.user, reviewNote);
      // When approved with apply=true and a structured phone update, apply directly to working copy inside History.
      if (decision === 'approved' && body.apply !== false && request.kind === 'phone') {
        const nanp = dk.parseNanpPhone(String(request.payload.phone ?? ''), { keepLeadingOne: true });
        if (nanp) {
          const opts = await editOpts(gate);
          await withHistory(session, gate, { summary: `Approved resident phone update for unit ${request.directoryCode}` },
            (ctx) => editResidentInCache(gate.phoneNumber, request.directoryCode, nanp, opts, ctx));
        }
      }
      await notifyResidentRequestReviewed(request.username, gate.phoneNumber, decision, request.kind, reviewNote);
      return [200, { request }];
    })),
  ];
}
