/**
 * The report narrative (PRD BLD-7): the request the `report` route gets to draft the executive
 * summary, the scope and method, and the findings text from a project's statistics, and the
 * parser for its answer. Pure: the renderer shows the exact request before it is sent (AI-6) and
 * main sends it with `ai:draftText`.
 */
import { NARRATIVE_SECTIONS, type NarrativeSectionId } from '@aio/schema';

export interface NarrativeRequest {
  system: string;
  prompt: string;
}

const PART_BRIEF: Record<NarrativeSectionId, string> = {
  summary:
    'summary: the executive summary, two or three short paragraphs for a client manager: what was inspected, when, how many findings by severity, the most important ones and what to do next.',
  method:
    'method: the scope and method, one or two paragraphs: the capture (dates, sensors, data), how findings were made and graded with the severity scale, and the limits of a visual drone assessment.',
  findings:
    'findings: the findings overview, two or three paragraphs: the distribution by class, zone and severity, the notable issues by code, and any volumes or pavement condition figures given.',
};

/**
 * The request for the narrative parts in `parts` from `facts` (the project statistics as
 * JSON). Asks for one JSON object so each part lands in its own field.
 */
export function narrativeRequest(
  facts: unknown,
  parts: readonly NarrativeSectionId[] = NARRATIVE_SECTIONS,
): NarrativeRequest {
  const keys = parts.map((p) => `"${p}"`).join(', ');
  const system = [
    'You write the narrative of a drone inspection or survey report for an engineering client.',
    'Write in plain British English, in the third person, factual and concise.',
    'Use only the figures in the statistics you are given; never invent numbers, dates, causes or locations.',
    'Do not use em dashes or en dashes. Do not use Markdown headings, bullet lists or bold text.',
    'Separate paragraphs with a blank line.',
    `Answer with one JSON object with the keys ${keys} and a string value for each, and nothing else.`,
  ].join(' ');
  const prompt = [
    'Write these parts of the report:',
    ...parts.map((p) => `- ${PART_BRIEF[p]}`),
    '',
    'Project statistics (JSON):',
    JSON.stringify(facts, null, 2),
  ].join('\n');
  return { system, prompt };
}

/** The first balanced JSON object in a reply (models sometimes wrap it in prose or a fence). */
function firstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Text without em or en dashes (CONTRIBUTING), trimmed, with at most one blank line in a row. */
export function cleanNarrative(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The parts of a narrative reply. A reply that is not JSON is taken as the text of the only part
 * asked for; with several parts asked for, it is an error.
 */
export function parseNarrativeReply(
  text: string,
  parts: readonly NarrativeSectionId[] = NARRATIVE_SECTIONS,
): { ok: true; parts: Partial<Record<NarrativeSectionId, string>> } | { ok: false; error: string } {
  const raw = firstObject(text);
  if (raw) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const out: Partial<Record<NarrativeSectionId, string>> = {};
      for (const p of parts) {
        const v = obj[p];
        if (typeof v === 'string' && v.trim()) out[p] = cleanNarrative(v);
      }
      if (Object.keys(out).length > 0) return { ok: true, parts: out };
    } catch {
      // fall through
    }
  }
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only && text.trim()) return { ok: true, parts: { [only]: cleanNarrative(text) } };
  return { ok: false, error: 'The model did not answer with the report text. Try again.' };
}
