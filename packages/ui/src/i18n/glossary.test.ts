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

const RETIRED: readonly { term: string; pattern: RegExp }[] = [
  { term: 'agent', pattern: /\bagents?\b/i },
  // what is left once "point cloud" and "cloud AI" are taken out (see `scrub`)
  { term: 'cloud', pattern: /\bclouds?\b/i },
  { term: 'Every date', pattern: /\bevery date\b/i },
  { term: 'File them', pattern: /\bfile them\b/i },
  { term: 'bench', pattern: /\bbench(es)?\b/i },
  { term: 'island', pattern: /\bislands?\b/i },
  { term: 'EDL', pattern: /\bEDL\b/ },
  { term: 'Triangulated toe', pattern: /\btriangulated toe\b/i },
];

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
      for (const r of RETIRED) if (r.pattern.test(s)) hits.push(`${key} (${r.term}): ${value}`);
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
  });
});
