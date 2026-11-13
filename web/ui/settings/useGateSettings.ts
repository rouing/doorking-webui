// Gate settings from the working copy of names.bin, with unsaved edits kept on the page (keyed by setting).
// Save writes them into the working copy; settings saved but not yet on the gate are "pending".
import { useCallback, useEffect, useState } from 'react';
import type { GateSettingRow, SettingsReply } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';

export const gsShow = (v: string) => (v === '' ? '(empty)' : `"${v}"`);

export type GateSettings = ReturnType<typeof useGateSettings>;

export function useGateSettings(gapi: GateApi) {
  const [reply, setReply] = useState<SettingsReply | null>(null);
  const [error, setError] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try { setReply(await gapi<SettingsReply>('GET', '/settings')); setError(''); } catch (e) { setReply(null); setError(errorText(e)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  const fields = reply ? reply.fields : [];
  const current = (s: GateSettingRow) => (s.key in edits ? edits[s.key] : s.value);
  const edit = (s: GateSettingRow, v: string) => setEdits(({ [s.key]: _, ...rest }) => (v === s.value ? rest : { ...rest, [s.key]: v }));
  const field = (key: string) => fields.find((f) => f.key === key);
  const pending = fields.filter((s) => s.value !== s.gate);
  const names = reply ? reply.cache.files.find((f) => f.name === 'names.bin') : undefined;

  // Saves the edits for `keys` (all edits when omitted). Returns the server's { changed, changedBlocks }.
  const save = async (keys?: string[]) => {
    const body = keys ? Object.fromEntries(Object.entries(edits).filter(([k]) => keys.includes(k))) : edits;
    const r = await gapi<{ changed: { name: string; from: string; to: string }[]; changedBlocks: number[] }>('PUT', '/settings', body);
    setEdits((e) => (keys ? Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k))) : {}));
    await load();
    return r;
  };
  const discard = (keys?: string[]) => setEdits((e) => (keys ? Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k))) : {}));

  return {
    reply, error, fields, edits, current, edit, field, save, discard, load, pending,
    blocks: (names && names.changedBlocks) || [],
    conflicts: reply ? reply.cache.conflicts : [],
    changes: pending.map((s) => `${s.name}: ${gsShow(s.gate)} → ${gsShow(s.value)}`),
  };
}
