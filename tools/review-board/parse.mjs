// Markdown (the subset docs/TESTING.md and the release checklist use) to the review board's model:
// sections (##) with groups (###); each group is an ordered list of text blocks and items. An item is
// a checkbox line ("- [ ]", with its indented sub-bullets) or a table row. Item ids hash the
// section and the item's text, so a mark survives reordering but not a reworded line.
import { createHash } from 'node:crypto';

export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'section';

/** Markdown inline to plain text, for ids and the submission summary. */
export const plain = (md) =>
  md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function parseDoc(text, docId, docKind) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const doc = { title: '', intro: [], sections: [] };
  let section = null;
  let group = null;
  const used = new Map();

  const ensureGroup = () => {
    if (!section) {
      section = {
        id: `${docId}:intro`,
        title: 'Introduction',
        noteId: `${docId}:intro:note`,
        groups: [],
      };
      doc.sections.push(section);
    }
    if (!group) {
      group = { id: `${section.id}:main`, title: '', blocks: [], items: [] };
      section.groups.push(group);
    }
    return group;
  };
  const addItem = (item) => {
    const g = ensureGroup();
    const key = `${section.id}:${hash(item.plain)}`;
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    item.id = n === 1 ? key : `${key}-${n}`;
    item.counted = item.kind === 'check' || docKind === 'checklist';
    g.items.push(item);
    g.blocks.push({ type: 'item', id: item.id });
    return item;
  };

  let i = 0;
  let para = null; // { type: 'p', md }
  let list = null; // { type: 'ul' | 'ol', items: [{ md, sub: [] }] }
  const flush = () => {
    para = null;
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const indented = /^\s{2,}\S/.test(line);
    const t = line.trim();

    if (/^```/.test(t)) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      ensureGroup().blocks.push({ type: 'pre', text: code.join('\n') });
      continue;
    }
    if (/^# /.test(line)) {
      flush();
      doc.title = t.slice(2);
      i++;
      continue;
    }
    if (/^## /.test(line)) {
      flush();
      const title = t.slice(3);
      section = {
        id: `${docId}:${slug(title)}`,
        title,
        noteId: `${docId}:${slug(title)}:note`,
        groups: [],
      };
      doc.sections.push(section);
      group = null;
      i++;
      continue;
    }
    if (/^#{3,} /.test(line)) {
      flush();
      const title = t.replace(/^#+ /, '');
      ensureGroup();
      group = { id: `${section.id}:${slug(title)}`, title, blocks: [], items: [] };
      section.groups.push(group);
      i++;
      continue;
    }
    if (t === '' || t === '---') {
      flush();
      i++;
      continue;
    }
    if (t.startsWith('|')) {
      flush();
      const header = cells(t);
      i++;
      if (i < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) i++;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const row = cells(lines[i]);
        const fields = Object.fromEntries(header.map((h, k) => [h || `col${k}`, row[k] ?? '']));
        const hasNum = header[0] === '#';
        const md = hasNum ? `${row[0]} · ${row[1] ?? ''}` : (row[0] ?? '');
        addItem({ kind: 'row', md, plain: plain(row.join(' | ')), fields, header });
        i++;
      }
      continue;
    }
    if (indented && list) {
      const s = line.trim();
      const last = list.items[list.items.length - 1];
      if (/^[-*] /.test(s)) last.sub.push(s.slice(2));
      else last.md += ` ${s}`;
      i++;
      continue;
    }
    const check = /^[-*] \[( |x|X)\] (.*)$/.exec(t);
    if (check && !indented) {
      para = null;
      list = null;
      const item = { kind: 'check', md: check[2], sub: [], plain: '' };
      i++;
      // the indented lines below belong to this item: sub-bullets or continued text
      while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
        const s = lines[i].trim();
        if (/^[-*] /.test(s)) item.sub.push(s.slice(2));
        else if (item.sub.length) item.sub[item.sub.length - 1] += ` ${s}`;
        else item.md += ` ${s}`;
        i++;
      }
      item.plain = plain([item.md, ...item.sub].join(' '));
      addItem(item);
      continue;
    }
    const bullet = /^[-*] (.*)$/.exec(t);
    const num = /^\d+\. (.*)$/.exec(t);
    if ((bullet || num) && !indented) {
      para = null;
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        list = { type, items: [] };
        ensureGroup().blocks.push(list);
      }
      list.items.push({ md: (bullet ?? num)[1], sub: [] });
      i++;
      continue;
    }
    // paragraph text (a quote is shown as a paragraph)
    list = null;
    const md = t.replace(/^> ?/, '');
    if (para) para.md += ` ${md}`;
    else {
      para = { type: 'p', md };
      ensureGroup().blocks.push(para);
    }
    i++;
  }
  for (const s of doc.sections) s.groups = s.groups.filter((g) => g.blocks.length > 0);
  return doc;
}
