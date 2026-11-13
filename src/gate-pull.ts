// Gate sessions through DKS Cloud: start a session, request transactions or resident data (or send resident
// data), wait for the gate to finish, download the files and always end the session.
import type { DksCloudClient, SessionSeries30Params } from './dks-cloud.ts';

export type PullKind = 'transactions' | 'residents';
type Client = Pick<DksCloudClient, 'startSessionSeries30' | 'receiveTransactionData' | 'receiveResidentData'
  | 'waitForSession' | 'getDataFile' | 'endSession' | 'sendResidentData' | 'getRelays' | 'setRelays'>;
type WaitOptions = Parameters<DksCloudClient['waitForSession']>[1];
type OnStatus = (status: string) => void;

export interface SessionOptions {
  user?: string; password?: string; masterCode?: string; phoneNumber?: string; residentCounts?: number[];
  [key: string]: unknown;
}

export interface RelayStatus { relay: number; code: string; state: string }

export interface RelayCredentials {
  user?: string; password?: string; phoneNumber?: string; masterCode?: string; comType?: string;
  attempts?: number; retryMs?: number; onStatus?: OnStatus;
}

export const PULL_FILES: Record<PullKind, string[]> = {
  transactions: ['rcv_out.bin'],
  residents: ['names.bin', 'phone.bin', 'cards.bin'],
};

export const GATE_DEFAULTS = {
  siteName: 'Site',
  memorySize: '3000',
  areaCodes: '255 Area Codes', // the default in the DoorKing 6.5 manual (1.2.12, 3.1.2)
  modelNumber: '1833/1835/1837/1838',
  antiPassBack: 'N',
  interface1816: 'N',
  dialDelay: '3',
};

export const MEMORY_SIZES = ['1000', '2000', '3000'];

export const ZERO_MARKER = '000000000000000000000000';

// Communication types offered by DoorKing32. Only the DKS ones go through DKS Cloud.
export const COM_TYPES = ['DKS Cellular', 'DKS Data over IP', 'DKS VoIP Voice + Data', 'IM Server Modem',
  'Modem-to-Modem', 'Network', 'RS232', 'Diagnostics'];
export const CLOUD_COM_TYPES = COM_TYPES.slice(0, 3);

// UserID suffix per session kind. A send carries two resident counts (DoorKing32 FUN_004f7320).
function sessionTag(what: string, residentCounts: unknown): string {
  if (what === 'transactions') return '-1,-2';
  if (what === 'residents') return '-1,-1';
  if (!Array.isArray(residentCounts) || residentCounts.length !== 2 || !residentCounts.every(Number.isInteger)) {
    throw new Error('A send needs residentCounts [a, b]');
  }
  return residentCounts.join(',');
}

// StartSessionSeries30 parameters. Relay holds are always 'NNN' (no relay held open).
// what = 'transactions' | 'residents' (pulls) | 'send' (needs o.residentCounts).
export function buildSessionRequest(what: string, o: SessionOptions): SessionSeries30Params & { userId: string } {
  if (!PULL_FILES[what as PullKind] && what !== 'send') throw new Error('what must be "transactions", "residents" or "send"');
  for (const k of ['user', 'password', 'masterCode', 'phoneNumber']) {
    if (!o[k]) throw new Error(`Missing ${k}`);
  }
  const g: Record<string, any> = { ...GATE_DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '')) };
  if (!MEMORY_SIZES.includes(String(g.memorySize))) {
    throw new Error(`System memory must be ${MEMORY_SIZES.join(', ')} (got "${g.memorySize}")`);
  }
  return {
    userId: `${o.user}/6.5.b[${g.siteName}]{${sessionTag(what, o.residentCounts)}}`,
    password: o.password,
    userTime: new Date().toLocaleString('en-US'),
    dialDelay: g.dialDelay,
    masterCode: o.masterCode,
    memorySize: g.memorySize,
    phoneNumber: o.phoneNumber,
    relay012Hold: 'NNN',
    interface1816: g.interface1816,
    antiPassBack: g.antiPassBack,
    modelNumber: g.modelNumber,
    areaCodes: g.areaCodes,
  };
}

// Copy of the request that is safe to print or log.
export function maskRequest<T extends { userId: string }>(request: T, user?: string) {
  return {
    ...request,
    userId: user ? request.userId.split(user).join('<user>') : request.userId,
    password: '<hidden>',
    masterCode: '<hidden>',
  };
}

// Runs one pull. Returns { sessionId, status, files: { name: Buffer } }.
export async function pullFromGate(
  client: Client, what: PullKind, request: SessionSeries30Params,
  { marker = ZERO_MARKER, onStatus = () => {}, waitOptions }: { marker?: string; onStatus?: OnStatus; waitOptions?: WaitOptions } = {},
): Promise<{ sessionId: string; status: string; files: Record<string, Buffer> }> {
  const sessionId = String(await client.startSessionSeries30(request)).trim();
  if (!sessionId || /error|fail|invalid/i.test(sessionId)) throw new Error(`StartSessionSeries30: ${sessionId}`);
  onStatus(`Session ${sessionId}`);
  try {
    const reply = what === 'transactions'
      ? await client.receiveTransactionData(sessionId, marker)
      : await client.receiveResidentData(sessionId);
    onStatus(`Request reply: ${reply}`);
    const { status, success } = await client.waitForSession(sessionId, { ...waitOptions, onStatus });
    if (!success) throw new Error(`Session finished without success: ${status}`);
    const files: Record<string, Buffer> = {};
    for (const f of PULL_FILES[what]) files[f] = await client.getDataFile(sessionId, f);
    return { sessionId, status, files };
  } finally {
    onStatus(`EndSession: ${await client.endSession(sessionId).catch((e: Error) => e.message)}`);
  }
}

// SendResidentData reply check as in DoorKing32: "Error" is retried unless it says "already in progress".
export const sendAccepted = (reply: string): boolean => !/Error/.test(reply) || /already in progress/.test(reply);

// Sends the resident files to the gate (request from buildSessionRequest('send', ...)).
// Up to `attempts` SendResidentData calls, then waits for the session. Returns { sessionId, status }.
export async function pushToGate(client: Client, request: SessionSeries30Params, {
  files, maps, oldSendStamp = '', onStatus = () => {}, waitOptions, attempts = 5, retryMs = 1000,
}: {
  files?: Record<string, Buffer>; maps?: Record<string, Buffer>; oldSendStamp?: string; onStatus?: OnStatus;
  waitOptions?: WaitOptions; attempts?: number; retryMs?: number;
} = {}): Promise<{ sessionId: string; status: string }> {
  if (!files || !PULL_FILES.residents.every((f) => Buffer.isBuffer(files[f]))) {
    throw new Error(`A send needs ${PULL_FILES.residents.join(', ')}`);
  }
  const sessionId = String(await client.startSessionSeries30(request)).trim();
  if (!sessionId || /error|fail|invalid/i.test(sessionId)) throw new Error(`StartSessionSeries30: ${sessionId}`);
  onStatus(`Session ${sessionId}`);
  try {
    let reply: string;
    for (let i = 1; ; i++) {
      try {
        reply = String(await client.sendResidentData(sessionId, { files, maps, oldSendStamp }));
        onStatus(`SendResidentData reply: ${reply}`);
        if (sendAccepted(reply)) break;
      } catch (e) {
        reply = (e as Error).message;
        onStatus(`SendResidentData failed: ${reply}`);
      }
      if (i >= attempts) throw new Error(`SendResidentData not accepted after ${attempts} tries: ${reply}`);
      await new Promise((r) => setTimeout(r, retryMs));
    }
    const { status, success } = await client.waitForSession(sessionId, { ...waitOptions, onStatus });
    if (!success) throw new Error(`Session finished without success: ${status}`);
    return { sessionId, status };
  } finally {
    onStatus(`EndSession: ${await client.endSession(sessionId).catch((e: Error) => e.message)}`);
  }
}

// GetRelays reply: 19 characters, one per relay 0-18 ('0' off, '1' on, '2' unknown), or "Error: ...".
export const RELAY_COUNT = 19;
const RELAY_STATES: Record<string, string> = { 0: 'Off', 1: 'On', 2: 'Unknown' };

export function parseRelayStatus(reply: unknown): RelayStatus[] {
  const text = String(reply).trim();
  if (text.startsWith('Error:')) throw new Error(`GetRelays: ${text}`);
  if (text.length !== RELAY_COUNT) {
    throw new Error(`GetRelays: Error: String is ${text.length} bytes, should be ${RELAY_COUNT}.`);
  }
  return [...text].map((c, relay) => ({ relay, code: c, state: RELAY_STATES[c] || `Code ${c}` }));
}

// Instant relay status check (no session, nothing is changed on the gate).
export async function checkRelays(
  client: Pick<Client, 'getRelays'>, { user, password, phoneNumber, masterCode, comType = 'DKS Cellular' }: RelayCredentials,
): Promise<RelayStatus[]> {
  for (const [k, v] of Object.entries({ user, password, phoneNumber, masterCode })) {
    if (!v) throw new Error(`Missing ${k}`);
  }
  if (!CLOUD_COM_TYPES.includes(comType)) {
    throw new Error(`Relay check through DKS Cloud needs a DKS communication type, not "${comType}"`);
  }
  const userId = `${user}${comType === 'DKS Cellular' ? '/cellular' : '/client'}`;
  return parseRelayStatus(await client.getRelays(userId, password, phoneNumber, masterCode));
}

// Live relay control (SetRelays). `desired` maps a relay index (0-18) to a boolean (true = Active/Hold = gate held open).
// Reads the current state first and echoes every untouched relay unchanged, so only the named relays move.
// Returns { before, settings, reply, after }. A no-op (desired matching current) is a safe way to confirm the format.
export async function controlRelays(
  client: Pick<Client, 'getRelays' | 'setRelays'>, cred: RelayCredentials, desired: Record<number, boolean>,
): Promise<{ before: RelayStatus[]; settings: string; reply: string; after: RelayStatus[] }> {
  const { user, password, phoneNumber, masterCode, comType = 'DKS Cellular' } = cred;
  for (const [k, v] of Object.entries({ user, password, phoneNumber, masterCode })) {
    if (!v) throw new Error(`Missing ${k}`);
  }
  if (!CLOUD_COM_TYPES.includes(comType)) {
    throw new Error(`Relay control through DKS Cloud needs a DKS communication type, not "${comType}"`);
  }
  const userId = `${user}${comType === 'DKS Cellular' ? '/cellular' : '/client'}`;
  const before = parseRelayStatus(await client.getRelays(userId, password, phoneNumber, masterCode));
  // SetRelays wants a 20-char Settings string: a leading mode letter + 19 relay states (DoorKing32 FUN_004f3dd0).
  // The mode letter (FUN_004f1c20) depends on which relay banks change vs the current state: positions 3-10 and 11-18.
  //   both banks unchanged -> M ; only 3-10 changed -> R ; only 11-18 changed -> P ; both changed -> T.
  // States are the desired 19 chars; '2' (unknown) is sent as '0' (FUN_004f3c40 replaces '2' with '0').
  const cur = before.map((r) => r.code).join('');
  const des = before.map((r) => (r.relay in desired ? (desired[r.relay] ? '1' : '0') : (r.code === '2' ? '0' : r.code))).join('');
  const bank = (s: string, a: number) => s.slice(a, a + 8);
  const b1 = bank(cur, 3) === bank(des, 3); // relays 3-10 unchanged
  const b2 = bank(cur, 11) === bank(des, 11); // relays 11-18 unchanged
  const mode = b2 ? (b1 ? 'M' : 'R') : (b1 ? 'P' : 'T');
  const settings = mode + des;
  // DKS reaching the gate over cellular can time out; retry the same (idempotent) command a few times.
  const { attempts = 4, retryMs = 2500, onStatus = () => {} } = cred;
  let reply: string;
  for (let i = 1; ; i++) {
    reply = String(await client.setRelays(userId, password, phoneNumber, masterCode, settings)).trim();
    if (!/^error/i.test(reply)) break;
    onStatus(`SetRelays attempt ${i}: ${reply}`);
    if (i >= attempts) throw new Error(`SetRelays failed after ${i} tries: ${reply}`);
    await new Promise((r) => setTimeout(r, retryMs));
  }
  const after = parseRelayStatus(await client.getRelays(userId, password, phoneNumber, masterCode));
  return { before, settings, reply, after };
}
