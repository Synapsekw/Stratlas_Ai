import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from './en';

/**
 * The naming glossary (`docs/design/glossary.md`) retires the words the October UI review found
 * confusing or app-invented. This keeps them out of the English catalogue. The glossary's
 * "Retired terms" table is the list; each term here holds the pattern that finds it.
 */
const GLOSSARY = fileURLToPath(new URL('../../../../docs/design/glossary.md', import.meta.url));

/**
 * The keys of telecom and Coverage text. Some words are retired there only, because they are right
 * elsewhere: a sun has a bearing, and a stockpile has an inventory.
 */
const TELECOM_KEYS =
  /^(telecom\.|rf\.|project\.(antennas|sectors|coverage)\.|project\.group\.(antennas|sectors|coverage)$|actions\.(antenna|rf)\.|actions\.header\.antennas|measureCat\.(tool|hint)\.(azimuth|tilt|clearance)$|keys\.antenna\.|settings\.toolSets\.telecom\.|wb\.tab\.rf$|wb\.sec\.coverage$|tree\.measure\.move\.telecom$)/;

const RETIRED: readonly { term: string; pattern: RegExp; keys?: RegExp }[] = [
  { term: 'agent', pattern: /\bagents?\b/i },
  // what is left once "point cloud" and "cloud AI" are taken out (see `scrub`)
  { term: 'cloud', pattern: /\bclouds?\b/i },
  { term: 'Every date', pattern: /\bevery date\b/i },
  { term: 'File them', pattern: /\bfile them\b/i },
  { term: 'bench', pattern: /\bbench(es)?\b/i },
  { term: 'island', pattern: /\bislands?\b/i },
  { term: 'EDL', pattern: /\bEDL\b/ },
  { term: 'Triangulated toe', pattern: /\btriangulated toe\b/i },
  // volumetrics, one word per idea (finalization plan, 18 Nov 2026)
  { term: 'Cut / fill', pattern: /\bcut ?\/ ?fill\b/i }, // "cut/fill" too
  { term: 'Cut + fill', pattern: /\bcut ?\+ ?fill\b/i },
  { term: 'Stockpile volume report', pattern: /\bstockpile volume report\b/i },
  { term: 'Site materials', pattern: /\bsite materials\b/i },
  { term: 'Materials and density', pattern: /\bmaterials and density\b/i },
  { term: 'Survey dates chart', pattern: /\bsurvey dates chart\b/i },
  { term: 'Open in section view', pattern: /\bopen in section view\b/i },
  { term: 'Volume and tonnes over time', pattern: /\bvolume and tonnes over time\b/i },
  // telecom, one word per idea (telecom finalization, 22 Nov 2026)
  { term: 'Antenna inventory', pattern: /\bantenna inventory\b/i },
  { term: 'inventory', pattern: /\binventory\b/i, keys: TELECOM_KEYS },
  { term: 'Antenna tilt', pattern: /\bantenna tilt\b/i },
  { term: 'Mechanical downtilt', pattern: /\bmechanical downtilt\b/i },
  { term: 'mechanical', pattern: /\bmechanical\b/i, keys: TELECOM_KEYS },
  { term: 'bearing', pattern: /\bbearings?\b/i, keys: TELECOM_KEYS },
  { term: 'Centre elevation', pattern: /\bcentre elevation\b/i },
  { term: 'To review', pattern: /\bto review\b/i, keys: TELECOM_KEYS },
  { term: 'not reviewed', pattern: /\bnot reviewed\b/i, keys: TELECOM_KEYS },
  { term: 'unreviewed', pattern: /\bunreviewed\b/i, keys: TELECOM_KEYS },
  { term: 'set by you', pattern: /\bset by you\b/i, keys: TELECOM_KEYS },
  { term: 'typed', pattern: /\btyped\b/i, keys: TELECOM_KEYS },
  { term: 'Open Coverage', pattern: /\bopen coverage\b/i },
  { term: 'coverage settings', pattern: /\bcoverage settings\b/i },
  { term: '& run', pattern: /&\s*run\b/i, keys: TELECOM_KEYS },
  { term: 'E-tilt', pattern: /\be-?tilt\b/i },
  { term: 'RF coverage', pattern: /\bRF coverage\b/i },
  { term: 'Coverage panel', pattern: /\bcoverage panel\b/i },
  { term: 'No size', pattern: /\bno size\b/i, keys: TELECOM_KEYS },
];

/** Whether a retired term counts for this key: a scoped term only in its own keys. */
const applies = (r: { keys?: RegExp }, key: string): boolean => !r.keys || r.keys.test(key);

/** The glossary's own uses of a retired word: they mean something else, so they are taken out. */
const KEEP: readonly RegExp[] = [
  /\bpoint[- ]clouds?\b/gi, // the word to use for a point set
  /\bcloud AI\b/gi, // AI at an online provider, always the two words together
  /\{[^}]*\}/g, // placeholders such as {clouds} are code, not copy
];

/**
 * Real exceptions, each with its reason. Keep this short: a new entry needs a glossary line under
 * "Allowed exceptions".
 */
const ALLOWED: readonly { phrase: string; why: string }[] = [
  {
    // the Settings page name (`settings.page.privacy`) and the strings that point to it
    phrase: 'Privacy and cloud',
    why: 'the page is about cloud AI and the network; about 30 hardcoded strings and the user guide name it, so it is renamed when they move into the catalogue',
  },
];

function scrub(text: string): string {
  let s = text;
  for (const a of ALLOWED) s = s.split(a.phrase).join(' ');
  for (const k of KEEP) s = s.replace(k, ' ');
  return s;
}

/** The first column of the glossary's "Retired terms" table, without its backticks. */
function glossaryTerms(): string[] {
  const md = readFileSync(GLOSSARY, 'utf8');
  const section = md.split(/^## Retired terms$/m)[1]?.split(/^## /m)[0] ?? '';
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] ?? '');
}

describe('glossary', () => {
  it('the test retires exactly the glossary terms', () => {
    expect(glossaryTerms().sort()).toEqual(RETIRED.map((r) => r.term).sort());
  });

  it('every allowed exception is named in the glossary', () => {
    const md = readFileSync(GLOSSARY, 'utf8');
    for (const a of ALLOWED) expect(md, a.phrase).toContain(`"${a.phrase}"`);
  });

  it('no UI string uses a retired term', () => {
    const hits: string[] = [];
    for (const [key, value] of Object.entries(en as Record<string, string>)) {
      const s = scrub(value);
      for (const r of RETIRED)
        if (applies(r, key) && r.pattern.test(s)) hits.push(`${key} (${r.term}): ${value}`);
    }
    expect(hits).toEqual([]);
  });

  it('catches a retired term, and lets the kept uses through', () => {
    const uses = (text: string) =>
      RETIRED.filter((r) => r.pattern.test(scrub(text))).map((r) => r.term);
    expect(uses('Show source cloud')).toEqual(['cloud']);
    expect(uses('Datasets in Every date')).toEqual(['Every date']);
    expect(uses('Offline agent')).toEqual(['agent']);
    expect(uses('Show source point cloud')).toEqual([]);
    expect(uses('Turn cloud AI on in Privacy and cloud')).toEqual([]);
    expect(uses('{clouds} point clouds')).toEqual([]);
    expect(uses('Cut / fill')).toEqual(['Cut / fill']);
    expect(uses('the cut/fill shading')).toEqual(['Cut / fill']);
    expect(uses('Cut + fill')).toEqual(['Cut + fill']);
    expect(uses('Cut & fill')).toEqual([]);
    expect(uses('Cut and fill together')).toEqual([]);
    expect(uses('Stockpile volume report')).toEqual(['Stockpile volume report']);
    expect(uses('Site materials')).toEqual(['Site materials']);
    expect(uses('Materials and density')).toEqual(['Materials and density']);
    expect(uses('Survey dates chart')).toEqual(['Survey dates chart']);
    expect(uses('Open in section view')).toEqual(['Open in section view']);
    expect(uses('Volume and tonnes over time')).toEqual(['Volume and tonnes over time']);
    expect(uses('Volume over time')).toEqual([]);
  });

  it('retires the old telecom words, the scoped ones in telecom and Coverage text only', () => {
    const uses = (key: string, text: string) =>
      RETIRED.filter((r) => applies(r, key) && r.pattern.test(scrub(text))).map((r) => r.term);
    expect(uses('telecom.x', 'Export antenna inventory (CSV)')).toEqual([
      'Antenna inventory',
      'inventory',
    ]);
    expect(uses('volumes.title', 'Stockpile inventory')).toEqual([]);
    expect(uses('rf.x', 'Accept it in the inventory')).toEqual(['inventory']);
    expect(uses('telecom.x', 'or use the Antenna tilt tool')).toEqual(['Antenna tilt']);
    expect(uses('rf.x', 'Mechanical downtilt')).toEqual(['Mechanical downtilt', 'mechanical']);
    expect(uses('rf.x', 'Group by bearing')).toEqual(['bearing']);
    expect(uses('stage.env.sun', 'Sun 30° up, bearing 120°')).toEqual([]);
    expect(uses('telecom.x', 'Centre elevation (m)')).toEqual(['Centre elevation']);
    expect(uses('telecom.x', 'To review')).toEqual(['To review']);
    expect(uses('change.status.open', 'To review')).toEqual([]);
    expect(uses('rf.x', 'draft antennas that are not reviewed yet')).toEqual(['not reviewed']);
    expect(uses('rf.x', 'the run is marked unreviewed')).toEqual(['unreviewed']);
    expect(uses('telecom.x', 'set by you')).toEqual(['set by you']);
    expect(uses('rf.basis.user', 'typed')).toEqual(['typed']);
    expect(uses('rf.x', 'Type one in Sector')).toEqual([]);
    expect(uses('project.x', 'Open Coverage')).toEqual(['Open Coverage']);
    expect(uses('project.x', 'Open in Coverage')).toEqual([]);
    expect(uses('rf.x', 'Auto-plan & run')).toEqual(['& run']);
    expect(uses('rf.x', 'Auto-plan and run')).toEqual([]);
    expect(uses('rf.x', 'Antennas, Downtilt, Centre altitude, Draft')).toEqual([]);
    expect(uses('rf.x', 'E-tilt not -20 to 40 degrees.')).toEqual(['E-tilt']);
    expect(uses('rf.x', 'e-tilt kept')).toEqual(['E-tilt']);
    expect(uses('rf.x', 'Electrical tilt kept')).toEqual([]);
    expect(uses('telecom.x', 'inventory, azimuths and RF coverage')).toEqual([
      'inventory',
      'RF coverage',
    ]);
    expect(uses('rf.x', 'Open the Coverage panel')).toEqual(['Coverage panel']);
    expect(uses('rf.x', 'Open Coverage in the panel')).toEqual(['Open Coverage']);
    expect(uses('rf.x', 'No size measured: panel and radio on B3')).toEqual(['No size']);
    expect(uses('rf.x', 'Size not measured: panel and radio on B3')).toEqual([]);
  });

  it('speaks the telecom names of the glossary', () => {
    const e = en as Record<string, string>;
    expect(e['telecom.antennas.title']).toBe('Antennas');
    expect(e['telecom.antennas.csv.tool']).toBe('Export antennas (CSV)');
    expect(e['telecom.antennas.filter.draft']).toBe('Draft');
    expect(e['project.antennas.col.tilt']).toBe('Downtilt °');
    expect(e['project.antennas.col.height']).toBe('Alt m');
    expect(e['telecom.antennas.card.altitude']).toBe('Centre altitude');
    expect(e['telecom.antennas.value.elevation']).toBe('Elevation angle');
    expect(e['rf.sector.downtilt']).toBe('Downtilt');
    expect(e['rf.sectors.group']).toBe('Group by azimuth');
    expect(e['project.coverage.open']).toBe('Open in Coverage');
    expect(e['rf.steps.ai.autoplan']).toBe('Auto-plan and run');
    expect(e['rf.sector.etilt']).toBe('Electrical tilt');
    expect(e['rf.csv.col.etilt']).toBe('Electrical tilt');
    expect(e['telecom.tools.name.azimuth']).toBe(e['measureCat.tool.azimuth']);
    expect(e['telecom.tools.name.tilt']).toBe(e['measureCat.tool.tilt']);
    expect(e['telecom.tools.name.clearance']).toBe(e['measureCat.tool.clearance']);
    // a typed value reads one way in both halves
    expect(e['telecom.antennas.basis.user']).toBe('Entered by you');
    expect(e['rf.basis.user']?.toLowerCase()).toBe('entered by you');
    expect(e['telecom.antennas.notSet']).toBe('Not set');
    expect(e['telecom.antennas.notMeasured']).toBe('Not measured');
  });
});
