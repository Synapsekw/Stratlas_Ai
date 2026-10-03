export type PackageKind = 'native' | 'aik' | 'volumetric' | 'road' | 'twin';

/**
 * Recognise a project folder from its file names (relative paths).
 * native: our manifest; aik: Asset Inspection Kit offline build (HCl, EBSM, DAMAC);
 * volumetric: Volumetric Survey Kit (Masafi); road: road review (1st Ring Road);
 * twin: plant twin artifact export (Al-Zour).
 */
export function detectPackageKind(files: readonly string[]): PackageKind | null {
  const set = new Set(files.map((f) => f.replace(/\\/g, '/').toLowerCase()));
  const has = (p: string) => set.has(p);
  const any = (re: RegExp) => [...set].some((f) => re.test(f));
  if (has('manifest.json') && has('project.sqlite')) return 'native';
  if (has('data/config.js') && any(/^data\/piles\//)) return 'volumetric';
  if (any(/^ortho\/(p\/|index\.json)/) && any(/^data\/defects\./)) return 'road';
  if (has('layers.json') && has('flights.json')) return 'twin';
  if (any(/3d report\.html$/) || any(/review\.html$/) || any(/^data\/.*\.js$/)) return 'aik';
  return null;
}
