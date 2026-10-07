/**
 * Markdown-lite for comments: `**bold**`, `*italic*`, `` `code` `` and @mentions. Links stay
 * text: nothing is ever fetched or opened from a comment. Pure tokens, so the renderer draws them
 * with React (never innerHTML) and RTL text keeps its direction (`dir="auto"` on the paragraph).
 */
export type Token =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'code'; v: string }
  | { t: 'mention'; v: string };

const PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|@[\p{L}\p{N}_]+)/u;

/** One line of a comment as tokens. */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let rest = line;
  while (rest.length) {
    const m = PATTERN.exec(rest);
    if (!m) {
      out.push({ t: 'text', v: rest });
      break;
    }
    const at = m.index;
    const before = at > 0 ? rest.charAt(at - 1) : '';
    const hit = m[0];
    if (at > 0) out.push({ t: 'text', v: rest.slice(0, at) });
    if (hit.startsWith('**')) out.push({ t: 'bold', v: hit.slice(2, -2) });
    else if (hit.startsWith('*')) out.push({ t: 'italic', v: hit.slice(1, -1) });
    else if (hit.startsWith('`')) out.push({ t: 'code', v: hit.slice(1, -1) });
    else if (before && /[\p{L}\p{N}_]/u.test(before)) out.push({ t: 'text', v: hit });
    else out.push({ t: 'mention', v: hit.slice(1) });
    rest = rest.slice(at + hit.length);
  }
  // merge neighbouring text tokens (an email split at its @)
  return out.reduce<Token[]>((acc, tok) => {
    const last = acc.at(-1);
    if (last?.t === 'text' && tok.t === 'text') last.v += tok.v;
    else acc.push({ ...tok });
    return acc;
  }, []);
}

/** A comment as lines of tokens. */
export function renderLite(text: string): Token[][] {
  return text.split(/\r?\n/).map(tokenize);
}
