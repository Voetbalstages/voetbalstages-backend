/** One CSV cell. Quotes when needed and defuses spreadsheet formulas in user-entered text. */
export const csvCell = (value: unknown, delimiter = ',') => {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`
  return s.includes(delimiter) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const toCsv = (headers: string[], rows: Record<string, unknown>[], delimiter = ',') =>
  [headers.join(delimiter), ...rows.map(row => headers.map(h => csvCell(row[h], delimiter)).join(delimiter))].join('\n')
