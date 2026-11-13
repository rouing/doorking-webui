import { decodeFileText, encodeFileText } from './board-files.ts';

// Client for the DKS Cloud SOAP service (DkWebService.asmx). The operations that change the gate are
// SendResidentData and SetRelays; SetRelays1812, SetAmazonRelays1800, Send1812, ... are intentionally not exposed.
export const NAMESPACE = 'http://offbyone.org/DkRemoteModemWebService';
// HTTPS, so the DKS password and master code are encrypted on the way (the service answers on http and https).
export const DEFAULT_URL = 'https://dksdb.dksoftware.com/DkWebService.asmx';
export const DATA_FILES = ['rcv_out.bin', 'names.bin', 'phone.bin', 'cards.bin'];

type Param = string | number | null | undefined;
type ResidentFile = 'names.bin' | 'phone.bin' | 'cards.bin';

export interface SessionSeries30Params {
  userId: Param; password: Param; userTime: Param; dialDelay: Param; masterCode: Param; memorySize: Param;
  phoneNumber: Param; relay012Hold: Param; interface1816: Param; antiPassBack: Param; modelNumber: Param; areaCodes: Param;
}

const escapeXml = (s: unknown): string => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const unescapeXml = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

// Operations polled while a session runs; only their failures are logged.
const POLLED = new Set(['GetSessionStatus']);

export class DksCloudClient {
  url: string;
  timeoutMs: number;
  log: (message: string) => void;

  // log(message): each call's operation, time and outcome (never its parameters, which hold credentials).
  constructor({ url = DEFAULT_URL, timeoutMs = 60000, log = () => {} }:
    { url?: string; timeoutMs?: number; log?: (message: string) => void } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  async call(operation: string, params: Record<string, Param>): Promise<string> {
    const started = Date.now();
    try {
      const result = await this.request(operation, params);
      if (!POLLED.has(operation)) this.log(`${operation}: ok after ${Date.now() - started} ms (${result.length} characters)`);
      return result;
    } catch (e) {
      this.log(`${operation}: failed after ${Date.now() - started} ms: ${(e as Error).message}`);
      throw e;
    }
  }

  private async request(operation: string, params: Record<string, Param>): Promise<string> {
    const body = Object.entries(params)
      .map(([k, v]) => `<${k}>${escapeXml(v ?? '')}</${k}>`).join('');
    const envelope = '<?xml version="1.0" encoding="utf-8"?>'
      + '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
      + 'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
      + 'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
      + `<soap:Body><${operation} xmlns="${NAMESPACE}">${body}</${operation}></soap:Body></soap:Envelope>`;

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
    const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(xml);
    if (fault) throw new Error(`${operation} SOAP fault: ${unescapeXml(fault[1])}`);
    if (!res.ok) throw new Error(`${operation} HTTP ${res.status}`);
    const m = new RegExp(`<${operation}Result>([\\s\\S]*?)</${operation}Result>`).exec(xml);
    if (!m) {
      if (new RegExp(`<${operation}Result\\s*/>`).test(xml)) return '';
      throw new Error(`${operation}: no result in response`);
    }
    return unescapeXml(m[1]);
  }

  checkLogin(userId: Param, password: Param): Promise<string> {
    return this.call('CheckLogin', { UserID: userId, password });
  }

  // Opens a cloud session for a Series 30 board (parameter names/order from the service's WSDL).
  startSessionSeries30(p: SessionSeries30Params): Promise<string> {
    return this.call('StartSessionSeries30', {
      UserID: p.userId,
      password: p.password,
      UserTime: p.userTime,
      DialDelay: p.dialDelay,
      MasterCode: p.masterCode,
      MemorySize: p.memorySize,
      PhoneNumber: p.phoneNumber,
      Relay012Hold: p.relay012Hold,
      Interface1816: p.interface1816,
      AntiPassBack: p.antiPassBack,
      ModelNumber: p.modelNumber,
      AreaCodes: p.areaCodes,
    });
  }

  getSessionStatus(sessionId: Param): Promise<string> {
    return this.call('GetSessionStatus', { SessionID: sessionId });
  }

  // Asks the cloud to read transactions newer than the 12-byte marker (hex) from the board.
  receiveTransactionData(sessionId: Param, transactionBytesHex: Param): Promise<string> {
    return this.call('ReceiveTransactionData', { SessionID: sessionId, TransactionBytes: transactionBytesHex });
  }

  // Asks the cloud to read names/phone/cards memory from the board.
  receiveResidentData(sessionId: Param): Promise<string> {
    return this.call('ReceiveResidentData', { SessionID: sessionId });
  }

  // Uploads names/phone/cards .bin files and their .map files (Buffers) to be written to the board.
  sendResidentData(
    sessionId: Param,
    { files, maps = {}, oldSendStamp = '' }: {
      files: Partial<Record<ResidentFile, Uint8Array>>; maps?: Partial<Record<ResidentFile, Uint8Array>>; oldSendStamp?: string;
    },
  ): Promise<string> {
    const hex = (b: Uint8Array | undefined) => (b ? encodeFileText(b) : '');
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

  // Downloads a file produced by a session; returns the decoded bytes.
  async getDataFile(sessionId: Param, fileType: string): Promise<Buffer> {
    if (!DATA_FILES.includes(fileType)) throw new Error(`fileType must be one of ${DATA_FILES.join(', ')}`);
    const text = await this.call('GetDataFile', { SessionID: sessionId, fileType });
    if (/error/i.test(text) && !/^[0-9a-f]*$/i.test(text.trim())) throw new Error(`GetDataFile: ${text}`);
    return decodeFileText(text);
  }

  // Reads the current relay states straight from the gate (no session).
  getRelays(userId: Param, password: Param, phoneNumber: Param, masterCode: Param): Promise<string> {
    return this.call('GetRelays', { UserID: userId, Password: password, PhoneNumber: phoneNumber, MasterCode: masterCode });
  }

  // Sets relay states (no session). `settings` is a 19-char desired-state string ('0' off, '1' hold/active).
  // This is a live write: an active relay holds the gate open. Not part of the blocked bin-send path.
  setRelays(userId: Param, password: Param, phoneNumber: Param, masterCode: Param, settings: Param): Promise<string> {
    return this.call('SetRelays', { UserID: userId, Password: password, PhoneNumber: phoneNumber, MasterCode: masterCode, Settings: settings });
  }

  endSession(sessionId: Param): Promise<string> {
    return this.call('EndSession', { SessionID: sessionId });
  }

  cancelSession(sessionId: Param): Promise<string> {
    return this.call('CancelSession', { SessionID: sessionId });
  }

  // Polls GetSessionStatus until it reports "Session Complete:" (as DoorKing32 does).
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
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
