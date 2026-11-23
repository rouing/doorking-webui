/**
 * @module web/routes/working-copy
 *
 * Gate settings, the working copy itself, preferences, History and deleting stored data.
 */
import fs from 'node:fs';
import * as dk from '../../index.ts';
import type { GatePrefs } from '../../src/types.ts';
import type { Modules } from '../modules.ts';
import { G, type Route, route, webOnly } from '../routing.ts';
import { logger } from '../../src/logging.ts';

/**
 * Working copy routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function workingCopyRoutes(modules: Modules): Route[] {
  const { prefsOf, serial, store } = modules.context;
  const {
    changeDetails, commandRelays, gateSettings, logChange, pick, PREF_LABELS, revertEvent, same, savePrefs, saveSettings,
    sendFile, withHistory, workingBuffers
  } = modules.editing;
  const { forgetSnapRun, snapRunOf, snapshotWorkFor } = modules.snapshots;
  const { busy, dropQueuedSchedules, forgetJob, scheduleRunningFor } = modules.jobs;
  return [
    // Gate settings in the working copy's names.bin. PUT body: { <field key>: value, ... }.
    route('GET', `${G}/settings`, 'gate', ({ gate }) => gateSettings(gate.phoneNumber)),
    route('PUT', `${G}/settings`, 'gate-editor', ({ session, gate, body }) => withHistory(session, gate,
      { summary: 'Changed gate settings' }, async () => saveSettings(gate, body, await commandRelays(gate.phoneNumber)))),

    // The working copy: status (with the conflicts to decide), reset to the gate (drops unsent changes), deciding a
    // conflict ({ kind: resident|card|setting, key, choice: mine|gate }), and file downloads (.bin / .map).
    route('GET', `${G}/working-copy`, 'gate', async ({ gate }) => [200, await dk.cacheStatus(store, gate.phoneNumber)]),
    route('DELETE', `${G}/working-copy`, 'gate-editor', ({ session, gate }) => withHistory(session, gate,
      { summary: 'Reset the working copy to the gate (unsent changes dropped)' }, async () => [200, await dk.resetCache(store, gate.phoneNumber)])),
    route('POST', `${G}/working-copy/conflicts`, 'gate-editor', ({ session, gate, body }) => withHistory(session, gate,
      { summary: `${body.choice === 'gate' ? 'Took the gate\'s value' : 'Kept my change'} for a conflict (${String(body.kind)} ${String(body.key)})` },
      async () => [200, await dk.resolveConflict(store, gate.phoneNumber, { kind: body.kind, key: body.key, choice: body.choice })])),
    route('GET', `${G}/files/:name`, 'gate-admin', ({ gate, params, reply }) => sendFile(reply, gate.phoneNumber, params.name)),

    // Gate-scoped local preferences (relay labels, Device Association, gate config), keyed by phone number.
    route('GET', `${G}/prefs`, 'gate', async ({ gate }) => [200, await prefsOf(gate.phoneNumber)]),

    // Changing the area-code setting also converts the working copy; both are one history entry.
    route('PUT', `${G}/prefs`, 'gate-editor', ({ session, gate, body }) => serial(gate.phoneNumber, async () => {
      const saved = await prefsOf(gate.phoneNumber);
      const before = await workingBuffers(gate.phoneNumber);
      const was: Record<string, unknown> = { ...saved };
      const out = await savePrefs(gate, body, saved);
      if (out[0] < 300) {
        const merged: Record<string, unknown> = { ...(out[1] as GatePrefs) };
        const keys = Object.keys(PREF_LABELS).filter((k) => !same(was[k], merged[k]));
        const prefs = keys.length ? { before: pick(was, keys), after: pick(merged, keys) } : null;
        const summary = `Changed ${keys.map((k) => PREF_LABELS[k]).join(', ') || PREF_LABELS.gateConfig}`;
        await logChange(session, gate, { summary }, before, prefs);
      }
      return out;
    })),

    // History: this gate's events (newest first) and minimal user summaries (never exposing private emails/phones to read-only callers).
    route('GET', `${G}/history`, 'gate', async ({ gate }) => [200, {
      events: await dk.listHistory(store, gate.phoneNumber),
      users: (await dk.gateUsers(store, gate.phoneNumber)).map(({ username, role, lastSignIn }) => ({ username, role, lastSignIn })),
    }]),
    route('POST', `${G}/history/:id/revert`, 'gate-editor', ({ session, gate, params }) => serial(gate.phoneNumber, () => revertEvent(session, gate, params.id))),

    // Point-in-time pull archive: list archived residents pulls, preview diff against working copy, or restore one.
    route('GET', `${G}/pull-archive`, 'gate', async ({ gate }) => [200, { pulls: await dk.listPullArchive(store, gate.phoneNumber) }]),
    route('GET', `${G}/pull-archive/:id/diff`, 'gate', async ({ gate, params }) => {
      const archived = await dk.readPullArchive(store, gate.phoneNumber, Number(params.id));
      if (!archived) return [404, { error: 'Archived pull not found' }];
      const current = await workingBuffers(gate.phoneNumber);
      if (!current) return [409, { error: 'There is no working copy. Pull residents from the gate.' }];
      return [200, { pull: archived.entry, changes: changeDetails(current, archived.files) }];
    }),
    route('POST', `${G}/pull-archive/:id/restore`, 'gate-editor', ({ session, gate, params }) => withHistory(session, gate,
      { summary: `Restored working copy from pull #${params.id}` }, async (ctx) => {
        const archived = await dk.readPullArchive(store, gate.phoneNumber, Number(params.id));
        if (!archived) return [404, { error: 'Archived pull not found' }];
        const work = await dk.readCacheFiles(store, gate.phoneNumber);
        const built = dk.buildFiles(
          { names: work['names.bin'].base, phone: work['phone.bin'].base, cards: work['cards.bin'].base },
          dk.decodeWorking(archived.files),
          { masterCode: gate.masterCode },
        );
        const saved = await dk.writeCacheFiles(store, gate.phoneNumber, {
          'names.bin': built.names, 'phone.bin': built.phone, 'cards.bin': built.cards,
        });
        ctx.after = built;
        return [200, { pull: archived.entry, status: await dk.cacheStatus(store, gate.phoneNumber), ...saved }];
      })),

    // Deletes everything stored about the gate: its database rows (every user's gate-list entry, prefs, history,
    // schedules, camera settings, snapshot log, notes, transaction history) and its folder (pulled files, working
    // copy, camera pictures). Nothing on the gate changes. Body: { confirm: true }. Runs after the gate's queued edits,
    // and is refused while anything else works on the gate (its connection or a relay call on its DKS login, snapshots).
    webOnly(route('POST', `${G}/delete-data`, 'gate-admin', ({ session, gate, body }) => serial(gate.phoneNumber, async () => {
      if (body.confirm !== true) return [400, { error: 'Deleting the gate\'s data must be confirmed' }];
      const refused = busy(gate);
      if (refused) return refused;
      if (snapRunOf(gate.phoneNumber)?.state === 'running') return [409, { error: 'Stop the snapshot run first' }];
      if (snapshotWorkFor(gate.phoneNumber)) return [409, { error: 'Wait for the camera pictures to finish updating' }];
      if (scheduleRunningFor(gate.phoneNumber)) return [409, { error: 'Wait for the scheduled transfer to finish' }];
      dropQueuedSchedules(gate.phoneNumber);
      const removed = await dk.deleteGateData(store, gate.phoneNumber);
      forgetSnapRun(gate.phoneNumber);
      forgetJob(gate.phoneNumber);
      let files = '';
      try { fs.rmSync(gate.dir, { recursive: true, force: true }); } catch (err) { files = (err as Error).message; }
      logger('gates')[files ? 'warn' : 'info']`${session.user} deleted all stored data of gate ${gate.phoneNumber}: ${JSON.stringify(removed)}${files ? `; files not all deleted: ${files}` : ''}`;
      return [200, { removed, ...(files && { filesError: files }) }];
    }))),
  ];
}
