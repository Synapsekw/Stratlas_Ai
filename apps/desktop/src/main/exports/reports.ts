import type { ReportFile } from '@aio/schema';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** `report:list`: the PDF reports delivered in `<root>/report/`, sorted by name. */
export async function listReports(root: string): Promise<ReportFile[]> {
  let names: string[];
  try {
    names = await readdir(join(root, 'report'));
  } catch {
    return [];
  }
  const out: ReportFile[] = [];
  for (const name of names.filter((n) => /\.pdf$/i.test(n)).sort((a, b) => a.localeCompare(b))) {
    const s = await stat(join(root, 'report', name)).catch(() => null);
    if (s?.isFile()) out.push({ path: `report/${name}`, name, sizeBytes: s.size });
  }
  return out;
}
