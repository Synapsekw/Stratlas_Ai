export interface Command {
  id: string;
  title: string;
  /** Section heading in the palette: Navigate, Projects, Layers, Issues, Actions. */
  group: string;
  /** Extra words that match but are not shown. */
  keywords?: string[];
  /** Right-aligned hint: a count, a status, why it cannot run. */
  hint?: string;
  /** The keys that do the same, as people read them (`M`, `Ctrl B`): shown at the row's end. */
  shortcut?: string;
  /**
   * Added to the match score to break a near tie (the person's favourite tools first). Keep it
   * at 1 or less: one better-placed letter is worth more, so a boost never beats a better match.
   */
  boost?: number;
  run: () => void;
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1] ?? ' ';
  return /[\s_\-/.,·(]/.test(prev);
};

/**
 * Fuzzy subsequence score, higher is better; null when `query` is not a subsequence of `text`.
 * Rewards a prefix match, matches at word starts and consecutive runs.
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 8;
    if (isBoundary(t, found)) s += 6;
    if (found === 0) s += 8;
    score += s;
    prev = found;
    ti = found + 1;
  }
  // Shorter texts with the same matches rank higher.
  return score - t.length * 0.01;
}

/**
 * A keyword (a word that matches but is not shown) counts for less than the label: a label that
 * matches as well ranks first, while a whole-word keyword still beats letters scattered through a
 * label.
 */
const KEYWORD_WEIGHT = 0.6;

export function rankCommands(commands: readonly Command[], query: string, limit = 60): Command[] {
  if (!query.trim()) return commands.slice(0, limit);
  const scored: { c: Command; s: number }[] = [];
  for (const c of commands) {
    let best = scoreMatch(query, c.title);
    for (const text of c.keywords ?? []) {
      const s = scoreMatch(query, text);
      if (s !== null && (best === null || s * KEYWORD_WEIGHT > best)) best = s * KEYWORD_WEIGHT;
    }
    if (best !== null) scored.push({ c, s: best + (c.boost ?? 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.c);
}
