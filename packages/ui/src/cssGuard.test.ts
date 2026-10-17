import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Keeps raw values out of the stylesheets: font sizes, colours, shadows and layers come from
 * tokens.css. The allow list snapshots what exists today and can only shrink. After fixing
 * offenders, run once with CSS_GUARD_WRITE=1 to lower it.
 */

const REPO = join(import.meta.dirname, '../../..');
const ROOTS = [join(REPO, 'packages/ui/src'), join(REPO, 'apps/desktop/src/renderer')];
const ALLOW_PATH = join(import.meta.dirname, 'cssGuard.allow.json');

const METRICS = ['fontPx', 'colour', 'shadow', 'zIndex', 'title'] as const;
type Metric = (typeof METRICS)[number];
type Counts = Partial<Record<Metric, number>>;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'reportPage') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

/** Skips a balanced `{ ... }` starting at `i` (strings and template literals included); returns the index after it. */
function skipBraces(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

/**
 * Counts `title=` written as an attribute of an intrinsic (lowercase) JSX element: the native
 * tooltip the app bans. Component props (`<Section title=`), object keys (`title:`) and comments
 * do not count.
 */
export function countDomTitleAttrs(source: string): number {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');
  let total = 0;
  for (const open of src.matchAll(/<[a-z][\w.:-]*/g)) {
    let i = open.index + open[0].length;
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i] ?? '')) i++;
      const c = src[i];
      if (c === undefined || c === '>' || c === '/') break;
      if (c === '{') {
        i = skipBraces(src, i);
        continue;
      }
      const name = /^[\w:-]+/.exec(src.slice(i, i + 64))?.[0];
      if (!name) break;
      i += name.length;
      while (/\s/.test(src[i] ?? '')) i++;
      if (src[i] !== '=') continue;
      if (name === 'title') total++;
      i++;
      while (/\s/.test(src[i] ?? '')) i++;
      const v = src[i];
      if (v === '{') i = skipBraces(src, i);
      else if (v === '"' || v === "'") i = src.indexOf(v, i + 1) + 1 || src.length;
    }
  }
  return total;
}

function cssCounts(raw: string, isTokens: boolean): Counts {
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;}]+)/g)].filter(
    (m) => !/^\s*(none\b|var\(--el-)/.test(m[1] ?? ''),
  );
  return {
    fontPx: count(css, /font-size\s*:\s*[\d.]+px/g),
    colour: isTokens ? 0 : count(css, /(?<![\w-])#[0-9a-fA-F]{3,8}\b|\brgba?\(|\boklch\(/g),
    shadow: shadows.length,
    zIndex: count(css, /z-index\s*:\s*-?\d+/g),
  };
}

function scan(): Record<string, Counts> {
  const found: Record<string, Counts> = {};
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const key = relative(REPO, file).split(sep).join('/');
      let counts: Counts | null = null;
      if (file.endsWith('.css')) {
        counts = cssCounts(readFileSync(file, 'utf8'), file.endsWith(`${sep}tokens.css`));
      } else if (file.endsWith('.tsx') && !file.endsWith('.test.tsx')) {
        counts = { title: countDomTitleAttrs(readFileSync(file, 'utf8')) };
      }
      if (!counts) continue;
      const nonZero = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)) as Counts;
      if (Object.keys(nonZero).length) found[key] = nonZero;
    }
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

describe('css guard', () => {
  const actual = scan();

  if (process.env.CSS_GUARD_WRITE === '1') {
    writeFileSync(ALLOW_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  }

  it('finds no raw values beyond the allow list, and the allow list only shrinks', () => {
    const allow = JSON.parse(readFileSync(ALLOW_PATH, 'utf8')) as Record<string, Counts>;
    const more: string[] = [];
    const fewer: string[] = [];
    for (const file of new Set([...Object.keys(actual), ...Object.keys(allow)])) {
      for (const m of METRICS) {
        const have = actual[file]?.[m] ?? 0;
        const allowed = allow[file]?.[m] ?? 0;
        if (have > allowed) more.push(`${file}: ${m} ${String(have)} > ${String(allowed)}`);
        if (have < allowed) fewer.push(`${file}: ${m} ${String(have)} < ${String(allowed)}`);
      }
    }
    expect(more, 'new raw values: use a token from tokens.css').toEqual([]);
    expect(fewer, 'lower the allow list (CSS_GUARD_WRITE=1)').toEqual([]);
  });

  it('uses amber as text only through --warn-ink, never --s3 or --warn', () => {
    // Stylesheets, and the CSS-in-JS strings and style objects of every package; a fallback
    // (`var(--s3, #f0a030)`) is still amber text.
    const PACKAGES = join(REPO, 'packages');
    const roots = [
      join(REPO, 'apps/desktop/src/renderer'),
      ...readdirSync(PACKAGES).map((p) => join(PACKAGES, p, 'src')),
    ].filter((p) => existsSync(p));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!/\.(css|tsx?)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
        if (file.endsWith(`${sep}tokens.css`)) continue;
        const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const n = count(css, /(?<![\w-])color\s*:\s*['"`]?var\(--(?:s3|warn)[,)]/g);
        if (n) offenders.push(`${relative(REPO, file)}: ${String(n)}`);
      }
    }
    expect(offenders, 'amber text: use var(--warn-ink)').toEqual([]);
  });

  it('keeps the part styles off class names the app already uses with another meaning', () => {
    // .row, .empty and .pop-title predate the parts: a bare rule restyles every old use.
    const BARE = [
      { re: /\.row(?![\w-]|\[data-kind)/g, fix: '.row[data-kind]' },
      { re: /\.empty(?![\w-])/g, fix: '.empty-state' },
      { re: /(?<!\.pop-head > )\.pop-title(?![\w-])/g, fix: '.pop-head > .pop-title' },
    ];
    const offenders: string[] = [];
    const dir = join(import.meta.dirname, 'parts');
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.css')) continue;
      const css = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const { re, fix } of BARE) {
        const n = count(css, re);
        if (n) offenders.push(`parts/${name}: ${String(n)} bare, scope as ${fix}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the global :focus-visible from changing border radius', () => {
    const css = readFileSync(join(import.meta.dirname, 'mission.css'), 'utf8');
    const start = css.search(/^:focus-visible \{/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toContain('outline');
    expect(block).not.toContain('border-radius');
  });
});

describe('countDomTitleAttrs', () => {
  it('counts title= on a lowercase element', () => {
    expect(countDomTitleAttrs('<button title="Save">x</button>')).toBe(1);
  });
  it('does not count component props', () => {
    expect(countDomTitleAttrs('<Section title="A"><EmptyState title={t} /></Section>')).toBe(0);
  });
  it('counts a title= spread over lines, after braced values', () => {
    const src = [
      '<div',
      '  className="a"',
      '  style={{ top: 1 }}',
      '  onClick={() => f({ a: 1 })}',
      '  title={`x ${y}`}',
      '>',
    ].join('\n');
    expect(countDomTitleAttrs(src)).toBe(1);
  });
  it('does not count an object key, a comment or another attribute', () => {
    const src = [
      "const o = { title: 'x' };",
      '// <b title="c">',
      '<i data-title="z" aria-label="t" />',
    ].join('\n');
    expect(countDomTitleAttrs(src)).toBe(0);
  });
});
