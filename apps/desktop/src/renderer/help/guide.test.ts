/**
 * The bundled guide itself: every chapter parses, every link and help topic lands on a real
 * heading, every screenshot the text names is one the e2e shot list makes, and the product
 * name is never written out (it comes from @aio/brand).
 */
import { brand } from '@aio/brand';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDE_SHOTS } from '../../../e2e/guideShots';
import { linkTarget } from './GuideArticle';
import { buildChapters, chapterSlug, fillProduct, resolveImage } from './guide';
import type { Block, Inline } from './markdown';
import { buildIndex, search } from './search';
import { SETTINGS_HELP, type HelpTopic } from './store';

const dir = join(import.meta.dirname, '../../../../../docs/guide');
const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
const sources = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
const chapters = buildChapters(sources, 'Product');

const headings = (blocks: Block[]) =>
  new Set(blocks.flatMap((b) => (b.kind === 'heading' ? [b.id] : [])));

function links(blocks: Block[]): string[] {
  const out: string[] = [];
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.kind === 'link') out.push(n.href);
      if (n.kind === 'strong' || n.kind === 'em' || n.kind === 'link') walk(n.children);
    }
  };
  const block = (b: Block) => {
    if (b.kind === 'heading' || b.kind === 'paragraph') walk(b.children);
    if (b.kind === 'list')
      for (const it of b.items) {
        walk(it.children);
        if (it.sub) block(it.sub);
      }
    if (b.kind === 'quote') b.blocks.forEach(block);
    if (b.kind === 'table') for (const r of [b.head, ...b.rows]) for (const c of r) walk(c);
  };
  blocks.forEach(block);
  return out;
}

const resolves = (t: HelpTopic) => {
  const ch = chapters.find((c) => c.slug === t.chapter);
  return ch !== undefined && (!t.anchor || headings(ch.blocks).has(t.anchor));
};

describe('the user guide', () => {
  it('has the chapters in order, each with a title', () => {
    expect(chapters.length).toBeGreaterThanOrEqual(13);
    expect(chapters[0]?.slug).toBe('install');
    for (const c of chapters) expect(c.title).not.toBe(c.slug);
  });

  it('never writes the product name out', () => {
    for (const [file, text] of Object.entries(sources))
      expect(text.includes(brand.productName), file).toBe(false);
  });

  it('links only to headings that exist', () => {
    for (const c of chapters)
      for (const href of links(c.blocks)) {
        const target = linkTarget(href, c.slug);
        expect(target, `${c.slug}: ${href}`).not.toBeNull();
        if (target) expect(resolves(target), `${c.slug}: ${href}`).toBe(true);
      }
  });

  it('has a section for every Settings page and the compare help', () => {
    for (const [page, topic] of Object.entries(SETTINGS_HELP))
      expect(resolves(topic), `settings page ${page}`).toBe(true);
    expect(resolves({ chapter: 'compare-dates' })).toBe(true);
  });

  it('only shows screenshots the e2e shot list makes', () => {
    const made = Object.fromEntries(GUIDE_SHOTS.map((s) => [`${s.id}.png`, s.id]));
    for (const c of chapters)
      for (const b of c.blocks)
        if (b.kind === 'image')
          expect(resolveImage(b.src, made), `${c.slug}: ${b.src}`).not.toBeNull();
  });

  it('finds sections by words, title hits first', () => {
    const index = buildIndex(chapters);
    const hits = search(index, 'graphics quality');
    expect(hits[0]).toMatchObject({ chapter: 'settings', anchor: 'graphics-quality' });
    expect(search(index, 'workspace id')[0]?.chapter).toBe('ai-agent');
    expect(search(index, 'passphr').some((h) => h.chapter === 'packages')).toBe(true);
    expect(search(index, 'zzzz nothing')).toEqual([]);
  });
});

describe('helpers', () => {
  it('reads chapter slugs from file names', () => {
    expect(chapterSlug('docs/guide/04-compare-dates.md')).toBe('compare-dates');
    expect(chapterSlug('docs/guide/README.md')).toBeNull();
  });

  it('fills the product name', () => {
    expect(fillProduct('Start {product}.', 'X')).toBe('Start X.');
    expect(fillProduct('Run {executable}-1.0.0-win-x64-setup.exe', 'X Y', 'XY')).toBe(
      'Run XY-1.0.0-win-x64-setup.exe',
    );
    expect(fillProduct('{executable}.exe')).toBe(`${brand.executableName}.exe`);
  });

  it('resolves only bundled guide images', () => {
    const table = { 'a.png': 'assets/a-123.png' };
    expect(resolveImage('images/a.png', table)).toBe('assets/a-123.png');
    expect(resolveImage('https://example.com/a.png', table)).toBeNull();
    expect(resolveImage('../secret.png', table)).toBeNull();
    expect(resolveImage('images/b.png', table)).toBeNull();
  });

  it('maps links to guide places, never outside', () => {
    expect(linkTarget('12-settings.md#data-folder', 'x')).toEqual({
      chapter: 'settings',
      anchor: 'data-folder',
    });
    expect(linkTarget('#top', 'maps')).toEqual({ chapter: 'maps', anchor: 'top' });
    expect(linkTarget('https://example.com', 'maps')).toBeNull();
    expect(linkTarget('javascript:alert(1)', 'maps')).toBeNull();
  });
});
