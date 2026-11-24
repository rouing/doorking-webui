/**
 * @module web/ui/settings/useGateSettings
 *
 * Gate settings from the working copy of names.bin, with unsaved edits kept on the page (keyed by setting).
 * Save writes them into the working copy; settings saved but not yet on the gate are "pending".
 */
import { useCallback, useContext, useEffect, useState } from 'react';
import type { GateSettingRow, SettingsReply } from '../types.ts';
import { errorText, WorkingCopySavedContext, type GateApi } from '../api.ts';

/**
 * Gs show.
 *
 * @param value - Input value.
 * @returns Computed result.
 */
export const gsShow = (value: string) => (value === '' ? '(empty)' : `"${value}"`);

export type GateSettings = ReturnType<typeof useGateSettings>;

/**
 * Use gate settings.
 *
 * @param gapi - Gate-scoped API fetch helper.
 * @returns Operation result.
 */
export function useGateSettings(gapi: GateApi) {
  const saved = useContext(WorkingCopySavedContext);
  const [reply, setReply] = useState<SettingsReply | null>(null);
  const [error, setError] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { setReply(await gapi<SettingsReply>('GET', '/settings')); setError(''); } catch (err) { setReply(null); setError(errorText(err)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  const fields = reply ? reply.fields : [];
  const current = (setting: GateSettingRow) => (setting.key in edits ? edits[setting.key] : setting.value);
  const edit = (setting: GateSettingRow, value: string) => setEdits(({ [setting.key]: _, ...rest }) => (value === setting.value ? rest : { ...rest, [setting.key]: value }));
  const field = (key: string) => fields.find((setting) => setting.key === key);
  const pending = fields.filter((setting) => setting.value !== setting.gate);
  const names = reply ? reply.cache.files.find((file) => file.name === 'names.bin') : undefined;

  /**
   * Saves the edits for `keys` (all edits when omitted). Returns the server's { changed, changedBlocks }.
   *
   * @param [keys] - Optional list of setting keys to save (defaults to all edited keys).
   * @returns Promise resolving to the operation result.
   */
  const save = async (keys?: string[]) => {
    const body = keys ? Object.fromEntries(Object.entries(edits).filter(([k]) => keys.includes(k))) : edits;
    const result = await gapi<{ changed: { name: string; from: string; to: string }[]; changedBlocks: number[] }>('PUT', '/settings', body);
    setEdits((current) => (keys ? Object.fromEntries(Object.entries(current).filter(([k]) => !keys.includes(k))) : {}));
    await Promise.all([load(), saved()]);
    return result;
  };
  const discard = (keys?: string[]) => setEdits((current) => (keys ? Object.fromEntries(Object.entries(current).filter(([k]) => !keys.includes(k))) : {}));

  return {
    reply, error, fields, edits, current, edit, field, save, discard, load, pending,
    blocks: (names && names.changedBlocks) || [],
    conflicts: reply ? reply.cache.conflicts : [],
    changes: pending.map((setting) => `${setting.name}: ${gsShow(setting.gate)} → ${gsShow(setting.value)}`),
  };
}
