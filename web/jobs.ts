/**
 * @module web/jobs
 *
 * Gate connections (one at a time per DKS account: DKS Cloud refuses a second session on the same login; gates on
 * different logins run at the same time): pulls, sends, login checks, relay calls and scheduled transfers.
 */
import crypto from 'node:crypto';
import { withContext } from '@logtape/logtape';
import * as dk from '../index.ts';
import type { BoardBuffers } from '../src/residents-edit.ts';
import type { RecordChange } from '../src/audit.ts';
import type { GateConfig, GateRole, Schedule, ScheduleAction } from '../src/types.ts';
import type { Gate, JobInfo, JobState, PullSteps, Reply, SessionRequest } from './context.ts';
import type { ContextModule } from './context.ts';
import type { EditingModule } from './editing.ts';
import type { MailModule } from './mail.ts';
import type { SnapshotsModule } from './snapshots.ts';
import type { WebhooksModule } from './webhooks.ts';
import { logger } from '../src/logging.ts';

type PreparedSend = Awaited<ReturnType<typeof dk.prepareSend>> & { counts: number[] };

/**
 * The gate connections and what limits them: the current or last connection of each gate, one connection at a time
 * per DKS account (relay calls included), and the shutdown flag.
 *
 * @param deps - Injected module dependencies.
 * @returns Operation result.
 */
function createConnections(deps: ContextModule) {
  const { siteNameOf } = deps;
  const IDLE: JobState = { state: 'idle', log: [] };
  const jobs = new Map<string, JobState>(); // phone -> the gate's current or last connection
  const relayCalls = new Map<string, number>(); // DKS account -> live relay calls running on it
  /**
   * DKS logins are compared without case.
   *
   * @param dksUser - DKS Cloud account username.
   * @returns `string` result.
   */
  const accountOf = (dksUser: unknown): string => String(dksUser ?? '').trim().toLowerCase();
  const currentJob = (phone: string): JobState => jobs.get(phone) || IDLE;
  /**
   * The running connection on a DKS account, if any.
   *
   * @param account - Normalized (lowercase) DKS Cloud login name.
   * @returns `JobState | undefined` result.
   */
  const runningOn = (account: string): JobState | undefined => [...jobs.values()].find((job) => job.state === 'running' && job.account === account);
  /**
   * Busy: the gate itself has a connection running (it may use another login, e.g. a login check), or its DKS account does.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @returns True when the condition holds.
   */
  const accountBusy = (gate: Gate): boolean => currentJob(gate.phoneNumber).state === 'running'
    || Boolean(runningOn(accountOf(gate.user))) || Boolean(relayCalls.get(accountOf(gate.user)));
  /**
   * The gate a user is adding (its first pull), or null.
   *
   * @param user - Local account username (or actor name for audit logs).
   * @returns `JobState | null` result.
   */
  const addingJobOf = (user: string): JobState | null =>
    [...jobs.values()].reverse().find((job) => job.adding && job.user === user) || null;
  /**
   * Forgets the gate's last connection (its stored data was deleted).
   *
   * @param phone - Gate system phone number (digits or formatted).
   */
  function forgetJob(phone: string): void {
    jobs.delete(phone);
  }
  /**
   * Checked and acted on without awaiting in between, so two requests can't both start a connection on one account.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @returns Promise resolving to `Reply> | nul`.
   */
  const busy = (gate: Gate): Promise<Reply> | null => (accountBusy(gate)
    ? busyMessage(gate).then((error): Reply => [409, { error }]) : null);
  /**
   * Runs a live relay call (GetRelays/SetRelays) on the gate's DKS account; refused (409) while that account is busy.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param fn - Callback function to execute.
   * @returns Promise resolving to `T`.
   * @throws HTTP 409 error on invalid input or conflict.
   */
  async function withAccount<T>(gate: Gate, fn: () => Promise<T>): Promise<T> {
    if (accountBusy(gate)) throw dk.httpError(await busyMessage(gate), 409);
    const account = accountOf(gate.user);
    relayCalls.set(account, (relayCalls.get(account) || 0) + 1);
    try {
      return await fn();
    } finally {
      relayCalls.set(account, relayCalls.get(account)! - 1);
      if (!relayCalls.get(account)) relayCalls.delete(account);
    }
  }
  async function busyMessage(gate: Gate): Promise<string> {
    const running = currentJob(gate.phoneNumber).state === 'running' ? currentJob(gate.phoneNumber) : runningOn(accountOf(gate.user));
    if (!running) return 'A live relay check is running on this gate\'s DKS login. Try again in a moment.';
    if (running.phoneNumber === gate.phoneNumber) return 'A gate connection is already running';
    const other = (await siteNameOf(running.phoneNumber ?? '')) || `the gate ending ${String(running.phoneNumber).slice(-4)}`;
    return `A gate connection is already running for ${other}, which uses the same DKS login`;
  }
  /** Server shutdown: no new connection or schedule starts. */
  let stopping = false;
  const stopNewJobs = (): void => { stopping = true; };
  const isStopping = (): boolean => stopping;
  /**
   * The running connections (for the shutdown log), and whether none (nor a relay call) is running.
   *
   * @returns `JobState[]` result.
   */
  const runningJobs = (): JobState[] => [...jobs.values()].filter((job) => job.state === 'running');
  const connectionsIdle = (): boolean => !runningJobs().length && !relayCalls.size;
  return { jobs, accountOf, currentJob, accountBusy, addingJobOf, forgetJob, busy, withAccount, stopNewJobs, isStopping, runningJobs, connectionsIdle };
}
type Connections = ReturnType<typeof createConnections>;

/**
 * Pulls, sends and login checks: each a job on the gate's connection, recorded in its history when it ends.
 *
 * @param deps - Injected module dependencies.
 * @param connections - `Connections` value.
 * @returns Operation result.
 */
function createTransfers(deps: ContextModule & EditingModule & MailModule & SnapshotsModule & WebhooksModule, connections: Connections) {
  const { client, defaults, emitWebhook, GATE_CONFIG_KEYS, gateAlert, logged, notifyResidentCodeChanged, prefsOf, queueSnapshots, refuseDuplicates, serial, store } = deps;
  const { jobs, accountBusy, accountOf, isStopping, withAccount } = connections;
  /**
   * The gate-match config lives in the gate-scoped prefs (keyed by phone number), set under System Settings.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
   * @param [extra] - Additional text or options.
   * @returns Promise resolving to `SessionRequest`.
   * @throws HTTP 409 error on invalid input or conflict.
   */
  async function sessionRequest(gate: Gate, what: string, extra: dk.SessionOptions = {}): Promise<SessionRequest> {
    if (!gate.user || !gate.password) throw dk.httpError('This gate has no DKS login yet. A gate admin can set it in System Settings → Gate login.', 409);
    const cfg: Partial<GateConfig> = (await prefsOf(gate.phoneNumber)).gateConfig || {};
    const chosen = Object.fromEntries(GATE_CONFIG_KEYS
      .filter((key) => typeof cfg[key] === 'string' && cfg[key].trim())
      .map((key) => [key, (cfg[key] as string).trim()]));
    return dk.buildSessionRequest(what, {
      ...defaults,
      ...chosen,
      ...extra,
      user: gate.user, password: gate.password, phoneNumber: gate.phoneNumber, masterCode: gate.masterCode,
    });
  }
  /**
   * Starts a gate connection (its DKS account must be free, see busy): the job is claimed at once, then makeRequest() builds the DKS session request and
   * run(log, request) does the work. The job's state and log are read via GET .../job.
   * When it ends, it is recorded in the gate's history (info adds fields to that entry; scheduled: true marks a
   * scheduled transfer). Returns a promise of the finished job.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
   * @param makeRequest - `() => Promise<SessionRequest>` value.
   * @param run - Run.
   * @param [info] - Additional job or audit metadata.
   * @returns Promise resolving to `JobState`.
   */
  function startJob(gate: Gate, what: string, makeRequest: () => Promise<SessionRequest>,
    run: (log: (line: string) => void, request: SessionRequest) => Promise<void>, info: JobInfo = {}): Promise<JobState> {
    const startedAt = new Date();
    const job: JobState = { state: 'running', what, phoneNumber: gate.phoneNumber, user: gate.actor, account: accountOf(gate.user), startedAt, log: [],
      ...(info.adding && { adding: true }) };
    jobs.delete(gate.phoneNumber); // so the newest job is last (addingJobOf)
    jobs.set(gate.phoneNumber, job);
    /**
     * Each job line also goes to the server log (the job keeps the last MAX_JOB_LOG lines), except a status repeated while the gate is polled.
     */
    let lastLine = '';
    const log = (line: string) => {
      job.log.push(`${new Date().toLocaleTimeString('en-US')}  ${line}`);
      if (job.log.length > MAX_JOB_LOG) job.log.shift(); // the page fetches the whole log every 3 s
      if (line !== lastLine) logger('gate')[line.startsWith('Error') ? 'error' : 'info']`Gate ${gate.phoneNumber}: ${line}`;
      lastLine = line;
    };
    // Every log line of the connection, here and in src/, carries its job id and gate (LogTape context).
    return withContext({ job: crypto.randomUUID().slice(0, 8), gate: gate.phoneNumber, what }, () => (async () => {
      const request = await makeRequest();
      log(`Starting ${info.scheduled ? 'scheduled ' : ''}${what === 'send' ? 'send' : `${what} pull`} by ${gate.actor}: ${JSON.stringify(dk.maskRequest(request, gate.user))}`);
      await run(log, request);
    })()
      .then(() => { job.state = 'done'; })
      .catch((err) => { log(`Error: ${err.message}`); job.state = 'failed'; job.error = err.message; })
      .then(async () => {
        const finishedAt = new Date();
        job.finishedAt = finishedAt;
        logger('gate').info`Gate ${gate.phoneNumber}: ${what} ${info.scheduled ? '(scheduled) ' : ''}${job.state} after ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)} s`;
        if (info.adding && !await finishAdding(gate, job, log)) return job;
        if (what === 'send' && job.state === 'failed' && !info.scheduled) {
          await gateAlert(gate.phoneNumber, 'Send to gate failed', `Started by ${gate.actor}. Error: ${job.error}`).catch(logged('email', 'Gate alert not sent'));
        }
        if (what === 'send') emitWebhook(gate.phoneNumber, job.state === 'done' ? 'send.completed' : 'send.failed', { actor: gate.actor, scheduled: Boolean(info.scheduled), error: job.error || null });
        else if (job.state === 'done') emitWebhook(gate.phoneNumber, 'pull.completed', { what, actor: gate.actor, scheduled: Boolean(info.scheduled) });
        const { adding, ...rest } = info;
        const action = what === 'send' ? 'send' : 'pull';
        const summary = `${what === 'send' ? 'Sent working copy to gate' : `Pulled ${what}`}${info.scheduled ? ' (scheduled)' : ''}${adding ? ' (gate added)' : ''}`;
        try {
          await dk.addEvent(store, gate.phoneNumber, { user: gate.actor, action, what, summary, result: job.state, ...(job.error && { error: job.error }), ...rest });
        } catch (err) { logger('server').error`History not saved: ${(err as Error).message}`; }
        return job;
      }));
  }
  const roleText = (role: GateRole) => (role === 'admin' ? 'admin' : role === 'editor' ? 'editor' : 'read only');
  /**
   * A new master code (with the DKS login): checked by a residents pull with it, and saved only when that succeeds.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @returns Promise resolving to `JobState`.
   */
  function startLoginCheck(gate: Gate): Promise<JobState> {
    return startPull(gate, 'residents', {}, {
      afterPull: async (log) => {
        await dk.updateGateLogin(store, gate.phoneNumber, { masterCode: gate.masterCode, dksUser: gate.dksUser, dksPassword: gate.dksPassword });
        log('New master code saved');
        await dk.addEvent(store, gate.phoneNumber, { user: gate.actor, action: 'login', summary: 'Changed the gate\'s master code' });
        logger('gates').info`${gate.actor} changed the master code of gate ${gate.phoneNumber}`;
      },
    });
  }
  /**
   * The first pull of a gate being added: on success the gate is saved with its DKS login and master code, and the
   * person adding it becomes its admin. On failure everything stored for that phone number (its gate configuration
   * and anything the pull left) is removed. Returns false when the gate was not added (nothing goes in its History).
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param job - `JobState` value.
   * @param log - Callback receiving progress or diagnostic messages.
   * @returns Promise resolving to `true` when the condition holds.
   */
  async function finishAdding(gate: Gate, job: JobState, log: (line: string) => void): Promise<boolean> {
    try {
      if (job.state === 'done') {
        await dk.registerGate(store, gate, gate.actor);
        log(`Gate added; ${gate.actor} is its admin`);
        logger('gates').info`${gate.actor} added gate ${gate.phoneNumber}`;
        return true;
      }
    } catch (err) { job.state = 'failed'; job.error = (err as Error).message; log(`Error: ${job.error}`); }
    if (!await dk.gateExists(store, gate.phoneNumber)) {
      try { await dk.deleteGateData(store, gate.phoneNumber); } catch (err) { logger('gates').error`Cleanup after a failed add of ${gate.phoneNumber}: ${(err as Error).message}`; }
    }
    logger('gates').warn`${gate.actor} could not add gate ${gate.phoneNumber}: ${job.error}`;
    return false;
  }
  const MAX_JOB_LOG = 500;
  /**
   * The board files of a pull, or null when one is missing.
   *
   * @param files - Map of board filenames to binary buffers.
   * @returns `BoardBuffers | null` result.
   */
  const boardOf = (files: Record<string, Buffer>): BoardBuffers | null => (dk.CACHE_FILES.every((file) => files[file])
    ? { names: files['names.bin'], phone: files['phone.bin'], cards: files['cards.bin'] } : null);
  /**
   * Runs the round-trip and rebuild checks on a pull (gate-state.ts; files: the pull, else the gate's stored files) and
   * records them. masterCode: the one the pull used (a gate being added, or a new master code, isn't saved yet), else
   * the saved one. Returns a line for the job log.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @param [files] - The pull, else the gate's stored files.
   * @param [masterCode] - Master code used by the pull (needed when adding a gate or testing a new code).
   * @returns Promise resolving to `string`.
   */
  async function recordGateState(phone: string, files?: BoardBuffers | null, masterCode?: string): Promise<string> {
    const pulled = files === undefined ? await dk.readBaseFiles(store, phone) : files;
    if (!pulled) return 'Round-trip check skipped: the pull is missing a file';
    const prefs = await prefsOf(phone);
    const code = masterCode ?? (await dk.getGate(store, phone))?.masterCode;
    const check = await dk.checkPull(store, phone, pulled, new Date(),
      { areaCodeSlots: dk.areaCodeLimit((prefs.gateConfig || {}).areaCodes || defaults.areaCodes), masterCode: code });
    const line = (check.ok ? 'Round-trip check passed: the files rebuild byte for byte from their values'
      : `Round-trip check FAILED (editing stays locked): ${JSON.stringify(check.problems).slice(0, 500)}`)
      + (check.rebuild.ok ? '; rebuild from values alone passed' : `; rebuild from values alone differs: ${JSON.stringify(check.rebuild.problems).slice(0, 500)}`);
    logger('gate').info`Gate ${phone}: ${line}`;
    return line;
  }
  /**
   * Job log lines for what a residents pull did to the working copy (gate-cache.ts applyPull).
   *
   * @param result - Verified operation result.
   * @returns `string[]` result.
   */
  function pullLines(result: dk.PullResult): string[] {
    const plural = (count: number) => (count === 1 ? '' : 's');
    if (result.outcome === 'new') return ['Working copy made from this pull'];
    if (result.outcome === 'unchanged') return ['The gate holds the same data as before'];
    if (result.outcome === 'refreshed') return ['Working copy updated from this pull (it had no unsent changes)'];
    if (result.outcome === 'dropped') {
      return [`Your ${result.dropped!.count} unsent change${plural(result.dropped!.count)} were dropped and the working copy now matches the gate: ${result.dropped!.reason}`];
    }
    return [
      `Working copy updated from this pull: ${result.fromGate} change${plural(result.fromGate)} from the gate taken, ${result.kept} unsent change${plural(result.kept)} kept on top`,
      ...(result.conflicts.length ? [`${result.conflicts.length} conflict${plural(result.conflicts.length)} to decide before sending (changed differently at the gate and here): ${
      result.conflicts.map((conflict) => conflict.label).join('; ')}`] : []),
      ...result.notKept.map((skipped) => `Couldn't keep your change to ${skipped.label} (${skipped.error}); the gate's value is used`),
    ];
  }
  /**
   * Applies a residents pull to the working copy (no edit is saved meanwhile) and logs what happened.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param files - Map of board filenames to binary buffers.
   * @param log - Callback receiving progress or diagnostic messages.
   */
  async function applyResidentsPull(gate: Gate, files: Record<string, Buffer>, log: (line: string) => void): Promise<void> {
    const result = await serial(gate.phoneNumber, () => dk.applyPull(store, gate.phoneNumber, files));
    for (const line of pullLines(result)) log(line);
    const board = boardOf(files);
    if (board) await dk.archivePull(store, gate.phoneNumber, board, { actor: gate.actor }).catch(logged('gate', 'Pull archive failed'));
  }
  /**
   * prepare: runs first, inside the job (the gate's connection is already claimed, so nothing can start in between).
   * steps.prepare runs before the session request is built; steps.afterPull once the files are read, before they are
   * stored (an error in either fails the job).
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
   * @param [info] - Additional job or audit metadata.
   * @param [steps] - Optional pre-request and post-pull hooks.
   * @returns Promise resolving to `JobState`.
   */
  function startPull(gate: Gate, what: dk.PullKind, info: JobInfo = {}, steps: PullSteps = {}): Promise<JobState> {
    const { prepare, afterPull } = steps;
    const pulled = (job: JobState) => { if (what === 'transactions' && job.state === 'done' && !isStopping()) queueSnapshots(gate.phoneNumber, gate.dir); return job; };
    const makeRequest = async () => { await prepare?.(); return sessionRequest(gate, what); };
    return startJob(gate, what, makeRequest, async (log, request) => {
      const { files } = await dk.pullFromGate(client(), what, request, { onStatus: log });
      for (const [name, data] of Object.entries(files)) log(`Read ${name} (${data.length} bytes)`);
      await afterPull?.(log);
      if (files['rcv_out.bin']) {
        const merged = await dk.mergeTransactions(store, gate.phoneNumber, files['rcv_out.bin']);
        log(`Transaction history: ${merged.added} new event${merged.added === 1 ? '' : 's'}, ${merged.kept} already saved`);
        if (merged.gap) log('No overlap with the saved history: events may be missing since the last pull, or the gate\'s buffer was cleared');
      }
      if (what === 'residents') {
        log(await recordGateState(gate.phoneNumber, boardOf(files), gate.masterCode));
        await applyResidentsPull(gate, files, log);
      }
    }, info).then(pulled);
  }
  /**
   * Resident counts for the send session's UserID (DoorKing32 FUN_004f7320: records with FL 0, FL 2).
   * Derived from the working copy's names.bin directory, so no RESIDENT.DAT is needed.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @returns Promise resolving to the operation result.
   */
  async function residentCounts(phone: string) {
    const { data } = await dk.readCacheFile(store, phone, 'names.bin'); // throws 404 "pull residents" if there is no working copy
    return dk.namesResidentCounts(data);
  }
  /**
   * Everything a send needs from the working copy; throws (409/404) when it can't be sent.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @returns Promise resolving to `PreparedSend`.
   */
  async function prepareGateSend(gate: Gate): Promise<PreparedSend> {
    await refuseDuplicates(gate.phoneNumber);
    return { ...await dk.prepareSend(store, gate.phoneNumber), counts: await residentCounts(gate.phoneNumber) };
  }
  /**
   * Sends the working copy, then pulls residents again to check the gate now holds what was sent.
   * Match: the pull becomes the base and the working copy; edits saved while the send ran are kept on top of it (applied
   * like any residents pull). Mismatch: the pull is applied like any residents pull (the changes not on the gate stay
   * unsent) and the differing blocks are logged.
   * prepared: from prepareGateSend, awaited before the busy check so the job is claimed without a gap.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param prepared - From prepareGateSend, awaited before the busy check so the job is claimed without a gap.
   * @param [info] - Additional job or audit metadata.
   * @returns Promise resolving to `JobState`.
   */
  function startSend(gate: Gate, prepared: PreparedSend, info: JobInfo = {}): Promise<JobState> {
    return startJob(gate, 'send', () => sessionRequest(gate, 'send', { residentCounts: prepared.counts }), async (log, request) => {
      const pullRequest = await sessionRequest(gate, 'residents');
      log(`Changed blocks: ${Object.entries(prepared.changedBlocks).map(([name, b]) => `${name} [${b.join(', ')}]`).join('; ')}`);
      await dk.pushToGate(client(), request, { files: prepared.files, maps: prepared.maps, onStatus: log });
      log('Send finished; pulling residents to check');
      const { files } = await dk.pullFromGate(client(), 'residents', pullRequest, { onStatus: log });
      log(await recordGateState(gate.phoneNumber, boardOf(files), gate.masterCode));
      const check = await dk.verifySend(store, gate.phoneNumber, files, prepared.files);
      if (!check.matches) {
        await applyResidentsPull(gate, files, log);
        throw new Error(`Check pull differs from what was sent: ${JSON.stringify(check.differentBlocks)}. What the gate doesn't hold is still unsent.`);
      }
      const beforeCache = await dk.readCacheFiles(store, gate.phoneNumber).catch(() => null);
      const later = await serial(gate.phoneNumber, () => dk.acceptSentPull(store, gate.phoneNumber, files, prepared.files));
      const board = boardOf(files);
      if (board) await dk.archivePull(store, gate.phoneNumber, board, { actor: gate.actor }).catch(logged('gate', 'Pull archive failed'));
      await dk.markRerollsSynced(store, gate.phoneNumber).catch(logged('gate', 'Could not mark rerolls synced'));
      // Notify any portal-enabled resident whose entryCode changed in this send (Push hides the digits).
      if (beforeCache) {
        try {
          const beforeState = dk.decodeWorking({ names: beforeCache['names.bin'].base, phone: beforeCache['phone.bin'].base, cards: beforeCache['cards.bin'].base });
          const afterState = dk.decodeWorking({ names: prepared.files['names.bin'], phone: prepared.files['phone.bin'], cards: prepared.files['cards.bin'] });
          const prevCodes = new Map(beforeState.residents.map((r) => [dk.noteKey(r.directoryCode), r.entryCode]));
          for (const r of afterState.residents) {
            if (r.entryCode !== (prevCodes.get(dk.noteKey(r.directoryCode)) || '')) {
              await notifyResidentCodeChanged(gate.phoneNumber, r.directoryCode, { synced: true });
            }
          }
        } catch (err) { logger('gate').warn`Resident code-change notice skipped: ${(err as Error).message}`; }
      }
      const lines = later ? ['Check passed: the gate holds what was sent. Changes saved while sending:', ...pullLines(later)]
        : ['Check passed: the gate holds the working copy, which now matches the gate.'];
      for (const line of lines) log(line);
    }, {
      ...info,
      details: Object.entries(prepared.changedBlocks).filter(([, b]) => b.length)
        .map(([name, b]) => ({ key: name, label: name, change: 'sent' as RecordChange['change'], fields: [{ field: 'Blocks', from: '', to: b.join(', ') }] })),
    });
  }
  /**
   * Computes a resident-safe live availability + progress `%` snapshot for a gate (or another gate sharing its DKS login).
   *
   * @param gate - Resolved gate record.
   * @returns Availability and estimated `%` progress.
   */
  function progressForJob(what: string | undefined, lines: string[]): { percent: number; phase: string } {
    const last = lines[lines.length - 1] || '';
    if (what === 'send') {
      if (/check passed|finished/i.test(last)) return { percent: 95, phase: 'Verifying update…' };
      if (/pulling residents to check/i.test(last)) return { percent: 75, phase: 'Verifying gate data…' };
      if (/sending|uploading|transferring|status/i.test(last) || lines.length >= 4) {
        return { percent: Math.min(70, 25 + lines.length * 6), phase: 'Sending changes to gate…' };
      }
      return { percent: 20, phase: 'Preparing gate update…' };
    }
    if (what === 'residents') {
      if (/working copy|read cards\.bin/i.test(last)) return { percent: 85, phase: 'Finishing sync…' };
      if (/read phone\.bin/i.test(last)) return { percent: 65, phase: 'Reading directory…' };
      if (/read names\.bin/i.test(last)) return { percent: 45, phase: 'Reading directory…' };
      return { percent: Math.min(40, 15 + lines.length * 5), phase: 'Syncing with gate…' };
    }
    return { percent: Math.min(85, 20 + lines.length * 10), phase: 'Syncing gate activity…' };
  }

  function jobStatusFor(gate: Gate): { available: boolean; busyReason?: string; percent: number | null; phase?: string } {
    const busyJob = [...jobs.values()].find((j) => j.state === 'running' && j.account === accountOf(gate.user));
    if (!busyJob) {
      if (accountBusy(gate)) return { available: false, busyReason: 'relay', percent: 50, phase: 'Gate command in progress…' };
      return { available: true, percent: null };
    }
    const { percent, phase } = progressForJob(busyJob.what, busyJob.log);
    return { available: false, busyReason: busyJob.what === 'send' ? 'sending' : 'pulling', percent, phase };
  }

  /**
   * Fail-safe momentary gate pulse ("Buzz Me In"): checks `GetRelays` first (never touching an already-held relay),
   * persists a `relay_timers` auto-release safety net, pulses `SetRelays('1')`, waits `pulseSeconds`, then sends
   * `SetRelays('0')` and clears the timer.
   *
   * @param gate - Resolved gate record.
   * @param relay - Relay index (0–18).
   * @param pulseSeconds - Hold duration in seconds before releasing (2–15 s).
   * @returns Promise resolving to `{ alreadyOpen: boolean }`.
   */
  async function pulseRelay(gate: Gate, relay: number, pulseSeconds: number): Promise<{ alreadyOpen: boolean }> {
    const seconds = Math.min(15, Math.max(2, Math.round(pulseSeconds || 4)));
    return withAccount(gate, async () => {
      const current = await dk.checkRelays(client(), gate);
      if (current[relay]?.code === '1') return { alreadyOpen: true };
      const safetyRelease = new Date(Date.now() + Math.max(seconds + 20, 30) * 1000);
      await dk.setRelayTimer(store, gate.phoneNumber, relay, safetyRelease, gate.actor);
      try {
        await dk.controlRelays(client(), gate, { [relay]: true });
      } catch (err) {
        await dk.clearRelayTimer(store, gate.phoneNumber, relay).catch(() => {});
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      try {
        await dk.controlRelays(client(), gate, { [relay]: false });
        await dk.clearRelayTimer(store, gate.phoneNumber, relay);
      } catch (err) {
        logger('gate').warn`Gate ${gate.phoneNumber}: Buzz Me In release failed (safety timer stays armed): ${(err as Error).message}`;
        throw err;
      }
      return { alreadyOpen: false };
    });
  }

  return { roleText, startLoginCheck, recordGateState, startPull, residentCounts, prepareGateSend, startSend, jobStatusFor, pulseRelay };
}
type Transfers = ReturnType<typeof createTransfers>;

/**
 * Scheduled transfers: due entries queued per DKS account and run one after another.
 *
 * @param deps - Injected module dependencies.
 * @param connections - `Connections` value.
 * @param transfers - `Transfers` value.
 * @returns Operation result.
 */
function createScheduler(deps: ContextModule & SnapshotsModule & MailModule, connections: Connections, transfers: Transfers) {
  const { asGate, client, config, gateAlert, logged, prefsOf, scheduledSnapshots, store } = deps;
  const { accountBusy, accountOf, connectionsIdle, isStopping, withAccount } = connections;
  const { prepareGateSend, startPull, startSend } = transfers;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const scheduleText = (schedule: Schedule) => `${schedule.enabled ? '' : 'off, '}${schedule.days.map((day) => DAY_NAMES[day]).join(' ')} ${schedule.time}: ${schedule.actions.join(', ')}`;
  /**
   * Scheduled transfers: checked every 30 s and once at startup, so a time missed while the server was stopped
   * runs once. Due entries queue up per DKS account and run one at a time on it, each transfer waiting until the
   * account is free; entries on different accounts run at the same time.
   */
  const SCHEDULE_TICK_MS = config.schedules.checkSeconds * 1000;
  const scheduleQueue: { schedule: Schedule; account: string; now: boolean }[] = []; // now: queued by Run now
  const runningSchedules = new Map<string, Schedule>(); // DKS account -> the entry running on it
  const isScheduleQueued = (id: string): boolean => scheduleQueue.some((queued) => queued.schedule.id === id)
    || [...runningSchedules.values()].some((schedule) => schedule.id === id);
  const scheduleRunningFor = (phone: string): boolean => [...runningSchedules.values()].some((schedule) => schedule.phoneNumber === phone);
  /**
   * Takes the gate's waiting entries off the queue (its stored data is being deleted).
   *
   * @param phone - Gate system phone number (digits or formatted).
   */
  function dropQueuedSchedules(phone: string): void {
    for (let i = scheduleQueue.length - 1; i >= 0; i--) if (scheduleQueue[i].schedule.phoneNumber === phone) scheduleQueue.splice(i, 1);
  }
  const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
  /**
   * Idle once every running connection and schedule ended (server shutdown).
   *
   * @returns True when the condition holds.
   */
  const jobsIdle = (): boolean => connectionsIdle() && !runningSchedules.size;
  async function queueSchedule(schedule: Schedule, now = false): Promise<boolean> {
    if (isStopping() || isScheduleQueued(schedule.id)) return false;
    const rec = await dk.getGate(store, schedule.phoneNumber);
    if (isStopping() || isScheduleQueued(schedule.id)) return false;
    scheduleQueue.push({ schedule, account: accountOf(rec && rec.dksUser), now });
    for (const { account } of scheduleQueue) if (!runningSchedules.has(account)) runAccountQueue(account);
    return true;
  }
  let checkingSchedules = false;
  /** Releases any live relays whose timed hold-open (`relay_timers`) has expired. */
  async function checkRelayTimers(): Promise<void> {
    if (isStopping()) return;
    for (const timer of await dk.dueRelayTimers(store)) {
      if (isStopping()) return;
      const rec = await dk.getGate(store, timer.phone);
      if (!rec) { await dk.clearRelayTimer(store, timer.phone, timer.relay); continue; }
      const gate = asGate(rec, 'admin', 'timer');
      if (accountBusy(gate)) continue; // try again on next tick once the DKS login is free
      const labels: Record<string, string | undefined> = (await prefsOf(gate.phoneNumber)).relayLabels || {};
      const label = labels[timer.relay] || `Relay ${timer.relay}`;
      try {
        await withAccount(gate, () => dk.controlRelays(client(), gate, { [timer.relay]: false }));
        await dk.clearRelayTimer(store, gate.phoneNumber, timer.relay);
        const summary = `${label} auto-released (timed hold ended)`;
        logger('gate').info`Gate ${gate.phoneNumber}: ${summary}`;
        await dk.addEvent(store, gate.phoneNumber, { user: 'app', action: 'relay', summary, result: 'done' });
      } catch (err) {
        const message = (err as Error).message;
        const attempts = await dk.recordRelayTimerFailure(store, gate.phoneNumber, timer.relay, message);
        logger('gate').error`Gate ${gate.phoneNumber}: auto-release of ${label} failed (try ${attempts}): ${message}`;
        if (attempts === 3) {
          await gateAlert(gate.phoneNumber, `Auto-release of ${label} failed`, `The timed hold set by ${timer.setBy} could not release the gate after 3 tries. Error: ${message}`).catch(logged('email', 'Gate alert not sent'));
        }
      }
    }
  }
  async function checkSchedules() {
    if (checkingSchedules || isStopping()) return;
    checkingSchedules = true;
    const now = new Date();
    try {
      await checkRelayTimers();
      for (const sch of await dk.listSchedules(store)) {
        if (!dk.scheduleIsDue(sch, now)) continue;
        await dk.updateScheduleRun(store, sch.id, { lastDue: dk.lastDue(sch, now)!.toISOString() });
        await queueSchedule(sch);
      }
    } catch (err) { logger('schedule').error`Schedule check failed: ${(err as Error).message}`; }
    finally { checkingSchedules = false; }
  }
  /**
   * Runs the account's queued entries one after another.
   *
   * @param account - Normalized (lowercase) DKS Cloud login name.
   */
  async function runAccountQueue(account: string) {
    if (runningSchedules.has(account)) return;
    for (let i = scheduleQueue.findIndex((queued) => queued.account === account); i >= 0 && !isStopping();
      i = scheduleQueue.findIndex((queued) => queued.account === account)) {
      const [{ schedule: queued, now }] = scheduleQueue.splice(i, 1);
      runningSchedules.set(account, queued); // the login is busy from here, also while the schedule is reread
      try {
        /**
         * As it is now: changed while it waited, it runs as changed; deleted (or turned off, unless run now), not at all.
         */
        const schedule = await dk.getSchedule(store, queued.phoneNumber, queued.id).catch(() => queued);
        if (!schedule || (!schedule.enabled && !now)) {
          logger('schedule').info`Gate ${queued.phoneNumber}: schedule ${queued.id} not run (${schedule ? 'turned off' : 'deleted'} while it waited)`;
          continue;
        }
        runningSchedules.set(account, schedule);
        await runSchedule(schedule);
      } finally { runningSchedules.delete(account); }
    }
  }
  /**
   * Runs an entry's transfers in SCHEDULE_ACTIONS order with the gate's DKS login. A failed transfer does
   * not stop the others; the entry's last result lists every error. Send is skipped when the working copy has
   * no changes. Snapshots do not use the gate connection.
   *
   * @param sch - Scheduled transfer entry.
   * @throws Error when validation or the underlying operation fails.
   */
  async function runSchedule(sch: Schedule) {
    const errors: string[] = [];
    const notes: string[] = [];
    const since = new Date();
    logger('schedule').info`Gate ${sch.phoneNumber}: schedule ${sch.id} started for ${sch.user} (${sch.actions.join(', ')})`;
    try {
      const rec = await dk.getGate(store, sch.phoneNumber);
      if (!rec) throw new Error('The gate is no longer managed here');
      const gate = asGate(rec, 'admin', sch.user);
      for (const what of dk.SCHEDULE_ACTIONS.filter((action) => sch.actions.includes(action))) {
        const outcome = await runScheduledAction(gate, what, since).catch((err: Error): { error?: string; note?: string } => ({ error: err.message }));
        if (outcome.error) errors.push(`${what}: ${outcome.error}`);
        if (outcome.note) notes.push(outcome.note);
      }
    } catch (err) { errors.push((err as Error).message); }
    await recordScheduleOutcome(sch, errors, notes);
  }
  /**
   * One transfer of a schedule (snapshots don't use the gate connection; the others wait until the account is free).
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
   * @param since - Lower-bound timestamp.
   * @returns Promise resolving to `{ error?: string; note?: string }`.
   */
  async function runScheduledAction(gate: Gate, what: ScheduleAction, since: Date): Promise<{ error?: string; note?: string }> {
    if (isStopping()) return { error: 'not run, the server was stopping' };
    if (what === 'snapshots') return scheduledSnapshots(gate.phoneNumber, gate.dir, since);
    if (what === 'send' && !(await dk.cacheStatus(store, gate.phoneNumber)).edited) return { note: 'Send skipped: no changes' };
    let prepared: PreparedSend | null = null;
    do {
      while (accountBusy(gate)) await sleep(2000);
      if (what === 'send') prepared = await prepareGateSend(gate);
    } while (accountBusy(gate)); // another connection started on the account while the send was being prepared
    if (isStopping()) return { error: 'not run, the server was stopping' };
    const job = await (what === 'send' ? startSend(gate, prepared!, { scheduled: true }) : startPull(gate, what, { scheduled: true }));
    return job.state === 'failed' ? { error: job.error } : {};
  }
  /**
   * Logs a schedule's run, alerts the gate's admins when it failed, and saves its last result.
   *
   * @param sch - Scheduled transfer entry.
   * @param errors - `string[]` value.
   * @param notes - `string[]` value.
   */
  async function recordScheduleOutcome(sch: Schedule, errors: string[], notes: string[]): Promise<void> {
    logger('schedule')[errors.length ? 'error' : 'info']`Gate ${sch.phoneNumber}: schedule ${sch.id} ${errors.length ? `failed: ${errors.join('; ')}` : 'done'}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    if (errors.length) {
      await gateAlert(sch.phoneNumber, 'Scheduled transfer failed', `Schedule ${sch.days.map((day) => DAY_NAMES[day]).join(' ')} ${sch.time} (${sch.actions.join(', ')}).\nErrors: ${errors.join('; ')}`).catch(logged('email', 'Gate alert not sent'));
    }
    try {
      await dk.updateScheduleRun(store, sch.id, {
        lastRun: new Date().toISOString(),
        lastResult: errors.length ? 'failed' : 'done',
        lastError: [...errors, ...notes].join('; ') || null,
      });
    } catch (err) { logger('schedule').error`Schedule result not saved: ${(err as Error).message}`; }
  }

  return { scheduleText, SCHEDULE_TICK_MS, isScheduleQueued, scheduleRunningFor, dropQueuedSchedules, jobsIdle, queueSchedule, checkSchedules, checkRelayTimers };
}

/**
 * Create jobs.
 *
 * @param deps - Injected module dependencies.
 * @returns Operation result.
 */
export function createJobs(deps: ContextModule & EditingModule & MailModule & SnapshotsModule & WebhooksModule) {
  const connections = createConnections(deps);
  const transfers = createTransfers(deps, connections);
  const scheduler = createScheduler(deps, connections, transfers);
  const { accountBusy, addingJobOf, busy, currentJob, forgetJob, runningJobs, stopNewJobs, withAccount } = connections;
  const { prepareGateSend, recordGateState, residentCounts, roleText, startLoginCheck, startPull, startSend, jobStatusFor, pulseRelay } = transfers;
  return {
    accountBusy, addingJobOf, busy, currentJob, forgetJob, runningJobs, stopNewJobs, withAccount,
    prepareGateSend, recordGateState, residentCounts, roleText, startLoginCheck, startPull, startSend, jobStatusFor, pulseRelay, ...scheduler,
  };
}

export type JobsModule = ReturnType<typeof createJobs>;
