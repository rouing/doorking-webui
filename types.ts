/**
 * @module types
 *
 * REST API contract types for DoorKing Web UI.
 * Re-exports OpenAPI-generated schema types (`api-schema.d.ts`, generated via `npm run gen:types`) alongside
 * session, account, resident portal, and webhook shapes. Zero imports from `api/`.
 */
import type { SsoProviderInfo } from './generated/models/index.ts';
export type * as OpenApiModels from './generated/models/index.ts';
export type {
  LoginAuditEntry,
  PasskeyInfo,
  PortalStatusReply,
  PushSubscriptionInfo,
  ResidentRequest,
  SsoIdentityInfo,
  SsoProviderInfo,
  SuspiciousReport,
} from './generated/models/index.ts';

export interface GateConfig {
  siteName: string;
  memorySize: string;
  areaCodes: string;
  modelNumber: string;
  antiPassBack: 'Y' | 'N';
  interface1816: 'Y' | 'N';
}

export interface DeviceRange { name: string; from: string; to: string }
export interface GateFeatures { floors: boolean; elevators: boolean }
export interface GateTracker { enabled: boolean; tracker1: boolean; tracker2: boolean; prevTime1?: string; prevTime2?: string }

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
  relayLabels?: Partial<Record<string, string>>;
  deviceAssociation?: DeviceRange[];
  gateConfig?: Partial<GateConfig>;
  features?: Partial<GateFeatures>;
  tracker?: Partial<GateTracker>;
  adminPhone?: string;
  requireStrongAdmin?: boolean;
  residentPortal?: Partial<ResidentPortalPrefs>;
}

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
  note?: string;
  email?: string;
  portalEnabled?: boolean;
  portalInvited?: boolean;
  portalUsername?: string;
}

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
  camera: boolean;
  raw: string;
  source?: 'gate' | 'portal';
  txKey?: string;
  reported?: boolean;
  snapshotFiles?: string[];
}

export interface DataReply {
  transactions: { updated: string; rows: TransactionRow[]; next?: number | null } | null;
  apbEnabled?: boolean;
}

export interface ConflictView { kind: 'resident' | 'card' | 'setting'; key: string; label: string; gate: string; mine: string }

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
  duplicates: { kind: 'directoryCode' | 'entryCode' | 'card'; value: string; holders: string[]; text: string }[];
  grantAccessDigit?: string;
}

export interface GateSettingRow {
  key: string; group: string; name: string; offset: number; size: number; value: string; gate: string;
  editable: boolean; secret: boolean; note: string | null; maxLength: number | null;
}

export interface SettingsReply {
  pulled: string;
  saved: string;
  cache: { conflicts: ConflictView[]; files: { name: string; changedBlocks?: number[] }[] };
  fields: GateSettingRow[];
}

export interface SendChange {
  key: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  fields: { field: string; from: string; to: string }[];
}

export interface SendPreview {
  changedBlocks: Record<string, number[]>;
  residentCounts: number[];
  changes?: SendChange[];
}

export type GateRole = 'admin' | 'editor' | 'readonly' | 'resident';
export interface GateInfo { phoneNumber: string; siteName: string; addedAt: string; role: GateRole }

export interface GateUser {
  username: string; email: string; pendingEmail: string; phone: string; invited: boolean; role: GateRole; grantedBy: string; grantedAt: string; lastSignIn: string | null;
  ssoProviders?: string[];
}

export type ApiKeyScope =
  | 'gate:read'
  | 'directory:read' | 'directory:write'
  | 'transactions:read' | 'insights:read' | 'history:read'
  | 'settings:read' | 'settings:write'
  | 'gate:pull' | 'gate:send'
  | 'relays:read' | 'relays:trigger'
  | 'schedules:read' | 'schedules:write'
  | 'cameras:read' | 'cameras:write';

export interface ApiKeyInfo {
  id: string; name: string; role: GateRole; scopes: ApiKeyScope[] | null; createdBy: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
}

export interface GateLogin { dksUser: string; dksPasswordSet: boolean }

export type SessionReply =
  | { loggedIn: false; setup?: boolean; emailEnabled: boolean; sso: SsoProviderInfo[] }
  | {
    loggedIn: true;
    user: string;
    email: string;
    pendingEmail: string;
    phone: string;
    dark: boolean;
    notifyAccess: boolean;
    notifyAlerts: boolean;
    emailEnabled: boolean;
    mustChangePassword: boolean;
    sso: SsoProviderInfo[];
    hasPassword: boolean;
    passwordAllowed: boolean;
    hasPasskey: boolean;
    stepUpMinutes: number;
    strongUntil: string | null;
    isResidentOnly?: boolean;
    hasPortalUnit?: boolean;
    gate: GateInfo | null;
    defaults: GateConfig;
    holidayList: { name: string; month: number; day: number }[];
  };

export interface Job {
  state: 'idle' | 'running' | 'done' | 'failed';
  what?: string;
  phoneNumber?: string;
  user?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
  error?: string;
  adding?: boolean;
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

export interface EntryChange {
  id: string; time: string; user: string; action: string; summary: string; change: string;
  fields: { field: string; from: string; to: string }[];
  revertedBy: { id: string; user: string; time: string } | null;
}

export type ScheduleAction = 'send' | 'residents' | 'transactions' | 'snapshots';

export interface ScheduleInput {
  days: number[];
  time: string;
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

export interface CameraChannel { channel: number; name: string; relays?: number[] }

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
  keepDays?: number;
  savedBy: string;
  savedAt: string;
}

export type CameraSettingsInput = Omit<CameraSettings, 'savedBy' | 'savedAt'> & { password?: string };

export interface SnapshotMinute {
  status: string;
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

export interface RelayTimer {
  phone: string;
  relay: number;
  releaseAt: string;
  setBy: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export interface PullArchiveEntry {
  id: number;
  pulledAt: string;
  actor: string;
  residentsCount: number;
  cardsCount: number;
}

export interface DormantEntry {
  directoryCode: string;
  name: string;
  type: string;
  entryCode: string;
  cards: string[];
  lastSeen: string | null;
  totalEvents: number;
}

export interface UnknownCardActivity {
  cardNumber: string;
  uses: number;
  admits: number;
  denies: number;
  lastSeen: string;
  lastMinute: string;
  hasSnapshot: boolean;
}

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

export interface WebhookInfo {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

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

export interface PortalActivityReply {
  rows: TransactionRow[];
  showSnapshots: boolean;
}

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
