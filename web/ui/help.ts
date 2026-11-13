// Texts of the "?" hover tips (HelpTip), in plain language for everyday users. Keys are gate setting keys where a
// setting has one (so the System Settings fields find theirs), else a short name.
export const HELP: Record<string, string> = {
  // Gate list
  systemPhone: "The gate's own phone number (the line the entry panel is connected to), digits only. It identifies the gate in DKS Cloud.",
  gateMasterCode: "The gate's 4-digit master code, set at the entry panel. It's checked when the gate is added (the app pulls from the gate with it), then kept secret on this computer.",
  dksLogin: 'The DKS Cloud user and password that manage this gate. The app uses them for every pull, send, relay change and scheduled transfer of this gate, for all its users. Kept encrypted on this computer and never shown again.',
  apiKeys: 'Keys for scripts and other systems (for example home automation) to use this gate without signing in. Each key works only on this gate, has its own role, and can be revoked at any time. Treat a key like a password.',
  gateRole: 'Admin: can change everything, including the gate\'s users and DKS login. Read only: can look at everything, pull from the gate and watch the cameras, but can\'t change anything.',

  // Working copy
  workingCopy: 'Your changes are kept on this computer (the working copy) until you click Send to gate. Reset to gate throws away every change you have not sent.',

  // Gate configuration
  siteName: 'A name for this gate, shown in the gate list. DKS Cloud also receives it with each connection.',
  memorySize: "The gate's memory size: how many residents it can hold (1000, 2000 or 3000). Must match the gate, or pulls fail.",
  areaCodes: 'How many area codes the gate can store: 255 (the usual setting) or 10. Must match the gate. Changing it rearranges the stored phone numbers.',
  modelNumber: 'The entry panel model. The 1834 is set separately from the 1833, 1835, 1837 and 1838. Must match the gate.',
  antiPassBack: 'Y if anti-pass back is turned on at the gate, otherwise N. If it is wrong, pulls fail with "Anti-Passback Mismatch".',
  interface1816: 'Y only if the gate is connected through a DoorKing 1816/1820 interface (ask your installer). DKS Cloud is told this each time it connects; it is not stored on the gate.',
  tracker: 'Tick only if DoorKing Tracker expansion boards are fitted (not available on the 1834). It adds relays 3–18 to the Relays page and other pages.',
  showOnPage: 'Hides floor and elevator columns and pages when your building has none. Nothing on the gate changes, and the stored values are kept.',
  dirDigits: 'How many digits each directory code has (1–4). Making it larger adds leading zeros; making it smaller DELETES ALL RESIDENTS from the working copy.',

  // Gate settings (System Settings)
  masterCode: "The gate's master code, used to connect. Shown hidden; it can't be changed here.",
  talkTime: 'The longest a call from the entry panel to a resident can last, as minutes:seconds (up to 4:14).',
  outsideLineDigit: 'A digit the gate dials before every phone number to reach an outside line (often 9). Leave blank if your phone line needs none.',
  dialType: 'How the gate dials out: Tone for almost every phone line, Rotary only on an old rotary line. Read from the gate; it can\'t be changed here.',
  multipleSystems: 'Yes when more than one entry system shares this resident list. Read from the gate; it can\'t be changed here.',
  systemMemory: 'How many residents the gate\'s memory holds, as the gate itself records it. "System memory" under Gate configuration must be the same.',
  memoryChips: 'The kind of memory chips the gate reports: Standard, MemPLUS, or Anti-pass back. Anti-pass back means "Anti-passback" under Gate configuration must be Y.',
  downloadStamp1: 'When data was last sent to the gate by another program (for example DoorKing\'s own software), as that program recorded it. This app keeps it as it is.',
  downloadStamp2: 'A second time written with the stamp above (a few seconds later). This app keeps it as it is.',

  // Relays
  liveRelays: 'These buttons switch the real relays right now, through DKS Cloud. Green = held open, red = released. A held-open gate stays open until you release it.',
  trackerExpansion: 'Tick the boards that are fitted. Tracker 2 adds relays 3–10 and is controlled by relay 2; Tracker 1 adds relays 11–18 and is controlled by relay 1. The controlling relay is then locked.',
  relayName: 'A name for this relay, such as "Front gate". Used on the buttons and other pages. Saved when you click away. Kept on this computer, not sent to the gate.',
  strikeTime: 'How many seconds the relay stays switched on each time it opens. 00 on a Tracker command relay means the times are set on the Tracker boards.',
  toneToOpen: 'During a call, the resident presses one of these digits on their phone. Momentary opens once (for the strike time); Hold keeps it open; Release ends a hold; Hold 1 Hr keeps it open for one hour. Each digit can be used only once.',
  entryCodeRange: 'Entry codes from this range (From–To, 4 digits each) open this relay. Leave blank if you don\'t use ranges.',
  postalSwitch: 'Tick the relays the postal (mail carrier) key switch on the entry panel opens.',
  rotaryDial9: 'Tick the relays that open when a resident with an old rotary (pulse) phone dials 9 during a call.',

  // Residents and vendors
  directoryCode: 'The number a visitor enters on the entry panel to call this person. Each entry needs its own.',
  entryCode: 'A private code this person types at the keypad to open the gate themselves. Two entries can\'t share one.',
  securityLevel: 'When this person\'s entry code and cards work: Enabled = always, Disabled = never, 2–30 = only at the times set for that level on the Security Levels page.',
  floor: 'The floor this resident lives on (1–64). Used for elevator control: their visitor can only go to this floor.',
  elevatorRef: 'Picks a row (1–8) on the Elevator Reference page: which elevators this resident\'s visitors may use, and for how long.',
  hidden: 'Leaves this person out of the directory list shown on the entry panel\'s screen.',
  cards: 'Card or remote numbers (00001–65407) that open the gate for this person. Two entries can\'t share one.',
  notes: 'Your own notes about this person. Kept on this computer for everyone who manages this gate here. Never sent to the gate.',

  // Gate settings pages
  holdOpen: 'Times when the gate stays open by itself, for example during business hours. Each row has a start and end time, days, and the relays it holds open. The Hol row is used on holidays.',
  holidays: 'Dates the gate treats as holidays (month and day only). On these dates the Hol row of Hold Open applies, and time zone 4 of each security level if Holidays for Security Levels is on.',
  holidaysForSecurity: 'Makes time zone 4 of every security level the holiday time zone: on holiday dates it applies instead of the level\'s other time zones.',
  security: 'A security level decides when a code or card works. Each of its 4 time zones is a time window (start, end, days) and lists the relays (and floors) it may open.',
  facility: 'The facility code is a number shared by a batch of cards (000–255). When the check is on, the gate accepts only cards whose facility code is in this list.',
  elevatorReference: 'Each row (ER1–ER8) is chosen by a resident\'s Elevator reference: which elevators that resident\'s visitors may use, and how many seconds their floor button stays active.',
  relayElevator: 'Which elevators each relay controls.',
  apb: 'Anti-pass back stops one card letting several people in: a card used on an "In" relay must be used on an "Out" relay before it works on "In" again. It only affects cards with security levels 2–27.',
  apbMode: 'Off turns anti-pass back off. Passive, Active and Trap are the gate\'s three ways of handling a card used out of turn; see the DoorKing manual for how each one behaves.',
  apbRelays: 'The relays that count as going in (Relays In) or going out (Relays Out). Up to 10 each.',
  apbCounter: 'The gate can count how many cards are inside the facility. "Record Facility Counter Every" saves that count to the transactions at the chosen interval; "Reset" sets it to a number.',
  apbResync: 'Re-sync clears the in/out state of cards so they work again on any relay: all cards, a list of up to 5 card numbers, or all cards on a schedule.',

  // System Settings
  deviceAssociation: 'Names for ranges of card numbers, for example "Residents 00001–00500". The name is shown as the Event Type of card visits on the Transactions page.',
  debugLogs: 'Records detailed technical information to help find a problem. Leave it off unless someone supporting the app asks you to turn it on.',
  deleteGateData: 'Removes everything this app has stored about this gate, for everyone on this computer. The gate itself is not changed.',

  // Cameras
  cameraSerial: 'The video recorder\'s serial number, as shown in the DMSS or SmartPSS app.',
  clockOffset: 'Seconds to add to the gate\'s time so it matches the recorder\'s clock. Change it if pictures show the wrong moment (for example -30 if they are 30 seconds late).',
  cameraMode: 'Save pictures (quick and small) or a 2-minute video of each visit (slow to fetch and large).',
  cameraFrames: 'How many pictures to take of the minute of each visit, evenly spaced.',
  cameraFramesAfter: 'Extra pictures from the minute after the visit, for example to see the car drive through.',
  cameraEvents: 'Fetch pictures only for visits that were let in or refused, or for every event.',
  cameraLookBack: 'Only visits this many hours old or newer get pictures. Recorders keep footage for a limited number of days.',
  cameraKeep: 'How long saved pictures and videos stay on this computer. Older ones are deleted automatically. Forever keeps everything.',
};
