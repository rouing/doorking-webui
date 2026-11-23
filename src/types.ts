/**
 * @module src/types
 *
 * Shapes shared by the server and the web page (web/ui). Types only: nothing here exists at run time.
 * Times are ISO strings once sent as JSON.
 */

export interface GateConfig {
  siteName: string;
  memorySize: string;
  areaCodes: string;
  modelNumber: string;
  antiPassBack: 'Y' | 'N';
  interface1816: 'Y' | 'N';
}

export interface DeviceRange { name: string; from: string; to: string }

/**
 * Which optional data the page shows for this gate (missing = shown). Page only; nothing on the gate changes.
 */
export interface GateFeatures { floors: boolean; elevators: boolean }

/**
 * Tracker expansion boards, as in DoorKing32: the System Info "Tracker" box, and on the Relays screen "Additional
 * Relays For Tracker 1" (relays 11-18, commanded by relay 1) and "... Tracker 2" (relays 3-10, commanded by relay 2).
 * Page only: DoorKing32 keeps them in ACCOUNT.DAT (0x312, 0x449, 0x44a), not on the gate; missing = off.
 * prevTime1/prevTime2: the command relay's strike time before its box was ticked, put back when it is unticked.
 */
export interface GateTracker { enabled: boolean; tracker1: boolean; tracker2: boolean; prevTime1?: string; prevTime2?: string }

/** Per-gate configuration for the Resident Self-Service Portal & "Buzz Me In" PWA. */
export interface ResidentPortalPrefs {
  enabled: boolean;
  buzzEnabled: boolean;
  buzzRelays: number[];
  pulseSeconds: number;
  maxRerollsPerDay: number;
  autoSendReroll: boolean;
  showSnapshots: boolean;
  allowRequests: boolean;
  requirePasskeyForBuzz: boolean;
}

export interface GatePrefs {
  relayLabels?: Partial<Record<string, string>>; // '0'-'18'
  deviceAssociation?: DeviceRange[];
  gateConfig?: Partial<GateConfig>;
  features?: Partial<GateFeatures>;
  tracker?: Partial<GateTracker>;
  /** Building manager / HOA phone number pre-filled on resident instructions PDF and welcome messages. */
  adminPhone?: string;
  /** When true, every admin action on this gate requires a recent passkey or MFA SSO confirmation. */
  requireStrongAdmin?: boolean;
  /** Opt-in Resident Self-Service Portal settings for this gate. */
  residentPortal?: Partial<ResidentPortalPrefs>;
}

/**
 * A resident or vendor: names.bin + phone.bin + cards.bin joined on directory code ('' where a file has no value).
 */
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
  /** Local resident email (stored in `resident_portal`, never on the gate). */
  email?: string;
  /** Whether Resident Portal access is enabled for this unit. */
  portalEnabled?: boolean;
  /** True when the resident's portal account is still waiting to accept its email invite. */
  portalInvited?: boolean;
  /** Linked portal username (when enabled). */
  portalUsername?: string;
}

/** A transaction from rcv_out.bin, newest first. minute: the snapshot folder (YYYYMMDD-HHMM). */
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
  camera: boolean; // camera footage can apply (never for gate data transfers, hold-open events or other gate commands)
  raw: string;
  /** Synthetic transaction source (`'portal'` for Buzz Me In opens; omitted/`'gate'` for hardware `tx_history`). */
  source?: 'gate' | 'portal';
  /** Stable key for deduplicating suspicious reports. */
  txKey?: string;
  /** True when this resident already reported this event as suspicious. */
  reported?: boolean;
  /** Saved snapshot/video filenames for this event's minute (populated for Resident Portal activity). */
  snapshotFiles?: string[];
}

/**
 * GET G/data: views of the pulled files (null where the file isn't there).
 * transactions.next: ask GET /data?before=<next> for the older page (null: none).
 */
export interface DataReply { transactions: { updated: string; rows: TransactionRow[]; next?: number | null } | null }

/**
 * An item changed differently at the gate and in the working copy since the last pull: decided with Keep mine or
 * Take the gate's (POST G/working-copy/conflicts). gate / mine: how the two values differ, in words.
 */
export interface ConflictView { kind: 'resident' | 'card' | 'setting'; key: string; label: string; gate: string; mine: string }

/** GET G/residents: the working copy's residents and vendors. */
export interface ResidentsReply {
  rows: ResidentRow[];
  unassignedCards: string[];
  updated?: string;
  areaCodes: { index: number; code: string | null; uses: number }[];
  emptyCodes: string[];
  dirDigits: number;
  cache: { exists: boolean; edited: boolean; conflicts: ConflictView[] };
  pulled: string;
  saved: string;
  /** Directory codes, entry codes and cards held by more than one entry; a send is refused while any exist. */
  duplicates: { kind: 'directoryCode' | 'entryCode' | 'card'; value: string; holders: string[]; text: string }[];
  /** Configured Relay 0 Touch-Tone momentary open digit (usually '9'). */
  grantAccessDigit?: string;
}

/**
 * GET G/settings: gate settings in the working copy's names.bin (value) and the last pull (gate). Secret values are
 * masked.
 */
export interface GateSettingRow {
  key: string; group: string; name: string; offset: number; size: number; value: string; gate: string;
  editable: boolean; secret: boolean; note: string | null; maxLength: number | null; // maxLength: text settings only
}
export interface SettingsReply {
  pulled: string;
  saved: string;
  cache: { conflicts: ConflictView[]; files: { name: string; changedBlocks?: number[] }[] };
  fields: GateSettingRow[];
}

/** One unsent change in the Send preview (resident, vendor, card, or gate setting). */
export interface SendChange {
  key: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  fields: { field: string; from: string; to: string }[];
}

/** GET G/send: what a send would change. */
export interface SendPreview {
  changedBlocks: Record<string, number[]>;
  residentCounts: number[];
  changes?: SendChange[];
}

/**
 * GET /api/gates (master codes are never sent). siteName is '' until the user has connected to the gate.
 * admin: everything including sends, relays, users and DKS login; editor: working-copy edits only; readonly: view, pull and cameras.
 */
export type GateRole = 'admin' | 'editor' | 'readonly' | 'resident';
export interface GateInfo { phoneNumber: string; siteName: string; addedAt: string; role: GateRole }
/**
 * Someone with access to a gate (G/users, History).
 * email: confirmed; pendingEmail: waiting for its confirmation link; invited: hasn't accepted their invitation yet.
 */
export interface GateUser {
  username: string; email: string; pendingEmail: string; phone: string; invited: boolean; role: GateRole; grantedBy: string; grantedAt: string; lastSignIn: string | null;
  ssoProviders?: string[];
}
/** G/api-keys: an API key of the gate (never the key itself, which is shown once when created). */
export interface ApiKeyInfo {
  id: string; name: string; role: GateRole; createdBy: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
}
/**
 * /api/me/passkeys: one of the user's passkeys. site: the name it works on (the public name, or localhost); synced:
 * backed up by a passkey provider (iCloud Keychain, Google Password Manager, …), so it is on the user's other devices too.
 */
export interface PasskeyInfo { id: string; name: string; site: string; synced: boolean; createdAt: string; lastUsedAt: string | null }
/** G/login: the gate's DKS login (the password and master code are never sent back). */
export interface GateLogin { dksUser: string; dksPasswordSet: boolean }

/**
 * setup: no account exists yet, so the page offers to create the first one.
 * A single sign-on provider ("Sign in with <name>") and a sign-in linked to the account.
 */
export interface SsoProviderInfo { id: string; name: string }
export interface SsoIdentityInfo { provider: string; providerName: string; subject: string; email: string; linkedAt: string; lastUsedAt: string | null }

export type SessionReply =
  | { loggedIn: false; setup?: boolean; emailEnabled: boolean; sso: SsoProviderInfo[] }
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
    sso: SsoProviderInfo[];
    hasPassword: boolean; // false: signs in with single sign-on (or a passkey) only
    passwordAllowed: boolean; // false: linked to a provider that turns password sign-in off
    hasPasskey: boolean;
    stepUpMinutes: number; // how long a passkey confirmation covers the sensitive actions
    strongUntil: string | null; // until when this session's passkey confirmation covers them (ISO), or null
    /** True when the user has only resident portal access (no staff role on any gate). */
    isResidentOnly?: boolean;
    /** True when the user also owns an enabled Resident Portal unit on the currently open gate. */
    hasPortalUnit?: boolean;
    gate: GateInfo | null;
    defaults: GateConfig;
    holidayList: { name: string; month: number; day: number }[];
  };

/** GET G/job: the gate connection (pull or send) and its log lines. */
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
  busyElsewhere?: boolean; // idle, but another gate with the same DKS login has a connection running
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

/** GET G/residents/:code/history: one History change of a directory code (see entryHistory in audit.ts). */
export interface EntryChange {
  id: string; time: string; user: string; action: string; summary: string; change: string;
  fields: { field: string; from: string; to: string }[];
  revertedBy: { id: string; user: string; time: string } | null;
}

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

/** PUT G/cameras: a blank password keeps the saved one. */
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

/** Active auto-release timer for a held-open relay (Safe Hold-Open). */
export interface RelayTimer {
  phone: string;
  relay: number;
  releaseAt: string;
  setBy: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

/** One archived residents pull available for diffing and rollback. */
export interface PullArchiveEntry {
  id: number;
  pulledAt: string;
  actor: string;
  residentsCount: number;
  cardsCount: number;
}

/** Dormant resident/vendor credential from the access audit dashboard. */
export interface DormantEntry {
  directoryCode: string;
  name: string;
  type: string;
  entryCode: string;
  cards: string[];
  lastSeen: string | null;
  totalEvents: number;
}

/** Unassigned card observed in `tx_history`. */
export interface UnknownCardActivity {
  cardNumber: string;
  uses: number;
  admits: number;
  denies: number;
  lastSeen: string;
  lastMinute: string;
  hasSnapshot: boolean;
}

/** Entry code usage stats (high-frequency / off-hours detection). */
export interface EntryCodeUsage {
  entryCode: string;
  directoryCode: string;
  name: string;
  type: string;
  uses: number;
  distinctDays: number;
  offHoursUses: number;
  lastSeen: string;
  flagged: boolean;
}

/** Response from `GET /api/gates/:phone/audit`. */
export interface AccessAuditReply {
  days: number;
  dormant: DormantEntry[];
  unknownCards: UnknownCardActivity[];
  entryCodes: EntryCodeUsage[];
  traffic: {
    totalEvents: number;
    admits: number;
    denies: number;
    holds: number;
    openCycles: number;
    byHour: number[];
    byDay: { date: string; admits: number; denies: number }[];
  };
}

export type WebhookEvent =
  | 'pull.completed'
  | 'send.completed'
  | 'send.failed'
  | 'relay.changed'
  | 'suspicious.reported';

/** Configured outbound webhook (signing secret never returned after creation). */
export interface WebhookInfo {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

/** One subscribed Web Push device for a user. */
export interface PushSubscriptionInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** One synthetic "Portal Open" transaction recorded when a resident uses Buzz Me In. */
export interface PortalEvent {
  id: number;
  phone: string;
  directoryCode: string;
  username: string;
  relay: number;
  eventType: string;
  access: string;
  ts: string;
  result: string;
  error: string | null;
}

/** One resident self-service change request. */
export interface ResidentRequest {
  id: number;
  phone: string;
  directoryCode: string;
  residentName?: string;
  username: string;
  kind: 'phone' | 'hidden' | 'cardIssue' | 'other';
  payload: Record<string, unknown>;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

/** One suspicious-activity report filed by a resident on their own transaction. */
export interface SuspiciousReport {
  id: number;
  phone: string;
  directoryCode: string;
  residentName?: string;
  username: string;
  txSource: 'gate' | 'portal';
  txKey: string;
  txTs: string;
  txSummary: string;
  note: string;
  status: 'open' | 'resolved';
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

/** One login audit event shown to gate admins. */
export interface LoginAuditEntry {
  id: number;
  username: string | null;
  identifier: string;
  role: string | null;
  method: string;
  outcome: string;
  reason: string | null;
  ip: string;
  userAgent: string;
  createdAt: string;
}

/** GET /api/portal/gates/:phone/me response. */
export interface PortalMeReply {
  gate: { phoneNumber: string; siteName: string; adminPhone: string; grantAccessDigit: string };
  units: { directoryCode: string; name: string }[];
  unit: {
    directoryCode: string;
    name: string;
    phone: string;
    entryCode: string;
    hidden: boolean;
    cards: { number: string; device: string }[];
    email: string;
  };
  portal: ResidentPortalPrefs & { buzzRelayLabels: { relay: number; name: string }[] };
  reroll: { usedToday: number; maxPerDay: number; remainingToday: number; pendingSend: boolean; nextScheduledSend: string | null };
}

/** GET /api/portal/gates/:phone/status response. */
export interface PortalStatusReply {
  available: boolean;
  busyReason?: string;
  percent: number | null;
  phase?: string;
  cooldownSeconds: number;
}

/** GET /api/portal/gates/:phone/activity response. */
export interface PortalActivityReply {
  rows: TransactionRow[];
  showSnapshots: boolean;
}

/** One outbound webhook delivery log entry. */
export interface WebhookDelivery {
  id: number;
  webhookId: string;
  event: string;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}


export interface ApiError { error: string }
