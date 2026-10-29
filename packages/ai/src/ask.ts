/**
 * Custom analytics, the parts every runner shares: the prompts (so the send preview shows what is
 * sent), the reply parser with its repairs, the box guards, the routing table and the cost
 * estimate. No provider SDKs here: the renderer imports it. The local runner (main), the cloud
 * runner (main) and the renderer build on these names.
 *
 * Results are proposals only: they land as drafts for the review, never counted until accepted.
 * Severity is never asked of the model.
 */
import type {
  AskItem,
  AskKind,
  AskModelChoice,
  AskScope,
  FieldSpec,
  FieldValue,
} from '@aio/schema';
import { imageTokens, type DetectEstimate } from './detect';
import { estimateCostUsd } from './pricing';

/** Bump when a prompt or the reply format changes; stored with every result. */
export const ASK_PROMPT_VERSION = 'ask-v1';
/** First line of every cloud prompt (the scripted test model keys on it). */
export const ASK_MARKER = '<aio-ask>';
/** Items kept per image. */
export const MAX_ASK_ITEMS = 30;
/** Longest side of an image as sent. */
export const ASK_SEND_MAX_PX = { cloud: 1568, local: 1344 } as const;

/** The two values every change request reads first. The item's label is `what`. */
export const CHANGE_FIELDS: FieldSpec[] = [
  {
    key: 'change_type',
    label: 'Change',
    type: 'choice',
    choices: ['new', 'removed', 'moved', 'progress', 'damage'],
  },
  { key: 'what', label: 'What', type: 'text' },
];

/**
 * Box frame of the answering model: `qwen3` answers 0 to 1000, `qwen25` sent pixels, `cloud`
 * models integer pixels of the image as sent (the prompt says its size).
 */
export type AskFamily = 'qwen25' | 'qwen3' | 'cloud';

// ---- prompts ----

const K = '"bbox_2d": [x1, y1, x2, y2]';
const CHANGE_KEYS = new Set(CHANGE_FIELDS.map((f) => f.key));

function fieldPart(f: FieldSpec): string {
  switch (f.type) {
    case 'number':
      return `, "${f.key}": <${f.label}${f.unit ? ` in ${f.unit}` : ''} as a number, or null if you cannot read it>`;
    case 'text':
      return `, "${f.key}": "<${f.label}, max 10 words>"`;
    case 'yesno':
      return `, "${f.key}": "yes|no|unknown"`;
    case 'choice':
      return `, "${f.key}": "${(f.choices ?? []).join('|')}"`;
  }
}

/** The text of one request (the images go before it). Sizes are the sent sizes. */
export function askPrompt(i: {
  family: AskFamily;
  kind: AskKind;
  prompt: string;
  fields: readonly FieldSpec[];
  images: readonly { width: number; height: number; label?: string }[];
}): string {
  const prompt = i.prompt.trim();
  const cloud = i.family === 'cloud';
  const C = i.family === 'qwen3' ? ' with bbox_2d coordinates normalised to 0-1000' : '';
  const last = i.images[i.images.length - 1];
  const size = last ? `${String(last.width)} x ${String(last.height)}` : '';
  let body: string;
  if (i.kind === 'ask') {
    body = `You help an inspection engineer review drone inspection photos. Answer in plain text, briefly and concretely. Say when something cannot be seen clearly. Do not grade severity; the engineer sets it.\n${prompt}`;
  } else if (i.kind === 'find') {
    const F = i.fields.map(fieldPart).join('');
    const PX =
      cloud && last
        ? ` Box coordinates are integer pixels of the image (it is ${size} pixels as sent), x to the right, y down.`
        : '';
    body = `${prompt}\nGive each item its own tight box. Output JSON only: [{${K}, "label": "<short name>", "note": "<what and where, max 20 words>"${F}}]${C}. Output [] if there is none.${PX}`;
  } else {
    // The built-in change fields are written out in the template; only the request's own follow.
    const F = i.fields
      .filter((f) => !CHANGE_KEYS.has(f.key))
      .map(fieldPart)
      .join('');
    const PX =
      cloud && last
        ? ` Box coordinates are integer pixels of each image (both are ${size} pixels as sent), x to the right, y down.`
        : '';
    const l1 = i.images[0]?.label ?? 'an earlier date';
    const l2 = i.images[1]?.label ?? 'a later date';
    body = `Image 1 was taken on ${l1} and Image 2 on ${l2}, from about the same spot. ${prompt}\nList every real change between them; ignore lighting, shadows, water glare and small camera shifts. For each change output one object: {${K}, "change_type": "new|removed|moved|progress|damage", "what": "<the object>", "note": "<what changed, max 20 words>"${F}}, where the box marks the change on Image 2${C}. Output a JSON list only, at most 10 items. Output [] if nothing changed.${PX}`;
  }
  return cloud ? `${ASK_MARKER}\n${body}` : body;
}

// ---- reading the reply ----

function tryList(s: string): unknown[] | null {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The JSON list in a model's answer: bare, fenced or amid text, `<think>` blocks dropped. Repairs
 * the doubled closing brace some local models write (`}}`) and cuts a list that stopped mid-item
 * back to its last whole item. A lone object becomes a one item list. Null when there is no list.
 */
export function readJsonList(
  text: string,
): { list: unknown[]; repaired: boolean; cut: boolean } | null {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fence = /```(?:json)?\s*([\s\S]*?)(```|$)/i.exec(t);
  let body = fence?.[1] ?? t;
  let a = body.indexOf('[');
  const o = body.indexOf('{');
  if (o >= 0 && (a < 0 || o < a)) {
    // A lone object (or objects without the list brackets).
    const end = body.lastIndexOf('}');
    if (end > o) {
      try {
        const v = JSON.parse(body.slice(o, end + 1)) as unknown;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          return { list: [v], repaired: false, cut: false };
        }
      } catch {
        // fall through to the list repairs
      }
    }
    if (a < 0) {
      body = `[${body.slice(o)}`;
      a = 0;
    }
  }
  if (a < 0) return null;
  const b = body.lastIndexOf(']');
  if (b > a) {
    const got = tryList(body.slice(a, b + 1));
    if (got) return { list: got, repaired: false, cut: false };
  }
  const s = body.slice(a);
  const fixes = [
    (x: string) => x.replace(/\}\s*\}(\s*[\],])/g, '}$1'),
    (x: string) =>
      x
        .trimEnd()
        .replace(/`+$/, '')
        .trimEnd()
        .replace(/\}\s*\}\s*$/, '}]'),
  ];
  for (const fix of fixes) {
    const cand = fix(s);
    const bb = cand.lastIndexOf(']');
    const got = bb > 0 ? tryList(cand.slice(0, bb + 1)) : null;
    if (got) return { list: got, repaired: true, cut: false };
  }
  // Cut off: back to the last whole object.
  let cut = s.lastIndexOf('}');
  while (cut > 0) {
    const got = tryList(`${s.slice(0, cut + 1)}]`);
    if (got) return { list: got, repaired: false, cut: true };
    cut = s.lastIndexOf('}', cut - 1);
  }
  return null;
}

const shortWords = (raw: unknown): string => {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
};

/** One read value as the field's type; a value that does not fit becomes null with a warning. */
export function coerceField(
  spec: FieldSpec,
  raw: unknown,
): { value: FieldValue; warning?: string } {
  const make = (value: number | string | null): FieldValue => ({
    key: spec.key,
    label: spec.label,
    type: spec.type,
    value,
    ...(spec.unit ? { unit: spec.unit } : {}),
  });
  if (raw === undefined || raw === null) return { value: make(null) };
  const bad = (what: string) => ({
    value: make(null),
    warning: `${spec.label}: the model answered "${shortWords(raw)}", which is not ${what}.`,
  });
  switch (spec.type) {
    case 'number': {
      if (typeof raw === 'number')
        return Number.isFinite(raw) ? { value: make(raw) } : bad('a number');
      if (typeof raw !== 'string') return bad('a number');
      const m = /-?\d+(?:[.,]\d+)?/.exec(raw);
      if (!m) return bad('a number');
      const n = Number(m[0].replace(',', '.'));
      return Number.isFinite(n) ? { value: make(n) } : bad('a number');
    }
    case 'yesno': {
      if (typeof raw === 'boolean') return { value: make(raw ? 'yes' : 'no') };
      if (typeof raw !== 'string') return { ...bad('yes, no or unknown'), value: make('unknown') };
      const w =
        raw
          .trim()
          .toLowerCase()
          .replace(/[^a-z]+/g, ' ')
          .trim()
          .split(' ')[0] ?? '';
      if (w === 'yes' || w === 'true') return { value: make('yes') };
      if (w === 'no' || w === 'false') return { value: make('no') };
      if (w === 'unknown') return { value: make('unknown') };
      return { ...bad('yes, no or unknown'), value: make('unknown') };
    }
    case 'choice': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return bad('one of the choices');
      const said = String(raw).trim().toLowerCase();
      const hit = (spec.choices ?? []).find((c) => c.toLowerCase() === said);
      return hit === undefined ? bad('one of the choices') : { value: make(hit) };
    }
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        return bad('text');
      }
      const s = String(raw).trim().slice(0, 200).trim();
      return { value: make(s === '' ? null : s) };
    }
  }
}

type Box = [number, number, number, number];
const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
/** Boxes sharing at least this share of the smaller one are the same item (the engine's rule). */
const MERGE_SHARE = 0.6;
/** A box covering at least this share of the image is the whole frame, not an item. */
const WHOLE_FRAME = 0.9;
/** Boxes narrower or lower than this many sent pixels are noise. */
const MIN_BOX_PX = 3;

/**
 * The guards on one image's items: tiny boxes out, whole-frame boxes out unless the request asks
 * for the whole image (before merging, so an "everything" box never swallows the real items),
 * overlapping boxes merged into the larger (largest first), then at most MAX_ASK_ITEMS kept in
 * the model's order.
 */
export function guardItems(
  items: AskItem[],
  o: { wholeImage?: boolean; sent: { width: number; height: number } },
): { items: AskItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const small = items.filter(
    (it) =>
      (it.box[2] - it.box[0]) * o.sent.width >= MIN_BOX_PX &&
      (it.box[3] - it.box[1]) * o.sent.height >= MIN_BOX_PX,
  );
  const tiny = items.length - small.length;
  if (tiny > 0) {
    warnings.push(
      tiny === 1
        ? 'One box was smaller than 3 pixels and was dropped.'
        : `${String(tiny)} boxes were smaller than 3 pixels and were dropped.`,
    );
  }
  const sized = o.wholeImage ? small : small.filter((it) => area(it.box) < WHOLE_FRAME);
  if (sized.length < small.length) {
    warnings.push('A box that covered the whole image was dropped.');
  }
  const order = sized
    .map((it, n) => ({ it, n }))
    .sort((a, b) => area(b.it.box) - area(a.it.box) || a.n - b.n);
  const kept: { it: AskItem; n: number }[] = [];
  for (const c of order) {
    const same = kept.some(
      (k) => overlap(k.it.box, c.it.box) >= MERGE_SHARE * Math.min(area(k.it.box), area(c.it.box)),
    );
    if (!same) kept.push(c);
  }
  const merged = sized.length - kept.length;
  if (merged > 0) {
    warnings.push(
      merged === 1
        ? 'One box overlapped a larger one and was merged into it.'
        : `${String(merged)} boxes overlapped larger ones and were merged into them.`,
    );
  }
  const out = kept.sort((a, b) => a.n - b.n).map((k) => k.it);
  if (out.length > MAX_ASK_ITEMS) {
    // N is what the model listed, before any guard.
    warnings.push(
      `The model listed ${String(items.length)} items; the first ${String(MAX_ASK_ITEMS)} are kept.`,
    );
    return { items: out.slice(0, MAX_ASK_ITEMS), warnings };
  }
  return { items: out, warnings };
}

const BOX_KEYS = ['bbox_2d', 'box_2d', 'bbox', 'box'] as const;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function readBox(
  d: Record<string, unknown>,
  family: AskFamily,
  sent: { width: number; height: number },
): Box | null {
  let raw: unknown;
  for (const k of BOX_KEYS) {
    if (d[k] !== undefined) {
      raw = d[k];
      break;
    }
  }
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const v = (raw as unknown[]).map((x): unknown => (typeof x === 'string' ? Number(x) : x));
  if (!v.every((x): x is number => typeof x === 'number' && Number.isFinite(x))) return null;
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = v;
  const sx = family === 'qwen3' ? 1000 : Math.max(1, sent.width);
  const sy = family === 'qwen3' ? 1000 : Math.max(1, sent.height);
  const nx = [x1 / sx, x2 / sx].map(clamp01).sort((a, b) => a - b);
  const ny = [y1 / sy, y2 / sy].map(clamp01).sort((a, b) => a - b);
  return [round6(nx[0] ?? 0), round6(ny[0] ?? 0), round6(nx[1] ?? 0), round6(ny[1] ?? 0)];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Read a `find` or `change` answer into items, boxes normalised 0 to 1 of the last image sent.
 * An answer that holds no JSON list is an error carrying the model's words; single items that
 * cannot be read are skipped with a warning. For `change` the built-in fields are read first.
 * An `ask` answer is plain text and has no items.
 */
export function parseAskReply(
  text: string,
  i: {
    family: AskFamily;
    kind: AskKind;
    sent: { width: number; height: number };
    fields: readonly FieldSpec[];
    wholeImage?: boolean;
  },
): { items: AskItem[]; warnings: string[] } | { error: string } {
  if (i.kind === 'ask') return { items: [], warnings: [] };
  const read = readJsonList(text);
  if (!read) {
    const head = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return {
      error: `The model did not answer in the format asked for${head ? `: "${head}"` : '.'}`,
    };
  }
  const fields =
    i.kind === 'change'
      ? [...CHANGE_FIELDS, ...i.fields.filter((f) => !CHANGE_KEYS.has(f.key))]
      : [...i.fields];
  const warnings: string[] = [];
  if (read.repaired) warnings.push('The answer had a broken bracket, which was repaired.');
  if (read.cut) {
    warnings.push(
      `The answer stopped part way; the ${String(read.list.length)} items before the cut are kept.`,
    );
  }
  const items: AskItem[] = [];
  let unreadable = 0;
  for (const d of read.list) {
    if (!isRecord(d)) {
      unreadable += 1;
      continue;
    }
    let box = readBox(d, i.family, i.sent);
    if (!box && i.wholeImage) box = [0, 0, 1, 1];
    if (!box) {
      unreadable += 1;
      continue;
    }
    const values: FieldValue[] = [];
    for (const f of fields) {
      const r = coerceField(f, d[f.key]);
      values.push(r.value);
      if (r.warning) warnings.push(r.warning);
    }
    const label = (str(d.label) || str(d.what) || 'item').slice(0, 80);
    items.push({ box, label, note: str(d.note).slice(0, 500), fields: values });
  }
  if (unreadable > 0) {
    warnings.push(
      unreadable === 1
        ? 'One item had no usable box and was skipped.'
        : `${String(unreadable)} items had no usable box and were skipped.`,
    );
  }
  // Zero-size boxes (after clamping) never reach the guards' maths as items with x1 = x0.
  const guarded = guardItems(items, {
    sent: i.sent,
    ...(i.wholeImage !== undefined ? { wholeImage: i.wholeImage } : {}),
  });
  return { items: guarded.items, warnings: [...warnings, ...guarded.warnings] };
}

// ---- routing ----

export type AskRoute =
  { kind: 'local' } | { kind: 'cloud'; provider: 'anthropic' | 'openai'; model: string };

/** The cloud models offered for custom requests (Google is not offered). */
export const ASK_MODELS: readonly {
  provider: 'anthropic' | 'openai';
  model: string;
  best?: true;
}[] = [
  { provider: 'anthropic', model: 'claude-haiku-5-5' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { provider: 'anthropic', model: 'claude-opus-5-5', best: true },
  { provider: 'openai', model: 'gpt-6.1-sol' },
  { provider: 'openai', model: 'gpt-6-luna' },
];

const TIER_MODELS = {
  strong: { anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.1-sol' },
  bulk: { anthropic: 'claude-haiku-5-5', openai: 'gpt-6-luna' },
} as const;

/**
 * Where a request runs. Automatic: with the cloud usable, change and ask go to the strong model,
 * a find over all photos to the bulk model, a find on a photo or a selection to this PC when it
 * is ready, else the bulk model; Anthropic first, OpenAI when it is the only key. With the cloud
 * not usable everything runs on this PC, and change and ask are weaker there (`weakOffline`).
 */
export function routeAsk(i: {
  kind: AskKind;
  scope: AskScope;
  choice: AskModelChoice;
  cloud: { usable: boolean; providers: readonly ('anthropic' | 'openai')[] };
  local: { ready: boolean };
}): { route: AskRoute; weakOffline: boolean } | { none: 'nothing' | 'cloud' | 'local' } {
  const weak = i.kind !== 'find';
  const local = { route: { kind: 'local' } as const, weakOffline: weak };
  if (i.choice === 'local') return i.local.ready ? local : { none: 'local' };
  if (i.choice !== 'auto') {
    const { provider, model } = i.choice;
    return i.cloud.usable && i.cloud.providers.includes(provider)
      ? { route: { kind: 'cloud', provider, model }, weakOffline: false }
      : { none: 'cloud' };
  }
  const provider = i.cloud.providers.includes('anthropic')
    ? 'anthropic'
    : i.cloud.providers.includes('openai')
      ? 'openai'
      : null;
  if (!i.cloud.usable || provider === null) return i.local.ready ? local : { none: 'nothing' };
  if (i.kind === 'find' && i.scope !== 'all' && i.local.ready) return local;
  const tier = i.kind === 'find' ? 'bulk' : 'strong';
  return {
    route: { kind: 'cloud', provider, model: TIER_MODELS[tier][provider] },
    weakOffline: false,
  };
}

/** Provider options of a custom request: low effort, medium for Opus on a change request. */
export function askProviderOptions(
  provider: string,
  model: string,
  kind: AskKind,
): Record<string, Record<string, string>> {
  if (provider === 'anthropic') {
    const effort = kind === 'change' && model.includes('opus') ? 'medium' : 'low';
    return { anthropic: { effort } };
  }
  if (provider === 'openai') return { openai: { reasoningEffort: 'low' } };
  return {};
}

const MAX_TOKENS = {
  cloud: { find: 8000, change: 12000, ask: 6000 },
  local: { find: 2048, change: 2048, ask: 700 },
} as const;

/** Answer length cap per request. */
export function askMaxTokens(kind: AskKind, where: 'cloud' | 'local'): number {
  return MAX_TOKENS[where][kind];
}

/** Expected answer length per request. */
const OUTPUT_PER_REQUEST = { find: 600, change: 800, ask: 500 } as const;
const textTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Cost estimate shown before anything is sent: `images` are every image the run sends, at their
 * sent sizes; the prompt and the answer count once per request. Zero on this PC.
 */
export function estimateAsk(o: {
  provider: string;
  model: string;
  kind: AskKind;
  images: readonly { width: number; height: number }[];
  prompt: string;
  fields: readonly FieldSpec[];
  requests: number;
}): DetectEstimate {
  const requests = Math.max(0, Math.floor(o.requests));
  const perRequest = o.kind === 'change' ? o.images.slice(0, 2) : o.images.slice(0, 1);
  const text = textTokens(
    askPrompt({
      family: o.provider === 'local' ? 'qwen3' : 'cloud',
      kind: o.kind,
      prompt: o.prompt,
      fields: o.fields,
      images: perRequest,
    }),
  );
  let inputTokens = text * requests;
  for (const im of o.images) inputTokens += imageTokens(o.provider, im.width, im.height);
  const outputTokens = OUTPUT_PER_REQUEST[o.kind] * requests;
  const costUsd =
    o.provider === 'local' ? 0 : estimateCostUsd(o.model, { inputTokens, outputTokens });
  return { requests, inputTokens, outputTokens, costUsd };
}
