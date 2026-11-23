/**
 * @module src/resident-pdf
 *
 * Fills DoorKing's official 1-page `docs/ResidentInstructions.pdf` form with a resident's details (admin phone,
 * touch-tone grant-access digit, 4-digit entry code, resident name, and directory code) for download and printing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fmtPhone } from './shared.ts';

export const RESIDENT_INSTRUCTIONS_TEMPLATE = path.join(import.meta.dirname, '..', 'docs', 'ResidentInstructions.pdf');

export interface ResidentPdfFields {
  /** Resident name (optional, stamped in top-right summary box). */
  residentName?: string;
  /** Resident directory code (optional, stamped in top-right summary box). */
  directoryCode?: string;
  /** Building manager / HOA contact phone number stamped on the `Phone #` line. */
  adminPhone?: string;
  /** Touch-Tone digit to grant access (usually `9`, stamped on `press _____`). */
  grantAccessDigit?: string;
  /** 4-digit keypad entry code stamped inside the four square Entry Code boxes. */
  entryCode?: string;
}

/**
 * Generates a filled copy of `docs/ResidentInstructions.pdf` with the supplied resident & gate details.
 *
 * Coordinates are calibrated against `docs/ResidentInstructions.pdf` (1834-066 Issued 3-19 Version L, 612 x 792 pt):
 * - Admin `Phone #` line: `x = 82.75..290.75` (center `186.75`), `y = 618.26`
 * - Touch-Tone `press _____` blank: `x = 214.96..239.96` (center `227.46`), baseline `y = 405.07`
 * - Four 19x19 pt `Entry Code` boxes: centers `x = 481.06, 503.56, 526.06, 548.56`, `y = 106.29..125.29`
 * - Top-right open whitespace (opposite `Phone #`, above `Guest Communication`): `x = 322..558`, `y = 604..640`
 *
 * @param fields - Resident and gate values to stamp onto the form.
 * @param [templatePath] - Path to the blank PDF template (defaults to `docs/ResidentInstructions.pdf`).
 * @returns Promise resolving to the filled PDF bytes.
 */
export async function fillResidentInstructionsPdf(
  fields: ResidentPdfFields,
  templatePath = RESIDENT_INSTRUCTIONS_TEMPLATE,
): Promise<Uint8Array> {
  const bytes = fs.readFileSync(templatePath);
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.06, 0.1, 0.22);

  // 1. Building manager / HOA phone number above the Phone # line (x = 82.75..290.75, y = 618.26)
  const rawAdminPhone = String(fields.adminPhone ?? '').trim();
  if (rawAdminPhone) {
    const digits = rawAdminPhone.replace(/\D/g, '');
    const display = digits.length === 10 || digits.length === 7 ? fmtPhone(digits) : rawAdminPhone.slice(0, 28);
    const size = 12;
    const width = bold.widthOfTextAtSize(display, size);
    page.drawText(display, { x: 186.75 - width / 2, y: 622, size, font: bold, color: ink });
  }

  // 2. Resident Name + Directory Code summary box in open right-hand whitespace opposite Phone #
  const name = String(fields.residentName ?? '').trim().slice(0, 30);
  const dirCode = String(fields.directoryCode ?? '').trim().slice(0, 8);
  if (name || dirCode) {
    const boxX = 324;
    const boxY = 605;
    const boxW = 234;
    const boxH = 34;
    page.drawRectangle({
      x: boxX, y: boxY, width: boxW, height: boxH,
      color: rgb(0.965, 0.975, 0.995),
      borderColor: rgb(0.75, 0.8, 0.88),
      borderWidth: 0.75,
    });
    if (name && dirCode) {
      page.drawText('Resident:', { x: boxX + 8, y: boxY + 21, size: 8.5, font, color: rgb(0.35, 0.38, 0.45) });
      page.drawText(name, { x: boxX + 52, y: boxY + 21, size: 9.5, font: bold, color: ink });
      page.drawText('Directory Code:', { x: boxX + 8, y: boxY + 7, size: 8.5, font, color: rgb(0.35, 0.38, 0.45) });
      page.drawText(dirCode, { x: boxX + 76, y: boxY + 7, size: 10, font: bold, color: ink });
    } else if (dirCode) {
      page.drawText('Directory Code:', { x: boxX + 8, y: boxY + 13, size: 9, font, color: rgb(0.35, 0.38, 0.45) });
      page.drawText(dirCode, { x: boxX + 80, y: boxY + 13, size: 11, font: bold, color: ink });
    } else {
      page.drawText('Resident:', { x: boxX + 8, y: boxY + 13, size: 9, font, color: rgb(0.35, 0.38, 0.45) });
      page.drawText(name, { x: boxX + 54, y: boxY + 13, size: 10.5, font: bold, color: ink });
    }
  }

  // 3. Touch-Tone Grant Access digit above _____ (x = 214.96..239.96, baseline y = 405.07)
  const grantDigit = String(fields.grantAccessDigit ?? '').trim().slice(0, 4);
  if (grantDigit) {
    const size = 10.5;
    const width = bold.widthOfTextAtSize(grantDigit, size);
    page.drawText(grantDigit, { x: 227.46 - width / 2, y: 406.5, size, font: bold, color: ink });
  }

  // 4. 4-Digit Entry Code centered in the 4 individual 19x19 pt boxes (centers x = 481.06 + i * 22.5, y = 106.29..125.29)
  const entryDigits = String(fields.entryCode ?? '').replace(/\D/g, '').slice(0, 4);
  if (entryDigits) {
    const padded = entryDigits.length === 4 ? entryDigits : entryDigits.padStart(4, '0');
    const size = 13;
    for (let i = 0; i < 4; i++) {
      const ch = padded[i];
      const cx = 481.06 + i * 22.5;
      const width = bold.widthOfTextAtSize(ch, size);
      page.drawText(ch, { x: cx - width / 2, y: 111.2, size, font: bold, color: ink });
    }
  }

  return doc.save();
}
