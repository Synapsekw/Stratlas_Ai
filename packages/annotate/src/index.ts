export type { Issue, Sighting, SeverityModel, ClassCatalogue } from '@aio/schema';
export { validateIssueAgainstModel } from '@aio/schema';

/** Next free issue code for a prefix: F01..F99, then F100. */
export function nextIssueCode(existing: readonly string[], prefix: string): string {
  if (!/^[A-Z]{1,3}$/.test(prefix)) {
    throw new Error(`Issue prefix must be 1 to 3 capital letters, got "${prefix}"`);
  }
  let max = 0;
  for (const code of existing) {
    if (!code.startsWith(prefix)) continue;
    const n = Number(code.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}
export { IssueRegister, IssueDetail, PhotoViewer, VideoAnnotator } from './components';
