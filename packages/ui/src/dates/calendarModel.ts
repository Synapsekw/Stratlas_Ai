const pad = (n: number) => String(n).padStart(2, '0');

export function monthGrid(month: string): (string | null)[][] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d += 1) cells.push(`${y}-${pad(m)}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export function surveyMonths(dates: readonly string[]): string[] {
  return [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
}

export function stepMonth(months: readonly string[], current: string, dir: -1 | 1): string {
  const at = months.indexOf(current);
  if (at < 0) return months.at(dir < 0 ? 0 : -1) ?? current;
  return months[Math.min(months.length - 1, Math.max(0, at + dir))] ?? current;
}
