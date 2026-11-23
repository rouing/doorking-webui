import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { decodeFileText, encodeFileText } from './board-files.ts';

/**
 * Client for the DKS Cloud SOAP service (DkWebService.asmx). The operations that change the gate are
 * SendResidentData and SetRelays; SetRelays1812, SetAmazonRelays1800, Send1812, ... are intentionally not exposed.
 */
export const NAMESPACE = 'http://offbyone.org/DkRemoteModemWebService';
/**
 * HTTPS, so the DKS password and master code are encrypted on the way (the service answers on http and https).
 */
export const DEFAULT_URL = 'https://dksdb.dksoftware.com/DkWebService.asmx';
export const DATA_FILES = ['rcv_out.bin', 'names.bin', 'phone.bin', 'cards.bin'];

type Param = string | number | null | undefined;
type ResidentFile = 'names.bin' | 'phone.bin' | 'cards.bin';

export interface SessionSeries30Params {
  userId: Param; password: Param; userTime: Param; dialDelay: Param; masterCode: Param; memorySize: Param;
  phoneNumber: Param; relay012Hold: Param; interface1816: Param; antiPassBack: Param; modelNumber: Param; areaCodes: Param;
}

const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: true, suppressEmptyNode: false });
const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false, removeNSPrefix: true, htmlEntities: true });

/**
 * Walks a parsed XML object for the first element with the given local tag name.
 *
 * @param node - `unknown` value.
 * @param tag - `string` value.
 * @returns `string | undefined` result.
 */
function findTag(node: unknown, tag: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  if (tag in obj) {
    const val = obj[tag];
    return typeof val === 'string' ? val : val == null ? '' : undefined;
  }
  for (const child of Object.values(obj)) {
    const found = findTag(child, tag);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Operations polled while a session runs; only their failures are logged. */
const POLLED = new Set(['GetSessionStatus']);

export interface DksCloudClientOptions {
  url?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface SendResidentDataOptions {
  files: Partial<Record<ResidentFile, Uint8Array>>;
  maps?: Partial<Record<ResidentFile, Uint8Array>>;
  oldSendStamp?: string;
}

export interface WaitSessionOptions {
  intervalMs?: number;
  maxMs?: number;
  onStatus?: (status: string) => void;
}

export class DksCloudClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;

  /**
   * log(message): each call's operation, time and outcome (never its parameters, which hold credentials).
   *
   * @param [options] - Options object.
   * @param [options.url] - Target URL.
   * @param [options.timeoutMs] - Timeout in milliseconds.
   * @param [options.log] - Callback receiving progress or diagnostic messages.
   */
  constructor({ url = DEFAULT_URL, timeoutMs = 60000, log = () => {} }: DksCloudClientOptions = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  /**
   * Call.
   *
   * @param operation - DKS Cloud SOAP operation name.
   * @param params - Route path parameters or call parameters.
   * @returns Promise resolving to `string`.
   * @throws Error when validation or the underlying operation fails.
   */
  async call(operation: string, params: Record<string, Param>): Promise<string> {
    const started = Date.now();
    try {
      const result = await this.request(operation, params);
      if (!POLLED.has(operation)) this.log(`${operation}: ok after ${Date.now() - started} ms (${result.length} characters)`);
      return result;
    } catch (err) {
      this.log(`${operation}: failed after ${Date.now() - started} ms: ${(err as Error).message}`);
      throw err;
    }
  }

  private async request(operation: string, params: Record<string, Param>): Promise<string> {
    const opBody: Record<string, unknown> = { '@_xmlns': NAMESPACE };
    for (const [k, v] of Object.entries(params)) opBody[k] = v ?? '';
    const envelope = '<?xml version="1.0" encoding="utf-8"?>' + xmlBuilder.build({
      'soap:Envelope': {
        '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@_xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
        '@_xmlns:soap': 'http://schemas.xmlsoap.org/soap/envelope/',
        'soap:Body': { [operation]: opBody },
      },
    });

    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${NAMESPACE}/${operation}"`,
      },
      body: envelope,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const xml = await res.text();
    let parsed: unknown = null;
    if (xml.trim().startsWith('<')) {
      // SOAP 1.1 forbids DOCTYPE declarations; rejecting them prevents custom entity expansion (XXE).
      if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error(`${operation}: unexpected DOCTYPE in SOAP response`);
      try { parsed = xmlParser.parse(xml); } catch { parsed = null; }
    }
    const fault = findTag(parsed, 'faultstring');
    if (fault !== undefined) throw new Error(`${operation} SOAP fault: ${fault}`);
    if (!res.ok) throw new Error(`${operation} HTTP ${res.status}`);
    const result = findTag(parsed, `${operation}Result`);
    if (result === undefined) throw new Error(`${operation}: no result in response`);
    return result;
  }

  /**
   * Check login.
   *
   * @param userId - `Param` value.
   * @param password - Plain-text password.
   * @returns Promise resolving to `string`.
   */
  checkLogin(userId: Param, password: Param): Promise<string> {
    return this.call('CheckLogin', { UserID: userId, password });
  }

  /**
   * Opens a cloud session for a Series 30 board (parameter names/order from the service's WSDL).
   *
   * @param params - Route path parameters or call parameters.
   * @returns Promise resolving to `string`.
   */
  startSessionSeries30(params: SessionSeries30Params): Promise<string> {
    return this.call('StartSessionSeries30', {
      UserID: params.userId,
      password: params.password,
      UserTime: params.userTime,
      DialDelay: params.dialDelay,
      MasterCode: params.masterCode,
      MemorySize: params.memorySize,
      PhoneNumber: params.phoneNumber,
      Relay012Hold: params.relay012Hold,
      Interface1816: params.interface1816,
      AntiPassBack: params.antiPassBack,
      ModelNumber: params.modelNumber,
      AreaCodes: params.areaCodes,
    });
  }

  /**
   * Get session status.
   *
   * @param sessionId - Active DKS Cloud session identifier.
   * @returns Promise resolving to `string`.
   */
  getSessionStatus(sessionId: Param): Promise<string> {
    return this.call('GetSessionStatus', { SessionID: sessionId });
  }

  /**
   * Asks the cloud to read transactions newer than the 12-byte marker (hex) from the board.
   *
   * @param sessionId - Active DKS Cloud session identifier.
   * @param transactionBytesHex - `Param` value.
   * @returns Promise resolving to `string`.
   */
  receiveTransactionData(sessionId: Param, transactionBytesHex: Param): Promise<string> {
    return this.call('ReceiveTransactionData', { SessionID: sessionId, TransactionBytes: transactionBytesHex });
  }

  /**
   * Asks the cloud to read names/phone/cards memory from the board.
   *
   * @param sessionId - Active DKS Cloud session identifier.
   * @returns Promise resolving to `string`.
   */
  receiveResidentData(sessionId: Param): Promise<string> {
    return this.call('ReceiveResidentData', { SessionID: sessionId });
  }

  /**
   * Uploads names/phone/cards .bin files and their .map files (Buffers) to be written to the board.
   *
   * @param sessionId - Active DKS Cloud session identifier.
   * @param options - Options object.
   * @param options.files - Map of board filenames to binary buffers.
   * @param [options.maps] - Maps.
   * @param [options.oldSendStamp] - Old send stamp.
   * @returns Promise resolving to `string`.
   */
  sendResidentData(sessionId: Param, { files, maps = {}, oldSendStamp = '' }: SendResidentDataOptions): Promise<string> {
    const hex = (bytes: Uint8Array | undefined) => (bytes ? encodeFileText(bytes) : '');
    return this.call('SendResidentData', {
      SessionID: sessionId,
      OldSendStamp: oldSendStamp,
      names_bin: hex(files['names.bin']),
      phone_bin: hex(files['phone.bin']),
      cards_bin: hex(files['cards.bin']),
      names_map: hex(maps['names.bin']),
      phone_map: hex(maps['phone.bin']),
      cards_map: hex(maps['cards.bin']),
    });
  }

  /**
   * Downloads a file produced by a session; returns the decoded bytes.
   *
   * @param sessionId - Active DKS Cloud session identifier.
   * @param fileType - Board filename to download (`rcv_out.bin`, `names.bin`, `phone.bin`, or `cards.bin`).
   * @returns Promise resolving to `Buffer`.
   * @throws Error when validation or the underlying operation fails.
   */
  async getDataFile(sessionId: Param, fileType: string): Promise<Buffer> {
    if (!DATA_FILES.includes(fileType)) throw new Error(`fileType must be one of ${DATA_FILES.join(', ')}`);
    const text = await this.call('GetDataFile', { SessionID: sessionId, fileType });
    try { return decodeFileText(text); } catch (err) { throw new Error(`GetDataFile ${fileType}: ${(err as Error).message}`); }
  }

  /**
   * Reads the current relay states straight from the gate (no session).
   *
   * @param userId - `Param` value.
   * @param password - Plain-text password.
   * @param phoneNumber - Gate system phone number (digits or formatted).
   * @param masterCode - 4-digit gate master code.
   * @returns Promise resolving to `string`.
   */
  getRelays(userId: Param, password: Param, phoneNumber: Param, masterCode: Param): Promise<string> {
    return this.call('GetRelays', { UserID: userId, Password: password, PhoneNumber: phoneNumber, MasterCode: masterCode });
  }

  /**
   * Sets relay states (no session). `settings` is 20 characters: a mode letter, then 19 relay states ('0' off, '1' hold/active).
   * This is a live write: an active relay holds the gate open. Not part of the blocked bin-send path.
   *
   * @param userId - `Param` value.
   * @param password - Plain-text password.
   * @param phoneNumber - Gate system phone number (digits or formatted).
   * @param masterCode - 4-digit gate master code.
   * @param settings - Settings map or configuration.
   * @returns Promise resolving to `string`.
   */
  setRelays(userId: Param, password: Param, phoneNumber: Param, masterCode: Param, settings: Param): Promise<string> {
    return this.call('SetRelays', { UserID: userId, Password: password, PhoneNumber: phoneNumber, MasterCode: masterCode, Settings: settings });
  }

  /**
   * End session.
   *
   * @param sessionId - Active DKS Cloud session identifier.
   * @returns Promise resolving to `string`.
   */
  endSession(sessionId: Param): Promise<string> {
    return this.call('EndSession', { SessionID: sessionId });
  }

  /**
   * Polls GetSessionStatus until it reports "Session Complete:" (as DoorKing32 does).
   *
   * @param sessionId - Active DKS Cloud session identifier.
   * @param [options] - Options object.
   * @param [options.intervalMs] - Interval ms.
   * @param [options.timeoutMs] - Timeout in milliseconds.
   * @param [options.onStatus] - Callback receiving progress lines.
   * @returns Promise resolving to `{ status: string; success: boolean }`.
   * @throws Error when validation or the underlying operation fails.
   */
  async waitForSession(
    sessionId: Param,
    { intervalMs = 5000, timeoutMs = 15 * 60000, onStatus }: { intervalMs?: number; timeoutMs?: number; onStatus?: (status: string) => void } = {},
  ): Promise<{ status: string; success: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getSessionStatus(sessionId);
      if (onStatus) onStatus(status);
      if (status.includes('Session Complete: ')) {
        return { status, success: status.includes('Success') };
      }
      if (Date.now() > deadline) throw new Error(`Session ${sessionId} timed out. Last status: ${status}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
