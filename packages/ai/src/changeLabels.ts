/**
 * Change labels (V4): what changed inside a change region, asked of the Compare route (`ai:ask`,
 * kind `change`) with a crop of the region on each date. The request builder and the answer
 * reader live here; the renderer makes the crops and saves the label on the region
 * (`RegionChange.aiLabel`). The label is a proposal for the register: it never changes the
 * region's verdict or its review.
 */
import {
  CHANGE_LABEL_KINDS,
  type AskItem,
  type ChangeLabelKind,
  type FieldSpec,
  type IpcRequest,
  type IpcResponse,
} from '@aio/schema';

/** The words the model picks from, one per kind (the choice values sent). */
export const CHANGE_LABEL_WORDS: Readonly<Record<ChangeLabelKind, string>> = {
  'material-added': 'material added',
  'material-removed': 'material removed',
  earthworks: 'earthworks',
  vehicle: 'vehicle',
  equipment: 'equipment',
  structure: 'structure',
  vegetation: 'vegetation',
  water: 'water',
  'no-change': 'no real change',
  other: 'other',
};

/** The fields of a change label request: the kind (a choice) and what changed. */
export const CHANGE_LABEL_FIELDS: FieldSpec[] = [
  {
    key: 'kind',
    label: 'Kind of change',
    type: 'choice',
    choices: CHANGE_LABEL_KINDS.map((k) => CHANGE_LABEL_WORDS[k]),
  },
  { key: 'what', label: 'What', type: 'text' },
];

export const CHANGE_LABEL_PROMPT =
  'What changed inside the marked area between the two dates? The marked area is the middle of each image, outlined in yellow; look only inside it. Give one item for the main change there, with its box around what changed on Image 2, and pick the kind of change. If nothing real changed inside the area, output [].';

type AskImage = IpcRequest<'ai:ask'>['images'][number];
type AskBackend = IpcRequest<'ai:ask'>['backend'];

/** The `ai:ask` request that labels one region from its crop on each date (earlier first). */
export function changeLabelAsk(i: {
  runId: string;
  projectId: string;
  backend: AskBackend;
  before: AskImage;
  after: AskImage;
  /** The region's area, said in the prompt when known. */
  region?: { areaM2?: number | undefined };
}): IpcRequest<'ai:ask'> {
  const area =
    i.region?.areaM2 !== undefined && Number.isFinite(i.region.areaM2)
      ? ` The marked area is about ${String(Math.round(i.region.areaM2))} square metres.`
      : '';
  return {
    runId: i.runId,
    projectId: i.projectId,
    backend: i.backend,
    kind: 'change',
    prompt: `${CHANGE_LABEL_PROMPT}${area}`,
    fields: CHANGE_LABEL_FIELDS,
    images: [i.before, i.after],
    wholeImage: true,
  };
}

/** A box normalised 0 to 1: x0, y0, x1, y1. */
export type UnitBox = readonly [number, number, number, number];

const overlap = (a: UnitBox, b: UnitBox) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

const BY_WORD = new Map<string, ChangeLabelKind>(
  CHANGE_LABEL_KINDS.map((k) => [CHANGE_LABEL_WORDS[k], k]),
);

/** Words in the model's own text that say a kind, when it left the choice empty. */
const KEYWORDS: readonly [RegExp, ChangeLabelKind][] = [
  [/\b(no (real )?change|nothing changed|unchanged)\b/, 'no-change'],
  [/\b(truck|lorry|car|van|vehicle|tipper|dumper)s?\b/, 'vehicle'],
  [
    /\b(excavator|crane|digger|loader|dozer|bulldozer|machine|equipment|generator)s?\b/,
    'equipment',
  ],
  [
    /\b(stockpile|pile|heap|material|gravel|sand|spoil)s?\b.*\b(removed|gone|smaller)\b/,
    'material-removed',
  ],
  [/\b(stockpile|pile|heap|material|gravel|sand|spoil)s?\b/, 'material-added'],
  [/\b(earthworks?|excavation|trench|grading|cut|fill)\b/, 'earthworks'],
  [/\b(building|structure|wall|roof|foundation|slab|container|fence)s?\b/, 'structure'],
  [/\b(tree|grass|vegetation|bush|shrub|crop)s?\b/, 'vegetation'],
  [/\b(water|puddle|pond|flood|flooding)\b/, 'water'],
];

function kindOf(item: AskItem): ChangeLabelKind {
  const v = item.fields.find((f) => f.key === 'kind')?.value;
  const hit = typeof v === 'string' ? BY_WORD.get(v.trim().toLowerCase()) : undefined;
  if (hit) return hit;
  const what = item.fields.find((f) => f.key === 'what')?.value;
  const text = [item.label, typeof what === 'string' ? what : '', item.note]
    .join(' ')
    .toLowerCase();
  return KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'other';
}

function whatOf(item: AskItem): string | undefined {
  const v = item.fields.find((f) => f.key === 'what')?.value;
  const s = (typeof v === 'string' && v.trim() ? v : item.label).trim().slice(0, 80).trim();
  return s && s !== 'item' ? s : undefined;
}

/**
 * The label in an answer: the item that overlaps the marked area most (`mark`, normalised to
 * the image; the first item without one), its kind from the choice word (the model's own words
 * otherwise, then `other`). No items is `no-change`. Null when the request failed.
 */
export function readChangeLabel(
  response: IpcResponse<'ai:ask'>,
  mark?: UnitBox,
): { kind: ChangeLabelKind; what?: string; model?: string } | null {
  if (!response.ok) return null;
  const model = response.model ? { model: response.model.slice(0, 120) } : {};
  const [first, ...rest] = response.items;
  if (!first) return { kind: 'no-change', ...model };
  let best = first;
  if (mark) {
    let most = overlap(first.box, mark);
    for (const it of rest) {
      const o = overlap(it.box, mark);
      if (o > most) {
        most = o;
        best = it;
      }
    }
  }
  const what = whatOf(best);
  return { kind: kindOf(best), ...(what ? { what } : {}), ...model };
}
