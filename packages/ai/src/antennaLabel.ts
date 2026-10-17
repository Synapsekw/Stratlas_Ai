/**
 * The AI label for a detected telecom unit (spec: antenna detection, AI labelling). The geometry
 * job finds the units and measures every number; the model only looks at a crop of the best photo
 * of each unit and picks one label from a fixed set. It is never asked for a number, and its
 * answer changes only the unit's kind, kind basis and `ai` record.
 */
import { AI_LABEL_KIND, AntennaAiLabel } from '@aio/schema';
import { extractJson, imageTokens } from './detect';

export const ANTENNA_LABEL_PROMPT_VERSION = 'antenna-label-v1';

/** The longest reason kept, as the IPC contract allows. */
const REASON_MAX = 200;

/** What the crop images are assumed to be for the estimate: the job writes small crops. */
const CROP_PX = 512;
const OUTPUT_PER_IMAGE = 60;

const LABEL_HELP: Record<AntennaAiLabel, string> = {
  panel: 'a flat sector panel antenna, tall and narrow',
  'short-antenna': 'a short or stubby antenna, a small panel or a whip',
  'radio-unit':
    'a compact radio unit or a remote radio head, a boxy cabinet behind or beside an antenna',
  dish: 'a round microwave dish or its dome cover',
  other: 'anything else, or nothing clear in the crop',
};

/** The fixed instructions: the label set, one label per image, a short reason, JSON only. */
export function antennaLabelInstructions(): string {
  const labels = (Object.keys(AI_LABEL_KIND) as AntennaAiLabel[])
    .map((l) => `- "${l}": ${LABEL_HELP[l]}`)
    .join('\n');
  return [
    'You look at crops of photos of a telecom tower. Each crop shows one piece of equipment.',
    'Choose exactly one label for each image from this fixed set:',
    labels,
    'Give one label per image, never more. Use "other" when you are not sure.',
    'Add a short reason of 20 words or fewer for each label.',
    'Do not report any measurements. Say only what the equipment is.',
    'Answer with JSON only, no other text, in this form:',
    '{"labels":[{"key":"<key of the image>","label":"<one label>","reason":"<reason>"}]}',
  ].join('\n');
}

/** The text that goes with the images of one request: the keys, in the order attached. */
export function antennaLabelUserText(keys: readonly string[]): string {
  const list = keys.map((k, i) => `${String(i + 1)}. ${k}`).join('\n');
  return `There are ${String(keys.length)} images, in this order. Use these keys in your answer:\n${list}`;
}

export interface ParsedAntennaLabels {
  labels: { unitId: string; label: AntennaAiLabel; reason: string }[];
  warnings: string[];
}

/** Longest model-chosen key echoed back in a warning. */
export const WARNING_KEY_MAX = 80;
/** Most warnings one reply produces; the last says how many more there were. */
export const WARNINGS_MAX = 20;

const echo = (key: string) =>
  key.length > WARNING_KEY_MAX ? `${key.slice(0, WARNING_KEY_MAX)}...` : key;

/** The labels in a model reply, for the keys that were sent; anything else is dropped with a warning. */
export function parseAntennaLabels(text: string, keys: readonly string[]): ParsedAntennaLabels {
  const warnings: string[] = [];
  const labels: ParsedAntennaLabels['labels'] = [];
  const asked = new Set(keys);
  const json = extractJson(text);
  const list =
    typeof json === 'object' &&
    json !== null &&
    Array.isArray((json as { labels?: unknown }).labels)
      ? (json as { labels: unknown[] }).labels
      : null;
  if (!list) {
    return { labels, warnings: ['The reply was not a list of labels, so no unit was labelled.'] };
  }
  const seen = new Set<string>();
  const badLabel = new Set<string>();
  for (const item of list) {
    const o = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const key = typeof o.key === 'string' ? o.key : '';
    if (!asked.has(key)) {
      warnings.push(`The reply labelled "${echo(key)}", which was not sent. It was ignored.`);
      continue;
    }
    if (seen.has(key)) continue;
    const label = AntennaAiLabel.safeParse(o.label);
    if (!label.success) {
      if (!badLabel.has(key))
        warnings.push(`The label for ${key} is not one of the allowed labels. It was ignored.`);
      badLabel.add(key);
      continue;
    }
    seen.add(key);
    const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, REASON_MAX) : '';
    labels.push({ unitId: key, label: label.data, reason });
  }
  for (const k of keys) {
    if (!seen.has(k) && !badLabel.has(k)) warnings.push(`The reply has no label for ${k}.`);
  }
  if (warnings.length > WARNINGS_MAX) {
    const more = warnings.length - (WARNINGS_MAX - 1);
    warnings.splice(
      WARNINGS_MAX - 1,
      warnings.length,
      `${String(more)} more warnings were not listed.`,
    );
  }
  return { labels, warnings };
}

const textTokens = (s: string) => Math.ceil(s.length / 4);

/** Rough size of one batch worth of crops; the provider's invoice is authoritative. */
export function estimateAntennaLabel(images: number): { images: number; inputTokens: number } {
  const n = Math.max(0, Math.floor(images));
  if (n === 0) return { images: 0, inputTokens: 0 };
  const perImage =
    imageTokens('anthropic', CROP_PX, CROP_PX) + textTokens('Image 1 ant-0000000000');
  return { images: n, inputTokens: textTokens(antennaLabelInstructions()) + n * perImage };
}

/** Output tokens to expect for the estimate's cost. */
export const antennaLabelOutputTokens = (images: number): number => images * OUTPUT_PER_IMAGE;
