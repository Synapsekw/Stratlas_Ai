/**
 * Search over the user guide, all in memory: every chapter is cut into sections at its ## and
 * ### headings; a query matches a section when each word of it starts a word of the section.
 * Title hits weigh more than body hits.
 */
import type { Chapter } from './guide';
import { plainText, type Block } from './markdown';

export interface Section {
  chapter: string;
  chapterTitle: string;
  /** Heading anchor; empty for the chapter's opening text. */
  anchor: string;
  title: string;
  text: string;
  titleWords: string[];
  words: string[];
}

export interface Hit {
  chapter: string;
  chapterTitle: string;
  anchor: string;
  title: string;
  snippet: string;
  score: number;
}

/** Lower-case words of a text (letters and digits). */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'heading':
    case 'paragraph':
      return plainText(b.children);
    case 'list':
      return b.items
        .map((it) => `${plainText(it.children)} ${it.sub ? blockText(it.sub) : ''}`)
        .join(' ');
    case 'quote':
      return b.blocks.map(blockText).join(' ');
    case 'code':
      return b.text;
    case 'table':
      return [b.head, ...b.rows].map((r) => r.map(plainText).join(' ')).join(' ');
    case 'image':
      return b.alt;
    case 'rule':
      return '';
  }
}

/** The searchable sections of the guide. */
export function buildIndex(chapters: Chapter[]): Section[] {
  const out: Section[] = [];
  for (const ch of chapters) {
    let current: Omit<Section, 'words' | 'titleWords'> = {
      chapter: ch.slug,
      chapterTitle: ch.title,
      anchor: '',
      title: ch.title,
      text: '',
    };
    const push = () => {
      const text = current.text.replace(/\s+/g, ' ').trim();
      if (text || current.anchor)
        out.push({ ...current, text, titleWords: words(current.title), words: words(text) });
    };
    for (const b of ch.blocks) {
      if (b.kind === 'heading' && b.level === 1) continue;
      if (b.kind === 'heading' && b.level <= 3) {
        push();
        current = {
          chapter: ch.slug,
          chapterTitle: ch.title,
          anchor: b.id,
          title: plainText(b.children),
          text: '',
        };
        continue;
      }
      current.text += ` ${blockText(b)}`;
    }
    push();
  }
  return out;
}

function snippet(text: string, terms: string[], width = 140): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
    const m = re.exec(lower);
    if (m) {
      at = m.index + (m[1] ?? '').length;
      break;
    }
  }
  if (at < 0 || text.length <= width)
    return text.length <= width ? text : `${text.slice(0, width)}…`;
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Sections matching every word of `query`, best first. */
export function search(index: Section[], query: string, limit = 30): Hit[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const hits: Hit[] = [];
  for (const s of index) {
    let score = 0;
    let all = true;
    for (const term of terms) {
      const inTitle = s.titleWords.filter((w) => w.startsWith(term)).length;
      const inText = s.words.filter((w) => w.startsWith(term)).length;
      if (inTitle + inText === 0 && !s.chapterTitle.toLowerCase().includes(term)) {
        all = false;
        break;
      }
      score += inTitle * 6 + Math.min(inText, 8) + (s.titleWords.includes(term) ? 4 : 0);
    }
    if (!all) continue;
    hits.push({
      chapter: s.chapter,
      chapterTitle: s.chapterTitle,
      anchor: s.anchor,
      title: s.title,
      snippet: snippet(s.text, terms),
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
