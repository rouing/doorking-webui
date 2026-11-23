/**
 * @module web/editing
 *
 * The working copy: gate data views, settings, relays, edits with History, reverts and preferences.
 */
import type { FastifyReply } from 'fastify';
import * as dk from '../index.ts';
import { cameraRows, loadData, residents, residentRows, type GateFiles } from './data.ts';
import type { BoardBuffers, ResidentEdit } from '../src/residents-edit.ts';
import type { Patch, RecordChange } from '../src/audit.ts';
import type { ValuesPatch } from '../src/gate-state.ts';
import type { CacheStatus } from '../src/gate-cache.ts';
import type { GateSetting } from '../src/gate-settings.ts';
import type { DeviceRange, GateFeatures, GatePrefs, GateTracker, ResidentPortalPrefs, ResidentRow } from '../src/types.ts';
import type { Body, Gate, PrefsChange, Reply, Session } from './context.ts';
import type { ContextModule } from './context.ts';
import { logger } from '../src/logging.ts';

/**
 * Runs fn (returning [status, body]) after the gate's earlier changes and records what it changed in the working copy.
 * ctx: the working copy before the change; applyToCache(..., ctx) uses it and records the result, so History needn't
 * build the files again.
 */
interface EditContext { before: BoardBuffers | null; after?: BoardBuffers }

/**
 * The gate's relay rules: which relays are Tracker command relays, which can be switched live, and tone clashes.
 *
 * @param deps - Injected module dependencies.
 * @returns Operation result.
 */
function createRelayRules(deps: ContextModule) {
  const { prefsOf } = deps;
  const TONE_NAMES: Record<string, string> = { ToneMomentary: 'Momentary', ToneHold: 'Hold', ToneRelease: 'Release', ToneHold1Hr: 'Hold 1 Hr' };
  /**
   * Tracker command relays: relay 1 with Tracker 1, relay 2 with Tracker 2 (their row is locked on the Relays page).
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @returns Promise resolving to `number[]`.
   */
  async function commandRelays(phone: string): Promise<number[]> {
    const tracker = (await prefsOf(phone)).tracker;
    return tracker && tracker.enabled ? [...(tracker.tracker1 ? [1] : []), ...(tracker.tracker2 ? [2] : [])] : [];
  }
  /**
   * Relays live control may set: 0-2 except Tracker command relays, plus 3-10 with Tracker 2 and 11-18 with Tracker 1.
   *
   * @param cmd - `number[]` value.
   * @returns `number[]` result.
   */
  function liveRelays(cmd: number[]): number[] {
    const range = (from: number) => Array.from({ length: 8 }, (_, i) => from + i);
    return [...[0, 1, 2].filter((relay) => !cmd.includes(relay)), ...(cmd.includes(2) ? range(3) : []), ...(cmd.includes(1) ? range(11) : [])];
  }
  /**
   * Tone-open digits used by more than one tone of relays 0-2, e.g. "3 (Relay 0 Momentary, Relay 1 Hold)".
   * Relays in `skip` are left out.
   *
   * @param settings - Settings map or configuration.
   * @param skip - `number[]` value.
   * @returns `string[]` result.
   */
  function toneConflicts(settings: GateSetting[], skip: number[]): string[] {
    const uses = new Map<string, string[]>();
    for (const setting of settings) {
      const match = /^relay(\d)(Tone\w+)$/.exec(setting.key);
      if (!match || !setting.value || skip.includes(Number(match[1]))) continue;
      uses.set(setting.value, [...(uses.get(setting.value) || []), `Relay ${match[1]} ${TONE_NAMES[match[2]] || match[2]}`]);
    }
    return [...uses].filter(([, list]) => list.length > 1).map(([code, list]) => `${code} (${list.join(', ')})`);
  }
  return { commandRelays, liveRelays, toneConflicts };
}
type RelayRules = ReturnType<typeof createRelayRules>;

/**
 * Reading and changing the working copy: the pages' data, gate settings, duplicate checks and the board buffers.
 *
 * @param deps - Injected module dependencies.
 * @param relays - `RelayRules` value.
 * @returns Operation result.
 */
function createWorkingCopy(deps: ContextModule, relays: RelayRules) {
  const { defaults, prefsOf, store } = deps;
  const { toneConflicts } = relays;
  /**
   * A page of the transaction list (the saved history, tx-history.ts; GET /data), with names from the working copy's
   * values and transactions.next for the older page.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @param page - `{ before?: number; limit: number }` value.
   * @returns Promise resolving to the operation result.
   */
  const gateData = async (phone: string, page: { before?: number; limit: number }) => {
    const [prefs, tx, pulledAt, working, portalEvents] = await Promise.all([
      prefsOf(phone), dk.readTransactionPage(store, phone, page),
      dk.txPulledAt(store, phone), dk.loadWorkingState(store, phone),
      page.before ? Promise.resolve([]) : dk.listPortalEvents(store, phone, { limit: 200 }),
    ]);
    const data = loadData(pulledAt, working && working.state, prefs.deviceAssociation, tx.records);
    const nameByCode = new Map((working?.state.residents || []).map((r) => [dk.noteKey(r.directoryCode), r.name]));
    const synthetic = portalEvents.map((ev) => dk.portalEventToTxRow(ev, nameByCode, prefs.relayLabels));
    if (!data.transactions && !synthetic.length) return { transactions: null };
    const rows = [...(data.transactions?.rows || []), ...synthetic].sort((a, b) => b.ts - a.ts);
    const updated = data.transactions?.updated || (synthetic[0] ? new Date(synthetic[0].ts).toISOString() : new Date().toISOString());
    return { transactions: { updated, rows, next: tx.next } };
  };
  /**
   * Every saved transaction, as the camera code needs it (time, event type, access).
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @returns Computed result.
   */
  const cameraTransactions = async (phone: string) => cameraRows((await dk.readTransactionPage(store, phone)).records);
  const TX_PAGE = 2000;
  const TX_PAGE_MAX = 10000;
  /**
   * Gate settings are read from and saved to the working copy (see gate-cache.ts); the base copy stays as the
   * gate's values. Nothing is sent to the gate.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @returns HTTP `[status, body]` reply tuple.
   */
  async function gateSettings(phone: string): Promise<Reply> {
    const status = await dk.ensureCache(store, phone);
    const names = await dk.readCacheFile(store, phone, 'names.bin');
    const hide = (value: string) => '•'.repeat(value.length);
    const gate = dk.decodeGateSettings(names.base);
    const fields = dk.decodeGateSettings(names.data).map((setting, i) => (setting.secret
      ? { ...setting, value: hide(setting.value), gate: hide(gate[i].value) } : { ...setting, gate: gate[i].value }));
    return [200, { pulled: names.baseTime, saved: names.savedTime, cache: status, fields }];
  }
  /**
   * A save that changes a tone-open digit is refused while two tones share a digit.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param changes - Map of setting keys to new values.
   * @param cmd - `number[]` value.
   * @returns HTTP `[status, body]` reply tuple.
   */
  async function saveSettings(gate: Gate, changes: Body, cmd: number[]): Promise<Reply> {
    const names = await dk.readCacheFile(store, gate.phoneNumber, 'names.bin');
    const { buffer, changed } = dk.applyGateSettings(names.data, changes);
    if (!changed.length) return [400, { error: 'No changes to save' }];
    if (Object.keys(changes).some((key) => /^relay\dTone/.test(key))) {
      const clash = toneConflicts(dk.decodeGateSettings(buffer), cmd);
      if (clash.length) return [400, { error: `Each tone-open digit can be used only once. Used more than once: ${clash.join('; ')}` }];
    }
    const { changedBlocks } = await dk.writeCacheFile(store, gate.phoneNumber, 'names.bin', buffer);
    return [200, { changed, changedBlocks }];
  }
  /**
   * Refuses (409) a send while the working copy has a directory code, entry code or card held by more than one entry.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @throws HTTP 409 error on invalid input or conflict.
   */
  async function refuseDuplicates(phone: string): Promise<void> {
    const dups = dk.findDuplicates(await readBuffers(phone));
    if (dups.length) {
      throw dk.httpError(`Fix these before sending: ${dups.map((duplicate) => duplicate.text).join('; ')}`, 409);
    }
  }
  /**
   * Residents/vendors read from and saved to the working copy (never the gate). The editor keys on the
   * directory code; the area-code table lets the UI offer existing area codes. Each row carries its local note.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @returns Promise resolving to the operation result.
   */
  async function editorResidents(gate: Gate) {
    const [notes, portals] = await Promise.all([dk.getNotes(store, gate.phoneNumber), dk.getResidentPortals(store, gate.phoneNumber)]);
    const { files: work, status: cache } = await dk.readCache(store, gate.phoneNumber);
    const updated = new Date(Math.max(...Object.values(work).map((file) => file.savedTime.getTime())));
    const files = Object.fromEntries(Object.entries(work).map(([name, file]) => [name, { data: file.data, mtime: updated }])) as GateFiles;
    const res = residents(files);
    const rows = res?.rows?.map((resident) => {
      const key = dk.noteKey(resident.directoryCode);
      const portal = portals[key];
      return {
        ...resident,
        note: notes[key] || '',
        email: portal?.email || '',
        portalEnabled: Boolean(portal?.enabled),
        portalInvited: Boolean(portal?.invited),
        portalUsername: portal?.username || '',
      };
    });
    const names = work['names.bin'];
    const areaCodes = dk.areaCodeUsage(names.data, work['phone.bin'].data);
    const emptyCodes = dk.emptySlots(names.data);
    const dirDigits = dk.namesDirDigits(names.data);
    const duplicates = dk.findDuplicates({ names: names.data, phone: work['phone.bin'].data, cards: work['cards.bin'].data });
    const toneField = dk.decodeGateSettings(names.data).find((field) => field.key === 'relay0ToneMomentary');
    const grantAccessDigit = toneField && toneField.value ? toneField.value : '9';
    return [200, { ...res, rows, areaCodes, emptyCodes, dirDigits, duplicates, grantAccessDigit, cache, pulled: names.baseTime, saved: names.savedTime }] as const;
  }
  const WORK_FILES: (keyof BoardBuffers)[] = ['names', 'phone', 'cards'];
  /**
   * The three working-copy buffers (throws when there is no working copy).
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @returns Promise resolving to `BoardBuffers`.
   */
  async function readBuffers(phone: string): Promise<BoardBuffers> {
    const work = await dk.readCacheFiles(store, phone);
    return { names: work['names.bin'].data, phone: work['phone.bin'].data, cards: work['cards.bin'].data };
  }
  /**
   * Reads the three working-copy buffers (or takes them from ctx.before, as withHistory read them), runs a transform,
   * and saves the result when it changed anything; ctx.after gets the result, for History.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @param transform - `(bufs: BoardBuffers) => BoardBuffers` value.
   * @param [ctx] - `EditContext` value.
   * @returns Promise resolving to `[number, { changed: Record<string, number[]>; cache: CacheStatus }]`.
   */
  async function applyToCache(phone: string, transform: (bufs: BoardBuffers) => BoardBuffers, ctx?: EditContext):
    Promise<[number, { changed: Record<string, number[]>; cache: CacheStatus }]> {
    const bufs = ctx?.before || await readBuffers(phone);
    const out = transform(bufs);
    const names = WORK_FILES.filter((file) => !out[file].equals(bufs[file]));
    if (ctx) ctx.after = out;
    if (!names.length) return [200, { changed: {}, cache: await dk.cacheStatus(store, phone) }];
    const saved = await dk.saveCacheFiles(store, phone, Object.fromEntries(WORK_FILES.map((file) => [`${file}.bin`, out[file]])));
    return [200, { changed: Object.fromEntries(names.map((name) => [`${name}.bin`, saved.blocks[`${name}.bin`]])), cache: saved.status }];
  }
  /**
   * The working-copy buffers, or null when there is no working copy yet (other failures are thrown).
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @returns Promise resolving to `BoardBuffers | null`.
   * @throws Error when validation or the underlying operation fails.
   */
  async function workingBuffers(phone: string): Promise<BoardBuffers | null> {
    try {
      return await readBuffers(phone);
    } catch (err) {
      if ((err as { status?: unknown }).status === 404) return null;
      throw err;
    }
  }
  /**
   * Area-code slot limit from the gate's saved "Area codes" setting.
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @returns Computed result.
   */
  const editOpts = async (gate: Gate) => ({
    areaCodeSlots: dk.areaCodeLimit(((await prefsOf(gate.phoneNumber)).gateConfig || {}).areaCodes || defaults.areaCodes),
  });
  /**
   * Downloads a working-copy file (.bin, or its change map as .map), built from the database.
   *
   * @param reply - Fastify reply object.
   * @param phone - Gate system phone number (digits or formatted).
   * @param name - Display name or filename.
   * @returns Promise resolving to the operation result.
   */
  async function sendFile(reply: FastifyReply, phone: string, name: string) {
    const data = await dk.cacheFileData(store, phone, name);
    if (!data) return reply.code(404).send({ error: 'File not available' });
    return reply
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .type('application/octet-stream')
      .send(data);
  }
  return { gateData, cameraTransactions, TX_PAGE, TX_PAGE_MAX, gateSettings, saveSettings, refuseDuplicates, editorResidents, WORK_FILES, applyToCache, workingBuffers, editOpts, sendFile };
}
type WorkingCopy = ReturnType<typeof createWorkingCopy>;

/**
 * History: what each change did (details, revert data), recording it, notes, and reverting an entry.
 *
 * @param deps - Injected module dependencies.
 * @param working - Decoded working-copy state.
 * @returns Operation result.
 */
function createHistoryLog(deps: ContextModule, working: WorkingCopy) {
  const { prefsOf, serial, store } = deps;
  const { WORK_FILES, workingBuffers } = working;
  const RES_FIELDS: Record<string, string> = {
    name: 'Name', type: 'Type', hidden: 'Hidden', areaCode: 'Area code', phone: 'Phone', entryCode: 'Entry code',
    securityLevel: 'Security', floor: 'Floor', elevatorRef: 'Elevator', cards: 'Cards',
  };
  const PREF_LABELS: Record<string, string> = { relayLabels: 'Relay names', deviceAssociation: 'Device Association', gateConfig: 'Gate configuration',
    features: 'Floors and elevators shown', tracker: 'Tracker', adminPhone: 'Building manager phone', requireStrongAdmin: 'Require strong admin sign-in',
    residentPortal: 'Resident portal' };
  const MAX_DETAILS = 200;
  /**
   * What changed between two working copies, for the history page: residents/vendors by directory code and
   * gate settings by field. Secret settings show as changed without their values.
   *
   * @param before - State or buffer before the change.
   * @param after - State or buffer after the change.
   * @returns `RecordChange[]` result.
   */
  function changeDetails(before: BoardBuffers, after: BoardBuffers): RecordChange[] {
    /**
     * A copy that can't be decoded is written to the server log; the entry then lists only what could be compared.
     *
     * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
     * @param decode - `() => T[]` value.
     * @returns `T[]` result.
     */
    const decoded = <T,>(what: string, decode: () => T[]): T[] => {
      try { return decode(); } catch (err) { logger('history').error`Change details: ${what} not decoded: ${(err as Error).message}`; return []; }
    };
    const rows = (bufs: BoardBuffers) => decoded('residents', () => residentRows(bufs).rows);
    const label = (resident: ResidentRow) => `${resident.type} ${resident.directoryCode}${resident.name ? ` (${resident.name})` : ''}`;
    const out = dk.diffRecords(rows(before), rows(after), 'directoryCode', Object.keys(RES_FIELDS), label)
      .map((change) => ({ ...change, fields: change.fields.map((field) => ({ ...field, field: RES_FIELDS[field.field] })) }));
    if (!before.names.equals(after.names)) {
      const settings = (buf: Buffer): GateSetting[] => decoded('gate settings', () => dk.decodeGateSettings(buf));
      const changed = dk.diffRecords(settings(before.names), settings(after.names), 'key', ['value'], (setting) => setting);
      for (const change of changed) {
        const setting = change.label;
        const mask = (value: string) => (setting.secret && value ? '••••' : value);
        out.push({ key: change.key, label: `Gate setting: ${setting.group}`, change: 'changed',
          fields: change.fields.map((field) => ({ field: setting.name, from: mask(field.from), to: mask(field.to) })) });
      }
    }
    if (!out.length) {
      for (const file of WORK_FILES) {
        if (before[file].equals(after[file])) continue;
        const patch = dk.diffBuffers(before[file], after[file]);
        const bytes = patch.whole ? 'layout changed' : `${patch.runs.reduce((total, run) => total + run[1].length / 2, 0)} bytes changed`;
        out.push({ key: file, label: `${file}.bin`, change: 'changed', fields: [{ field: 'Other data', from: '', to: bytes }] });
      }
    }
    if (out.length > MAX_DETAILS) {
      const more = out.length - MAX_DETAILS;
      out.length = MAX_DETAILS;
      out.push({ key: 'more', label: `…and ${more} more`, change: 'changed', fields: [] });
    }
    return out;
  }
  /**
   * Prefs changes as detail rows. Device Association rows are listed as "Row n".
   *
   * @param options - Options object.
   * @param options.before - State or buffer before the change.
   * @param options.after - State or buffer after the change.
   * @returns `RecordChange[]` result.
   */
  function prefsDetails({ before, after }: PrefsChange): RecordChange[] {
    const flat = (value: unknown): Record<string, unknown> => (Array.isArray(value)
      ? Object.fromEntries((value as DeviceRange[]).map((range, i) => [`Row ${i + 1}`, `${range.name} ${range.from}-${range.to}`]))
      : value && typeof value === 'object' ? value as Record<string, unknown>
      : value === undefined || value === null ? {} : { Enabled: value ? 'Yes' : 'No' });
    return Object.keys(after).map((key) => {
      const was = flat(before[key]);
      const now = flat(after[key]);
      const fields = [...new Set([...Object.keys(was), ...Object.keys(now)])]
        .map((field) => ({ field, from: String(was[field] ?? ''), to: String(now[field] ?? '') }))
        .filter((field) => field.from !== field.to);
      return { key, label: PREF_LABELS[key] || key, change: 'changed' as const, fields };
    });
  }
  /**
   * Records a working-copy and/or prefs change in the gate's history, with the patch Revert needs.
   * Nothing is recorded when nothing changed.
   * The working copy's change is stored as values (dk.diffStates: residents, cards, settings and layout, before and
   * after), which Revert undoes.
   *
   * @param session - Authenticated user or API-key session.
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param entry - Resident/vendor entry data or history entry.
   * @param before - State or buffer before the change.
   * @param [prefs] - Gate-scoped preferences object.
   * @param [known] - Map of existing snapshot log entries by minute.
   * @returns Promise resolving to the operation result.
   */
  async function logChange(session: Session, gate: Gate, entry: Record<string, unknown>, before: BoardBuffers | null, prefs: PrefsChange | null = null,
    known?: BoardBuffers) {
    const after = known || await workingBuffers(gate.phoneNumber);
    const changed = Boolean(before && after && WORK_FILES.some((file) => !before[file].equals(after[file])));
    const values = changed ? dk.diffStates(dk.decodeWorking(before!), dk.decodeWorking(after!)) : null;
    if (!values && !prefs) return null;
    const details = [...(changed ? changeDetails(before!, after!) : []), ...(prefs ? prefsDetails(prefs) : [])];
    const event = await dk.addEvent(store, gate.phoneNumber, {
      user: session.user, action: 'change', ...entry, details, ...(values && { values }), ...(prefs && { prefs }),
    });
    logger('change').info`${`Gate ${gate.phoneNumber}: ${String(entry.summary || entry.action || 'change')} by ${session.user}`
      + `${values ? ` (${Object.keys(values).join(', ')})` : ''}`}`;
    return event;
  }
  function withHistory(session: Session, gate: Gate, entry: Record<string, unknown>, fn: (ctx: EditContext) => Reply | Promise<Reply>): Promise<Reply> {
    return serial(gate.phoneNumber, async () => {
      const ctx: EditContext = { before: await workingBuffers(gate.phoneNumber) };
      const out = await fn(ctx);
      if (out[0] < 300) await logChange(session, gate, entry, ctx.before, null, ctx.after);
      return out;
    });
  }
  const pick = (obj: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((key) => [key, obj[key] ?? null]));
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const LATER_CHANGE = 'a later change touched the same data. Revert that change first.';
  const workingCopyOf = (before: BoardBuffers | null): BoardBuffers => {
    if (!before) throw dk.httpError('There is no working copy. Pull residents from the gate.', 409);
    return before;
  };
  /**
   * The working-copy files with a values patch undone (only those that change).
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param before - State or buffer before the change.
   * @param values - Decoded working-copy values.
   * @returns Promise resolving to `Record<string, Buffer>`.
   * @throws HTTP 409 error on invalid input or conflict.
   */
  async function filesWithValuesUndone(gate: Gate, before: BoardBuffers, values: ValuesPatch): Promise<Record<string, Buffer>> {
    const undone = dk.undoValues(dk.decodeWorking(before), values);
    if (!undone) throw dk.httpError(`Cannot revert: ${LATER_CHANGE}`, 409);
    const work = await dk.readCacheFiles(store, gate.phoneNumber);
    let built: BoardBuffers;
    try {
      built = dk.buildFiles({ names: work['names.bin'].base, phone: work['phone.bin'].base, cards: work['cards.bin'].base }, undone,
        { masterCode: gate.masterCode });
    } catch (err) { throw dk.httpError(`Cannot revert: ${(err as Error).message}`, 409); }
    return Object.fromEntries(WORK_FILES.filter((file) => !built[file].equals(before[file])).map((file) => [`${file}.bin`, built[file]]));
  }
  /**
   * Entries from before 2026-11-12 carry byte patches of the files instead.
   *
   * @param before - State or buffer before the change.
   * @param patches - `Record<string, Patch>` value.
   * @returns `Record<string, Buffer>` result.
   */
  function filesWithPatchesUndone(before: BoardBuffers, patches: Record<string, Patch>): Record<string, Buffer> {
    return Object.fromEntries(Object.entries(patches).map(([name, patch]) => {
      const buffer = dk.undoPatch(before[name.replace(/\.bin$/, '') as keyof BoardBuffers], patch);
      if (!buffer) throw dk.httpError(`Cannot revert ${name}: ${LATER_CHANGE}`, 409);
      return [name, buffer];
    }));
  }
  /**
   * The prefs change that undoes change (refused when a later change touched the same prefs).
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param change - Preference change `{ before, after }` to undo.
   * @returns Promise resolving to `PrefsChange`.
   * @throws HTTP 400 error on invalid input or conflict.
   */
  async function prefsUndo(gate: Gate, change: PrefsChange): Promise<PrefsChange> {
    const now: Record<string, unknown> = { ...await prefsOf(gate.phoneNumber) };
    const keys = Object.keys(change.after);
    if (keys.some((key) => !same(now[key], change.after[key]))) {
      throw dk.httpError(`Cannot revert ${keys.map((key) => PREF_LABELS[key] || key).join(', ')}: ${LATER_CHANGE}`, 409);
    }
    return { before: change.after, after: change.before };
  }
  /**
   * Undoes one history entry in the working copy (and prefs) only; the gate changes on the next Send.
   * Refused when a later change touched the same bytes or prefs.
   *
   * @param session - Authenticated user or API-key session.
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param id - Unique record identifier.
   * @returns HTTP `[status, body]` reply tuple.
   */
  async function revertEvent(session: Session, gate: Gate, id: string): Promise<Reply> {
    const { event: entry, revertedBy: done } = await dk.historyEvent(store, gate.phoneNumber, id);
    if (!entry) return [404, { error: 'History entry not found' }];
    if (!entry.values && !entry.files && !entry.prefs) return [400, { error: 'This entry has nothing to revert' }];
    if (done) return [409, { error: `Already reverted by ${done.user}` }];
    const before = await workingBuffers(gate.phoneNumber);
    const patches = (entry.files || {}) as Record<string, Patch>;
    const restored: Record<string, Buffer> = {
      ...(entry.values ? await filesWithValuesUndone(gate, workingCopyOf(before), entry.values as ValuesPatch) : {}),
      ...(Object.keys(patches).length ? filesWithPatchesUndone(workingCopyOf(before), patches) : {}),
    };
    const prefs = entry.prefs ? await prefsUndo(gate, entry.prefs as PrefsChange) : null;
    if (Object.keys(restored).length) await dk.writeCacheFiles(store, gate.phoneNumber, restored);
    if (prefs) {
      await dk.setPrefs(store, gate.phoneNumber, Object.fromEntries(Object.entries(prefs.after).map(([k, v]) => [k, v ?? undefined])));
    }
    const event = await logChange(session, gate, { action: 'revert', revertOf: id, summary: `Reverted: ${entry.summary}` }, before, prefs);
    return [200, { id: event && event.id, cache: await dk.cacheStatus(store, gate.phoneNumber) }];
  }
  /**
   * Saves (or, blank, clears) the local note of a directory code and records the change in history.
   *
   * @param session - Authenticated user or API-key session.
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param code - Directory code, HTTP status code, or verification code.
   * @param note - `unknown` value.
   * @param [why] - Why.
   * @returns Promise resolving to `string`.
   */
  async function saveNote(session: Session, gate: Gate, code: string, note: unknown, why = ''): Promise<string> {
    const before = await dk.getNote(store, gate.phoneNumber, code);
    const after = await dk.setNote(store, gate.phoneNumber, code, note, session.user);
    if (before !== after) {
      const summary = `${after ? 'Changed' : 'Cleared'} the note for directory code ${code}${why}`;
      await dk.addEvent(store, gate.phoneNumber, {
        user: session.user, action: 'note', summary,
        details: [{ key: code, label: `Directory code ${code}`, change: 'changed', fields: [{ field: 'Note', from: before, to: after }] }],
      });
      logger('change').info`Gate ${gate.phoneNumber}: ${summary} by ${session.user}`;
    }
    return after;
  }
  /**
   * After an entry is deleted or its code removed, its note goes too.
   *
   * @param session - Authenticated user or API-key session.
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param code - Directory code, HTTP status code, or verification code.
   * @param out - HTTP `[status, body]` reply from the delete operation.
   * @returns HTTP `[status, body]` reply tuple.
   */
  async function dropNote(session: Session, gate: Gate, code: string, out: Reply): Promise<Reply> {
    if (out[0] < 300) await saveNote(session, gate, code, '', ' (entry deleted)');
    return out;
  }
  /**
   * Computes human-readable From -> To changes between the gate's base copy (last pull) and the current working copy.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @returns Promise resolving to the list of unsent `RecordChange[]` items.
   */
  async function workingCopyDiff(phone: string): Promise<RecordChange[]> {
    const files = await dk.readCacheFiles(store, phone);
    const base: BoardBuffers = { names: files['names.bin'].base, phone: files['phone.bin'].base, cards: files['cards.bin'].base };
    const current: BoardBuffers = { names: files['names.bin'].data, phone: files['phone.bin'].data, cards: files['cards.bin'].data };
    return changeDetails(base, current);
  }
  return { PREF_LABELS, changeDetails, logChange, withHistory, pick, same, revertEvent, saveNote, dropNote, workingCopyDiff };
}

/**
 * Saving the gate's preferences, including an Area codes change that converts the working copy.
 *
 * @param deps - Injected module dependencies.
 * @param working - Decoded working-copy state.
 * @returns Operation result.
 */
function createPrefsEditor(deps: ContextModule, working: WorkingCopy) {
  const { AREA_CODE_SETTINGS, defaults, GATE_CONFIG_KEYS, logged, objectField, store } = deps;
  const { applyToCache, WORK_FILES, workingBuffers } = working;
  /**
   * Validates and saves gate-scoped prefs. was: the saved prefs. Returns [status, merged prefs].
   *
   * @param gate - Resolved managed gate record with role and DKS credentials.
   * @param body - Parsed JSON request body.
   * @param was - The saved prefs.
   * @returns HTTP `[status, body]` reply tuple.
   * @throws Error when validation or the underlying operation fails.
   */
  async function savePrefs(gate: Gate, body: Body, was: GatePrefs): Promise<Reply> {
    const prefs: Partial<GatePrefs> = {};
    if (body.adminPhone !== undefined) prefs.adminPhone = String(body.adminPhone ?? '').trim().slice(0, 30);
    if (body.requireStrongAdmin !== undefined) {
      if (gate.role !== 'admin') throw dk.httpError('Only a gate admin can change admin security policy.', 403);
      if (typeof body.requireStrongAdmin === 'boolean') prefs.requireStrongAdmin = body.requireStrongAdmin;
    }
    if (body.residentPortal !== undefined) {
      if (gate.role !== 'admin') throw dk.httpError('Only a gate admin can change Resident Portal settings.', 403);
      prefs.residentPortal = dk.normalizeResidentPortalPrefs({ ...(was.residentPortal || {}), ...(objectField(body, 'residentPortal') || {}) });
    }
    const features = objectField(body, 'features');
    if (features) prefs.features = { floors: features.floors !== false, elevators: features.elevators !== false };
    const tracker = objectField(body, 'tracker');
    if (tracker) {
      const time = (value: unknown) => (/^\d{1,3}$/.test(String(value)) && Number(value) <= 255 ? String(Number(value)) : undefined);
      prefs.tracker = { enabled: tracker.enabled === true, tracker1: tracker.tracker1 === true, tracker2: tracker.tracker2 === true,
        prevTime1: time(tracker.prevTime1), prevTime2: time(tracker.prevTime2) };
    }
    /**
     * Only the relays given change (the Relays page saves one name at a time). Relays 0-2 always; Tracker relays
     * 3-18 only when named.
     */
    const relayLabels = objectField(body, 'relayLabels');
    if (relayLabels) {
      const merged: Record<string, unknown> = { ...(was.relayLabels || {}), ...relayLabels };
      prefs.relayLabels = Object.fromEntries(Array.from({ length: 19 }, (_, relay) => String(relay))
        .map((key) => [key, String(merged[key] ?? '').trim().slice(0, 24)])
        .filter(([k, v]) => Number(k) <= 2 || v));
    }
    if (body.deviceAssociation !== undefined) {
      prefs.deviceAssociation = dk.normalizeDeviceAssociation(body.deviceAssociation);
    }
    let undo: BoardBuffers | null = null; // the working copy before an area-code conversion
    const gateConfig = objectField(body, 'gateConfig');
    if (gateConfig) {
      prefs.gateConfig = gateConfigFrom(gateConfig);
      undo = await applyAreaCodeSetting(gate.phoneNumber, prefs.gateConfig.areaCodes || defaults.areaCodes);
    }
    try {
      return [200, await dk.setPrefs(store, gate.phoneNumber, prefs)];
    } catch (err) { // the prefs weren't saved: put the working copy back, so it matches the saved Area codes setting
      if (undo) {
        await dk.saveCacheFiles(store, gate.phoneNumber, { 'names.bin': undo.names, 'phone.bin': undo.phone, 'cards.bin': undo.cards })
          .catch(logged('change', `Gate ${gate.phoneNumber}: area-code conversion not undone`));
      }
      throw err;
    }
  }
  /**
   * The gate configuration's values from a request (each up to 40 characters). Throws 400 on a bad Area codes value.
   *
   * @param raw - Raw unparsed input.
   * @returns `Record<string, string>` result.
   * @throws HTTP 400 error on invalid input or conflict.
   */
  function gateConfigFrom(raw: Record<string, unknown>): Record<string, string> {
    const cfg = Object.fromEntries(GATE_CONFIG_KEYS.map((key) => [key, String(raw[key] ?? '').slice(0, 40)]));
    if (cfg.areaCodes && !AREA_CODE_SETTINGS.includes(cfg.areaCodes)) {
      throw dk.httpError(`Area codes must be ${AREA_CODE_SETTINGS.join(' or ')}`);
    }
    return cfg;
  }
  /**
   * Converts the working copy to the names.bin/phone.bin layout of the "Area codes" setting (see
   * convertAreaCodeMode). Returns the working copy before, when it changed (else null); throws 409 when it can't convert.
   * "10 Area Codes" needs 10 or fewer area codes in use.
   *
   * @param phone - Gate system phone number (digits or formatted).
   * @param setting - `string` value.
   * @returns Promise resolving to `BoardBuffers | null`.
   * @throws HTTP 409 error on invalid input or conflict.
   */
  async function applyAreaCodeSetting(phone: string, setting: string): Promise<BoardBuffers | null> {
    const before = await workingBuffers(phone);
    if (!before) return null; // no working copy yet
    const ctx: EditContext = { before };
    try {
      await applyToCache(phone, (bufs) => dk.convertAreaCodeMode(bufs, dk.areaCodeLimit(setting)), ctx);
    } catch (err) { throw dk.httpError((err as Error).message, 409); }
    return ctx.after && WORK_FILES.some((file) => !ctx.after![file].equals(before[file])) ? before : null;
  }
  return { savePrefs, gateConfigFrom };
}

/**
 * Create editing.
 *
 * @param deps - Injected module dependencies.
 * @returns Operation result.
 */
export function createEditing(deps: ContextModule) {
  const relays = createRelayRules(deps);
  const working = createWorkingCopy(deps, relays);
  const history = createHistoryLog(deps, working);
  const prefs = createPrefsEditor(deps, working);
  const { commandRelays, liveRelays } = relays;
  const { applyToCache, cameraTransactions, editOpts, editorResidents, gateData, gateSettings, refuseDuplicates, saveSettings, sendFile, TX_PAGE, TX_PAGE_MAX, workingBuffers } = working;
  const { changeDetails, dropNote, logChange, pick, PREF_LABELS, revertEvent, same, saveNote, withHistory, workingCopyDiff } = history;
  const { gateConfigFrom, savePrefs } = prefs;
  /** Applies a resident edit + shown rule + tidyBoard inside `applyToCache` (shared by staff, portal, and account phone sync). */
  function editResidentInCache(
    phone: string,
    directoryCode: string,
    fields: Omit<ResidentEdit, 'directoryCode'>,
    opts: Awaited<ReturnType<typeof editOpts>>,
    ctx: EditContext,
  ): Promise<Reply> {
    return applyToCache(
      phone,
      (bufs) => dk.tidyBoard(dk.applyShownRule(dk.applyResidentEdit(bufs, { ...fields, directoryCode }, opts), directoryCode)),
      ctx,
    );
  }

  /** Renders and sends a pre-filled `ResidentInstructions.pdf` with a sanitized Content-Disposition filename. */
  async function sendInstructionsPdf(
    reply: FastifyReply,
    info: { residentName: string; directoryCode: string; entryCode: string; adminPhone: string; grantAccessDigit: string },
  ) {
    const pdf = await dk.fillResidentInstructionsPdf(info);
    const slug = [info.directoryCode, info.residentName]
      .filter(Boolean)
      .join('-')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    const filename = slug ? `ResidentInstructions-${slug}.pdf` : 'ResidentInstructions.pdf';
    return reply
      .code(200)
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(Buffer.from(pdf));
  }

  return { gateData, cameraTransactions, TX_PAGE, TX_PAGE_MAX, gateSettings, saveSettings, commandRelays, liveRelays, refuseDuplicates, editorResidents, saveNote, dropNote, applyToCache, editResidentInCache, sendInstructionsPdf, PREF_LABELS, workingBuffers, changeDetails, logChange, withHistory, pick, same, revertEvent, savePrefs, gateConfigFrom, editOpts, sendFile, workingCopyDiff };
}

export type EditingModule = ReturnType<typeof createEditing>;
