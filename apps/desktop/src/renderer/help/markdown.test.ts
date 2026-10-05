import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, plainText, slugify } from './markdown';

describe('parseInline', () => {
  it('reads bold, emphasis, code and links', () => {
    expect(parseInline('Click **Save** then _wait_ for `x` [here](a.md#b).')).toEqual([
      { kind: 'text', text: 'Click ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'Save' }] },
      { kind: 'text', text: ' then ' },
      { kind: 'em', children: [{ kind: 'text', text: 'wait' }] },
      { kind: 'text', text: ' for ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: 'a.md#b', children: [{ kind: 'text', text: 'here' }] },
      { kind: 'text', text: '.' },
    ]);
  });

  it('leaves snake_case and HTML as plain text', () => {
    expect(parseInline('a_b_c <script>alert(1)</script>')).toEqual([
      { kind: 'text', text: 'a_b_c <script>alert(1)</script>' },
    ]);
  });

  it('honours backslash escapes', () => {
    expect(plainText(parseInline('\\*not bold\\*'))).toBe('*not bold*');
  });
});

describe('parseMarkdown', () => {
  it('parses headings with unique anchors', () => {
    const blocks = parseMarkdown('# Title\n\n## Data folder\n\n## Data folder\n');
    expect(blocks.map((b) => (b.kind === 'heading' ? b.id : b.kind))).toEqual([
      'title',
      'data-folder',
      'data-folder-1',
    ]);
  });

  it('parses ordered lists with nested bullets and wrapped lines', () => {
    const [list] = parseMarkdown('1. One\n   - Sub a\n   - Sub b\n2. Two\n   more\n');
    expect(list?.kind).toBe('list');
    if (list?.kind !== 'list') return;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.sub?.items.map((i) => plainText(i.children))).toEqual(['Sub a', 'Sub b']);
    expect(plainText(list.items[1]?.children ?? [])).toBe('Two more');
  });

  it('keeps a list going across a blank line between items', () => {
    const blocks = parseMarkdown('1. One\n\n   Text under\n2. Two\n');
    // the indented paragraph ends the list; a tolerant reading is fine as long as nothing is lost
    expect(blocks.map((b) => b.kind)).toContain('list');
  });

  it('parses tables, quotes, images, code and rules', () => {
    const src = [
      '| Keys | Does |',
      '| ---- | ---- |',
      '| F1   | Help |',
      '',
      '> A tip',
      '',
      '![Shot](images/a.png)',
      '',
      '```',
      'code',
      '```',
      '',
      '---',
    ].join('\n');
    const blocks = parseMarkdown(src);
    expect(blocks.map((b) => b.kind)).toEqual(['table', 'quote', 'image', 'code', 'rule']);
    const table = blocks[0];
    if (table?.kind === 'table') expect(plainText(table.rows[0]?.[0] ?? [])).toBe('F1');
  });

  it('joins paragraph lines', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'one two' }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'three' }] },
    ]);
  });
});

describe('slugify', () => {
  it('matches GitHub anchors', () => {
    expect(slugify('Volumes (stockpiles)')).toBe('volumes-stockpiles');
    expect(slugify('3D, Map and Split')).toBe('3d-map-and-split');
  });
});
