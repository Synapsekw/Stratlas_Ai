// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Pager, splitSentences } from './pager';

const CAPACITY = 10;

/** Height of an element: `data-h`, a table's rows plus its header, or a paragraph's text. */
function height(el: Element): number {
  if (el.tagName === 'TABLE') {
    return 1 + [...el.querySelectorAll('tbody tr')].reduce((s, r) => s + height(r), 0);
  }
  const h = el.getAttribute('data-h');
  if (h) return Number(h);
  // paragraphs: one unit per 20 characters
  return Math.ceil(el.textContent.length / 20);
}

function setup() {
  const root = document.createElement('div');
  const pager = new Pager({
    root,
    frame: (section) => {
      const page = document.createElement('section');
      page.dataset.section = section;
      const body = document.createElement('div');
      page.appendChild(body);
      root.appendChild(page);
      return { page, body };
    },
    overflows: (body) => [...body.children].reduce((s, c) => s + height(c), 0) > CAPACITY,
  });
  return { root, pager };
}

function block(h: number, tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  el.dataset.h = String(h);
  return el;
}

function page(p: Pager, i: number): HTMLElement {
  const pg = p.pages[i];
  if (!pg) throw new Error(`no page ${String(i)}`);
  return pg;
}

const contents = (page: HTMLElement) =>
  [...(page.firstElementChild?.children ?? [])].map((c) => c.getAttribute('data-h') ?? c.tagName);

describe('Pager', () => {
  it('starts a new page when a block does not fit', () => {
    const { pager } = setup();
    expect(pager.start('summary')).toBe(1);
    expect(pager.add(block(6))).toBe(1);
    expect(pager.add(block(3))).toBe(1);
    expect(pager.add(block(4))).toBe(2);
    expect(pager.pages).toHaveLength(2);
    expect(pager.pages.map((p) => p.dataset.section)).toEqual(['summary', 'summary']);
  });

  it('keeps a heading with the block after it', () => {
    const { pager } = setup();
    pager.start('scope');
    pager.add(block(7));
    pager.add(block(2, 'h2'), true);
    expect(pager.add(block(4))).toBe(2);
    expect(contents(page(pager, 0))).toEqual(['7']);
    expect(contents(page(pager, 1))).toEqual(['2', '4']);
  });

  it('leaves a block taller than a page alone on its page', () => {
    const { pager } = setup();
    pager.start('site');
    pager.add(block(12));
    expect(pager.pages).toHaveLength(1);
    expect(pager.add(block(1))).toBe(2);
  });

  it('splits a paragraph longer than a page between sentences', () => {
    const { pager } = setup();
    pager.start('summary');
    const p = document.createElement('p');
    // 12 sentences of 20 characters: 12 units over pages of 10
    p.textContent = Array.from(
      { length: 12 },
      (_, i) => `Sentence ${String(i).padStart(2, '0')} is here.`,
    ).join(' ');
    pager.add(p);
    expect(pager.pages.length).toBeGreaterThanOrEqual(2);
    const text = pager.pages.map((pg) => pg.textContent).join(' ');
    expect(text).toContain('Sentence 00');
    expect(text).toContain('Sentence 11');
  });

  it('flows table rows over pages and repeats the header', () => {
    const { pager } = setup();
    pager.start('register');
    pager.add(block(2, 'h2'), true);
    const make = () => {
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>Code</th></tr></thead><tbody></tbody>';
      const tbody = table.querySelector('tbody');
      if (!tbody) throw new Error('tbody');
      return { table, tbody };
    };
    const rows = Array.from({ length: 20 }, () => {
      const tr = document.createElement('tr');
      tr.dataset.h = '1';
      return tr;
    });
    const pages = pager.table(make, rows);
    // page 1: heading 2 + header 1 + 7 rows; then header + 9 rows per page
    expect(pages.filter((p) => p === 1)).toHaveLength(7);
    expect(pages.filter((p) => p === 2)).toHaveLength(9);
    expect(pages.at(-1)).toBe(3);
    for (const page of pager.pages) expect(page.querySelectorAll('thead').length).toBe(1);
  });

  it('moves a table with its heading when not even its first row fits', () => {
    const { pager } = setup();
    pager.start('statistics');
    pager.add(block(7));
    pager.add(block(1, 'h2'), true);
    const make = () => {
      const table = document.createElement('table');
      table.innerHTML = '<thead></thead><tbody></tbody>';
      const tbody = table.querySelector('tbody');
      if (!tbody) throw new Error('tbody');
      return { table, tbody };
    };
    const row = document.createElement('tr');
    row.dataset.h = '3';
    expect(pager.table(make, [row])).toEqual([2]);
    expect(contents(page(pager, 1))).toEqual(['1', 'TABLE']);
  });

  it('puts fixed pages in order', () => {
    const { pager } = setup();
    pager.fixed('cover', '<h1>Cover</h1>');
    pager.start('contents');
    pager.add(block(1));
    pager.fixed('issue', '<h2>F01</h2>');
    expect(pager.pages.map((p) => p.dataset.section)).toEqual(['cover', 'contents', 'issue']);
  });
});

describe('splitSentences', () => {
  it('cuts between sentences near the middle', () => {
    expect(splitSentences('One two three. Four. Five six.')).toEqual([
      'One two three.',
      'Four. Five six.',
    ]);
  });
  it('falls back to a space, and gives up on one word', () => {
    expect(splitSentences('alpha beta gamma delta')).toEqual(['alpha beta', 'gamma delta']);
    expect(splitSentences('word')).toBeNull();
  });
});
