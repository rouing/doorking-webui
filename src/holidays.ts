// Fixed-date holidays for the WebUI holiday picker. The gate stores only month/day (no year and no name),
// so names are never persisted: the UI offers this list to fill a row's month/day, and shows a name by
// looking the stored month/day back up here. Floating holidays (Thanksgiving, Memorial Day, ...) are not
// listed because they have no constant date; those rows are entered by month/day directly.
export interface Holiday { name: string; month: number; day: number }

export const FIXED_HOLIDAYS: Holiday[] = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: 'Valentine’s Day', month: 2, day: 14 },
  { name: "St. Patrick's Day", month: 3, day: 17 },
  { name: 'Juneteenth', month: 6, day: 19 },
  { name: 'Independence Day', month: 7, day: 4 },
  { name: 'Halloween', month: 10, day: 31 },
  { name: 'Veterans Day', month: 11, day: 11 },
  { name: 'Christmas Eve', month: 12, day: 24 },
  { name: 'Christmas Day', month: 12, day: 25 },
  { name: "New Year's Eve", month: 12, day: 31 },
];

export const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const byDate = new Map(FIXED_HOLIDAYS.map((h) => [`${h.month}-${h.day}`, h.name]));

// Name for a stored month/day, or '' when it isn't a known fixed-date holiday (a custom date).
export function holidayName(month: number | string, day: number | string): string {
  return byDate.get(`${Number(month)}-${Number(day)}`) || '';
}

export function monthName(month: number | string): string {
  return MONTH_NAMES[Number(month)] || '';
}
