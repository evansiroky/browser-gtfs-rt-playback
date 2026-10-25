export type Row = Record<string, string>;

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** RFC 4180 CSV with CRLF-free `\n` line endings; a missing column is written empty. */
export function toCsv(columns: readonly string[], rows: readonly Row[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c] ?? '')).join(','));
  return lines.join('\n') + '\n';
}
