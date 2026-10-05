/**
 * The Markdown subset the user guide is written in (docs/guide), parsed into a small tree that
 * the help panel and the printed guide render as React elements. Nothing is ever injected as
 * HTML: raw HTML in the source stays literal text, links only go to other chapters or anchors,
 * and images only come from the bundled guide images. That is the whole sanitiser.
 *
 * Blocks: headings (# to ####), paragraphs, lists (- or 1., one nested level), quotes (> as a
 * tip), fenced code, pipe tables, an image on its own line, and ---. Inline: **bold**, _em_ or
 * *em*, `code`, [text](target), and backslash escapes.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] };

export interface ListItem {
  children: Inline[];
  /** A nested list under this item. */
  sub?: Extract<Block, { kind: 'list' }>;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; id: string; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'rule' };

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Plain text of inline content (search, anchors, alt text). */
export function plainText(inlines: Inline[]): string {
  return inlines
    .map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : plainText(n.children)))
    .join('');
}

const ESCAPABLE = '\\`*_[]()#+-.!|>{}';

/** Parse inline Markdown. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1] ?? '')) {
      text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ kind: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === '_' || c === '*') && /\S/.test(src[i + 1] ?? ' ')) {
      // _em_ only at a word start, so snake_case names stay as they are
      const atWordStart = i === 0 || !/[\p{L}\p{N}]/u.test(src[i - 1] ?? '');
      const end = src.indexOf(c, i + 1);
      const closes = end > i + 1 && !/[\p{L}\p{N}]/u.test(src[end + 1] ?? ' ');
      if ((c === '*' || atWordStart) && closes) {
        flush();
        out.push({ kind: 'em', children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = src.indexOf('](', i + 1);
      const end = close > i ? src.indexOf(')', close + 2) : -1;
      if (close > i && end > close) {
        flush();
        out.push({
          kind: 'link',
          href: src.slice(close + 2, end).trim(),
          children: parseInline(src.slice(i + 1, close)),
        });
        i = end + 1;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return out;
}

const HEADING = /^(#{1,4})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*```/;

const isTableRow = (line: string) => line.trim().startsWith('|');
const isDelimiterRow = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

function tableCells(line: string): Inline[][] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // split on pipes that are not escaped
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cell += '\\|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
    } else cell += ch ?? '';
  }
  cells.push(cell);
  return cells.map((c) => parseInline(c.trim()));
}

/** Starts a block other than a paragraph continuation. */
function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    IMAGE.test(line) ||
    RULE.test(line) ||
    FENCE.test(line) ||
    line.trimStart().startsWith('>') ||
    isTableRow(line)
  );
}

/** Parse a Markdown document into blocks. Heading ids are made unique within the document. */
export function parseMarkdown(src: string): Block[] {
  const ids = new Map<string, number>();
  const uniqueId = (text: string) => {
    const base = slugify(text) || 'section';
    const n = ids.get(base) ?? 0;
    ids.set(base, n + 1);
    return n === 0 ? base : `${base}-${String(n)}`;
  };
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), uniqueId);
}

function parseBlocks(lines: string[], uniqueId: (text: string) => string): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length as 1 | 2 | 3 | 4;
      const children = parseInline(heading[2] ?? '');
      blocks.push({ kind: 'heading', level, id: uniqueId(plainText(children)), children });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }
    const image = IMAGE.exec(line);
    if (image) {
      blocks.push({ kind: 'image', alt: image[1] ?? '', src: image[2] ?? '' });
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('>')) {
        body.push((lines[i] ?? '').trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(body, uniqueId) });
      continue;
    }
    if (isTableRow(line) && isDelimiterRow(lines[i + 1] ?? '')) {
      const head = tableCells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        rows.push(tableCells(lines[i] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      (para.length === 0 || !startsBlock(lines[i] ?? ''))
    ) {
      para.push((lines[i] ?? '').trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(para.join(' ')) });
  }
  return blocks;
}

type ListBlock = Extract<Block, { kind: 'list' }>;

function listMarker(
  line: string,
): { indent: number; ordered: boolean; n: number; text: string } | null {
  const b = BULLET.exec(line);
  if (b) return { indent: (b[1] ?? '').length, ordered: false, n: 1, text: b[2] ?? '' };
  const o = ORDERED.exec(line);
  if (o) return { indent: (o[1] ?? '').length, ordered: true, n: Number(o[2]), text: o[3] ?? '' };
  return null;
}

function parseList(lines: string[], from: number): [ListBlock, number] {
  const first = listMarker(lines[from] ?? '');
  const indent = first?.indent ?? 0;
  const list: ListBlock = {
    kind: 'list',
    ordered: first?.ordered ?? false,
    start: first?.n ?? 1,
    items: [],
  };
  let i = from;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      // a blank line inside a list continues it only when the next line is still an item
      const next = listMarker(lines[i + 1] ?? '');
      if (next && next.indent >= indent) {
        i += 1;
        continue;
      }
      break;
    }
    const m = listMarker(line);
    if (m?.indent === indent && m.ordered === list.ordered) {
      list.items.push({ children: parseInline(m.text) });
      i += 1;
      continue;
    }
    if (m && m.indent > indent) {
      const [sub, next] = parseList(lines, i);
      const last = list.items[list.items.length - 1];
      if (last) last.sub = sub;
      i = next;
      continue;
    }
    if (!m && /^\s+/.test(line) && list.items.length > 0) {
      // a wrapped continuation line of the last item
      const last = list.items[list.items.length - 1];
      if (last) last.children = [...last.children, ...parseInline(` ${line.trim()}`)];
      i += 1;
      continue;
    }
    break;
  }
  return [list, i];
}
