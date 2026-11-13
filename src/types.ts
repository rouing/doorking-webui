// Shapes shared by the server and the web page (web/ui). Types only: nothing here exists at run time.
// Times are ISO strings once sent as JSON.

export interface GateConfig {
  siteName: string;
  memorySize: string;
  areaCodes: string;
  modelNumber: string;
  antiPassBack: 'Y' | 'N';
  interface1816: 'Y' | 'N';
}

export interface DeviceRange { name: string; from: string; to: string }

// Which optional data the page shows for this gate (missing = shown). Page only; nothing on the gate changes.
export interface GateFeatures { floors: boolean; elevators: boolean }

// Tracker expansion boards, as in DoorKing32: the System Info "Tracker" box, and on the Relays screen "Additional
// Relays For Tracker 1" (relays 11-18, commanded by relay 1) and "... Tracker 2" (relays 3-10, commanded by relay 2).
// Page only: DoorKing32 keeps them in ACCOUNT.DAT (0x312, 0x449, 0x44a), not on the gate; missing = off.
// prevTime1/prevTime2: the command relay's strike time before its box was ticked, put back when it is unticked.
export interface GateTracker { enabled: boolean; tracker1: boolean; tracker2: boolean; prevTime1?: string; prevTime2?: string }

export interface GatePrefs {
  relayLabels?: Partial<Record<string, string>>; // '0'-'18'
  deviceAssociation?: DeviceRange[];
  gateConfig?: Partial<GateConfig>;
  features?: Partial<GateFeatures>;
  tracker?: Partial<GateTracker>;
}

// A resident or vendor: names.bin + phone.bin + cards.bin joined on directory code ('' where a file has no value).
export interface ResidentRow {
  directoryCode: string;
  name: string;
  type: 'Resident' | 'Vendor';
  hidden: boolean;
  areaCode: string;
  areaCodeIndex: number | null;
  phone: string;
  entryCode: string;
  securityLevel: number | '';
  elevatorRef: number | '';
  floor: number | '';
  cards: string[];
  entryOffset: number | null;
  recordOffset: number | null;
  note?: string; // GET G/residents: the local note (never on the gate)
}

// A transaction from rcv_out.bin, newest first. minute: the snapshot folder (YYYYMMDD-HHMM).
export interface TransactionRow {
  ts: number;
  minute: string;
  date: string;
  time: string;
  eventType: string;
  number: string | null;
  lookup: 'directory' | 'entryCode' | 'card' | null;
  name: string;
  access: string;
  relay: string;
  apb: string;
  directoryCode: string;
  raw: string;
}

// GET G/data: views of the pulled files (null where the file isn't there).
export interface DataReply { transactions: { updated: string; rows: TransactionRow[] } | null; [view: string]: unknown }

// GET G/residents: the working copy's residents and vendors.
export interface ResidentsReply {
  rows: ResidentRow[];
  unassignedCards: string[];
  updated?: string;
  areaCodes: { index: number; code: string | null; uses: number }[];
  emptyCodes: string[];
  dirDigits: number;
  cache: { exists: boolean; edited: boolean; newerPull: boolean };
  pulled: string;
  saved: string;
  // Directory codes, entry codes and cards held by more than one entry; a send is refused while any exist.
  duplicates: { kind: 'directoryCode' | 'entryCode' | 'card'; value: string; holders: string[]; text: string }[];
}

// GET G/settings: gate settings in the working copy's names.bin (value) and the last pull (gate). Secret values are
// masked.
export interface GateSettingRow {
  key: string; group: string; name: string; offset: number; size: number; value: string; gate: string;
  editable: boolean; secret: boolean; note: string | null; maxLength: number | null; // maxLength: text settings only
}
export interface SettingsReply {
  pulled: string;
  saved: string;
  cache: { newerPull: boolean; files: { name: string; changedBlocks?: number[] }[] };
  fields: GateSettingRow[];
}

// GET G/send: what a send would change.
export interface SendPreview { changedBlocks: Record<string, number[]>; residentCounts: number[] }

// GET /api/gates (master codes are never sent). siteName is '' until the user has connected to the gate.
// admin: everything, including the gate's users and DKS login; readonly: view, pull and cameras.
export type GateRole = 'admin' | 'readonly';
export interface GateInfo { phoneNumber: string; siteName: string; addedAt: string; role: GateRole }
// Someone with access to a gate (G/users, History).
// email: confirmed; pendingEmail: waiting for its confirmation link; invited: hasn't accepted their invitation yet.
export interface GateUser {
  username: string; email: string; pendingEmail: string; phone: string; invited: boolean; role: GateRole; grantedBy: string; grantedAt: string; lastSignIn: string | null;
}
// G/api-keys: an API key of the gate (never the key itself, which is shown once when created).
export interface ApiKeyInfo {
  id: string; name: string; role: GateRole; createdBy: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
}
// /api/me/passkeys: one of the user's passkeys. site: the name it works on (the public name, or localhost); synced:
// backed up by a passkey provider (iCloud Keychain, Google Password Manager, …), so it is on the user's other devices too.
export interface PasskeyInfo { id: string; name: string; site: string; synced: boolean; createdAt: string; lastUsedAt: string | null }
// G/login: the gate's DKS login (the password and master code are never sent back).
export interface GateLogin { dksUser: string; dksPasswordSet: boolean }

// setup: no account exists yet, so the page offers to create the first one.
export type SessionReply =
  | { loggedIn: false; setup?: boolean; emailEnabled: boolean }
  | {
    loggedIn: true;
    user: string;
    email: string; // confirmed
    pendingEmail: string; // waiting for its confirmation link
    phone: string; // E.164 ('' none)
    dark: boolean;
    notifyAccess: boolean; // emails when added to, removed from or changed on a gate
    notifyAlerts: boolean; // gate alerts (as a gate admin)
    emailEnabled: boolean; // the server can send email
    mustChangePassword: boolean;
    gate: GateInfo | null;
    defaults: GateConfig;
    holidayList: { name: string; month: number; day: number }[];
  };

// GET G/job: the gate connection (pull or send) and its log lines.
export interface Job {
  state: 'idle' | 'running' | 'done' | 'failed';
  what?: string;
  phoneNumber?: string;
  user?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
  error?: string;
  adding?: boolean; // the connection that checks a gate being added
  busyElsewhere?: boolean;
}

export interface HistoryEvent {
  id: string;
  time: string;
  user: string;
  action: string;
  summary: string;
  result?: string;
  error?: string;
  details?: { key: string; label: string; change: string; fields: { field: string; from: string; to: string }[] }[];
  revertOf?: string;
  revertible: boolean;
  revertedBy: { id: string; user: string; time: string } | null;
}

export interface HistoryReply { events: HistoryEvent[]; users: GateUser[] }

export type ScheduleAction = 'send' | 'residents' | 'transactions' | 'snapshots';

export interface ScheduleInput {
  days: number[]; // 0-6 = Sun-Sat
  time: string; // HH:MM, 24-hour
  actions: ScheduleAction[];
  enabled: boolean;
}

export interface Schedule extends ScheduleInput {
  id: string;
  phoneNumber: string;
  user: string;
  createdAt: string;
  lastDue: string | null;
  lastRun: string | null;
  lastResult: string | null;
  lastError: string | null;
  nextRun: string | null;
  queued?: boolean;
}

export interface SchedulesReply { schedules: Schedule[] }

export interface CameraChannel { channel: number; name: string }

export interface CameraSettings {
  enabled: boolean;
  serial: string;
  username: string;
  channels: CameraChannel[];
  clockOffset: number;
  mode: 'snapshots' | 'video';
  frames: number;
  framesAfter: number;
  clipTries: number;
  events: 'access' | 'all';
  backfillHours: number;
  keepDays?: number; // days saved snapshots are kept (15, 30, 60, 90); 0 or missing = forever
  savedBy: string;
  savedAt: string;
}

// PUT G/cameras: a blank password keeps the saved one.
export type CameraSettingsInput = Omit<CameraSettings, 'savedBy' | 'savedAt'> & { password?: string };

export interface SnapshotMinute {
  status: string; // done, partial, failed, or removed (files deleted; error says why)
  files: string[];
  error: string | null;
  attempts: number;
  videoAttempts: number;
  at: string;
  shifts: Record<string, number>;
  short: Record<string, number>;
}

export interface SnapshotRun {
  state: 'running' | 'done' | 'stopped' | 'failed';
  startedAt: string;
  finishedAt?: string;
  log: string[];
  minute?: string;
  again?: boolean;
  stopping?: boolean;
  error?: string;
  progress?: {
    minutes: number; minutesDone: number; frames: number; framesDone: number; current: string | null;
    byMinute: Record<string, { frames: number; done: number }>;
  };
  result?: { minutes: number; done: number; partial: number; failed: number; stopped: boolean; error?: string } | null;
}

export interface SnapshotsReply { snapshots: Record<string, SnapshotMinute>; run: SnapshotRun | null }

export interface Relay { relay: number; code: string; state: string; name: string }

export interface DebugLogInfo { enabled: boolean; file: string; size: number }

export interface ApiError { error: string }
