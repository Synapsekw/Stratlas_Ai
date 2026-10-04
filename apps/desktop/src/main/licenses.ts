import type { LicenseEntry } from '@aio/schema';

interface ReportPackage {
  name?: unknown;
  versions?: unknown;
  license?: unknown;
  homepage?: unknown;
  author?: unknown;
}

/**
 * Turn `pnpm licenses list --json --prod -r` (licence to packages) into the list shown in
 * Settings, About: one entry per third-party package, sorted by name. Workspace packages
 * (`@aio/*`) are ours and left out. Runs at build time (electron.vite.config.ts).
 */
export function licenseEntries(report: unknown): LicenseEntry[] {
  if (!report || typeof report !== 'object') return [];
  const out: LicenseEntry[] = [];
  for (const [license, pkgs] of Object.entries(report as Record<string, unknown>)) {
    if (!Array.isArray(pkgs)) continue;
    for (const raw of pkgs as ReportPackage[]) {
      if (typeof raw.name !== 'string' || raw.name.startsWith('@aio/')) continue;
      const versions = Array.isArray(raw.versions)
        ? raw.versions.filter((v): v is string => typeof v === 'string')
        : [];
      out.push({
        name: raw.name,
        version: versions.join(', '),
        license: typeof raw.license === 'string' ? raw.license : license,
        ...(typeof raw.homepage === 'string' ? { homepage: raw.homepage } : {}),
        ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
