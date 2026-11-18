/** A cell that a spreadsheet would run as a formula starts with one of these (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell (RFC 4180): a cell that could run as a formula is prefixed with
 * a quote so it reads as text, and one with a comma, a quote or a line break
 * is quoted.
 */
export function csvCell(value: string | null): string {
  if (value === null) return "";
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const csvLine = (cells: readonly (string | null)[]) =>
  `${cells.map(csvCell).join(",")}\r\n`;
