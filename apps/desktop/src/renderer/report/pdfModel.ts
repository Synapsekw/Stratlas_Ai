/** Pure layout and search maths of the PDF viewer. */

export const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** Scale that fits a page `pageWidth` (PDF points at scale 1) into the container. */
export function fitWidthScale(pageWidth: number, containerWidth: number, margin: number): number {
  if (pageWidth <= 0 || containerWidth <= margin) return 1;
  return (containerWidth - margin) / pageWidth;
}

export function clampPage(n: number, count: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.round(n)), Math.max(1, count));
}

/** Next zoom level up (dir 1) or down (dir -1) from `current`. */
export function nextZoom(current: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > current + eps) ?? ZOOM_LEVELS.at(-1) ?? current;
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - eps) ?? ZOOM_LEVELS[0];
}

/** Pages within `radius` of `page`, the ones worth rendering. */
export function nearbyPages(page: number, count: number, radius: number): number[] {
  const out: number[] = [];
  for (let p = Math.max(1, page - radius); p <= Math.min(count, page + radius); p++) out.push(p);
  return out;
}

/** Page (1 based) whose top is the last one at or above `offset`. */
export function pageAtOffset(tops: readonly number[], offset: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export interface SearchHit {
  page: number;
  count: number;
  snippet: string;
}

/** Find `query` in each page's text; a snippet around the first match. */
export function searchPages(texts: readonly string[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  texts.forEach((text, i) => {
    const lower = text.toLowerCase();
    let count = 0;
    let at = lower.indexOf(q);
    const first = at;
    while (at >= 0) {
      count++;
      at = lower.indexOf(q, at + q.length);
    }
    if (count === 0) return;
    const from = Math.max(0, first - 40);
    const to = Math.min(text.length, first + q.length + 60);
    const snippet = `${from > 0 ? '...' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${
      to < text.length ? '...' : ''
    }`;
    hits.push({ page: i + 1, count, snippet });
  });
  return hits;
}
