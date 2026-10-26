// CSV writing (RFC 4180) with formula-injection protection: a cell that a spreadsheet would evaluate (leading = + - @
// tab or CR) is prefixed with a single quote. Merchant-controlled text (order ids, descriptions) ends up in exports.

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(v: string | number | bigint | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: readonly (string | number | bigint | boolean | null | undefined)[]): string => `${cells.map(csvCell).join(',')}\r\n`;
