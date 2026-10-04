/**
 * AI-assisted detection (BLD-6), the parts both processes share: the prompt (so the send preview
 * shows exactly what main sends), batching, the cost estimate and the reply parser. No provider
 * SDKs here: the renderer imports it. Main runs the requests in `main.ts` (`detect`).
 *
 * Results are proposals only. They land as draft detections for the review (BLD-5), carrying the
 * model, the prompt version and the model's confidence; nothing counts until a person accepts it.
 */
import { z } from 'zod';
import { estimateCostUsd } from './pricing';

/** Bump when the prompt or the reply format changes; stored with every detection. */
export const DETECT_PROMPT_VERSION = 'detect-v1';
/** Marks a detection request (the scripted test model answers it with detections). */
export const DETECT_MARKER = '<aio-detect>';
/** Images per request. Several images share one prompt; more than a few dilutes attention. */
export const DEFAULT_BATCH = 4;
export const MAX_BATCH = 8;
/** Longest side of an image as sent: the size the vision models work at without resizing. */
export const SEND_MAX_PX = 1568;

export interface DetectClass {
  id: string;
  label: string;
}

export interface DetectSeverity {
  levels: { value: number; label: string; criteria?: string | undefined }[];
  /** The model has an "uncertain, not graded" level. */
  uncertain?: boolean | undefined;
}

export interface DetectPromptInput {
  classes: readonly DetectClass[];
  severity?: DetectSeverity | undefined;
  /** What to look for, from the person (optional). */
  hint?: string | undefined;
}

/** The instructions (system prompt) of a detection request. Stable per project, so it caches. */
export function detectInstructions(input: DetectPromptInput): string {
  const classes = input.classes.map((c) => ({ id: c.id, label: c.label }));
  const lines = [
    'You find visible defects in drone inspection photos of industrial assets for an inspection engineer.',
    'Every finding is a proposal that a person reviews; do not guess. Leave out anything you are not able to see clearly, and mark doubtful findings uncertain.',
    '',
    `Classes (JSON, use the id): ${JSON.stringify(classes)}`,
  ];
  if (input.severity && input.severity.levels.length > 0) {
    const levels = input.severity.levels.map((l) => ({
      value: l.value,
      label: l.label,
      ...(l.criteria ? { criteria: l.criteria } : {}),
    }));
    lines.push(`Severity levels (JSON, use the value): ${JSON.stringify(levels)}`);
    if (input.severity.uncertain) {
      lines.push('When the severity cannot be judged from the photo, set "uncertain": true.');
    }
  }
  lines.push(
    '',
    'Answer with one JSON object and nothing else, in this form:',
    '{"images":[{"image":1,"detections":[{"class":"<class id>","box":[x,y,w,h],"confidence":0.0,"severity":1,"uncertain":false,"note":"<short note>"}]}]}',
    'Coordinates are fractions of the image width and height (0 to 1) from the top-left corner. "box" is the tight box around the defect. Optionally add "polygon": [[x,y],...] with the outline. "confidence" is 0 to 1. List every image, with an empty "detections" list when there is nothing to report.',
  );
  return lines.join('\n');
}

/** The text that goes with the images of one request. */
export function detectUserText(count: number, hint?: string): string {
  const focus = hint?.trim() ? `\nFocus: ${hint.trim()}` : '';
  return `${DETECT_MARKER}\nThere are ${String(count)} images, numbered 1 to ${String(count)} in the order attached. Report the defects in each.${focus}`;
}

/** Split work into batches of at most `size` (1 to MAX_BATCH). */
export function planBatches<T>(items: readonly T[], size = DEFAULT_BATCH): T[][] {
  const n = Math.min(MAX_BATCH, Math.max(1, Math.floor(size)));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Pixel size an image is scaled to before it is sent (never enlarged). */
export function sendSize(width: number, height: number, maxPx = SEND_MAX_PX): [number, number] {
  const s = Math.min(1, maxPx / Math.max(width, height, 1));
  return [Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s))];
}

/**
 * Input tokens of one image as each provider counts them (published rules, approximate):
 * Anthropic about w h / 750; OpenAI high detail 85 plus 170 per 512 px tile after fitting 2048
 * and 768; Gemini 258 per 768 px tile (258 for a small image). A local model is free.
 */
export function imageTokens(provider: string, width: number, height: number): number {
  const [w, h] = sendSize(width, height);
  if (provider === 'openai') {
    const s1 = Math.min(1, 2048 / Math.max(w, h));
    const s2 = Math.min(1, 768 / Math.min(w * s1, h * s1));
    const tw = Math.ceil((w * s1 * s2) / 512);
    const th = Math.ceil((h * s1 * s2) / 512);
    return 85 + 170 * tw * th;
  }
  if (provider === 'google') {
    if (w <= 384 && h <= 384) return 258;
    return 258 * Math.ceil(w / 768) * Math.ceil(h / 768);
  }
  return Math.ceil((w * h) / 750);
}

/** Expected answer length: a short JSON list per image. */
const OUTPUT_PER_IMAGE = 160;
const OUTPUT_PER_BATCH = 40;
const textTokens = (s: string) => Math.ceil(s.length / 4);

export interface DetectEstimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** USD; undefined when the model is not in the price table. Zero for a local model. */
  costUsd: number | undefined;
}

/** Cost estimate shown before anything is sent (the provider's invoice is authoritative). */
export function estimateDetect(o: {
  /** Route provider id (`anthropic`, `openai`, `google`, `local`). */
  provider: string;
  model: string;
  images: readonly { width: number; height: number }[];
  prompt: DetectPromptInput;
  batchSize?: number;
}): DetectEstimate {
  const batches = planBatches(o.images, o.batchSize);
  const instructions = textTokens(detectInstructions(o.prompt));
  let inputTokens = 0;
  let outputTokens = 0;
  for (const b of batches) {
    inputTokens += instructions + textTokens(detectUserText(b.length, o.prompt.hint));
    for (const im of b) inputTokens += imageTokens(o.provider, im.width, im.height);
    outputTokens += OUTPUT_PER_BATCH + OUTPUT_PER_IMAGE * b.length;
  }
  const costUsd =
    o.provider === 'local' ? 0 : estimateCostUsd(o.model, { inputTokens, outputTokens });
  return { requests: batches.length, inputTokens, outputTokens, costUsd };
}

// ---- the reply ----

/** One proposal as the model gave it, coordinates normalised (0 to 1). */
export interface AiDetection {
  /** Class id when the model used one of ours; else empty and `label` holds its word. */
  classId: string;
  label: string;
  box?: [number, number, number, number] | undefined;
  polygon?: [number, number][] | undefined;
  confidence?: number | undefined;
  severity?: number | null | undefined;
  uncertain?: boolean | undefined;
  note?: string | undefined;
}

const Num = z.number();
const ReplyDetection = z.object({
  class: z.union([z.string(), z.number()]).transform(String),
  box: z.array(Num).length(4).optional(),
  polygon: z.array(z.array(Num).min(2)).min(3).optional(),
  confidence: Num.optional(),
  severity: z.union([Num, z.null()]).optional(),
  uncertain: z.boolean().optional(),
  note: z.string().optional(),
});
const Reply = z.object({
  images: z.array(
    z.object({
      image: z.union([z.number().int(), z.string()]).transform(Number),
      detections: z.array(z.unknown()).default([]),
    }),
  ),
});

/** The JSON object in a model's answer (bare, or in a ```json fence, or amid text). */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fence?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

export interface ParsedReply {
  /** Per image, in the order sent. */
  results: AiDetection[][];
  /** Proposals or images that could not be read, as short sentences for the log and the person. */
  warnings: string[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Read a detection answer for `count` images. An answer that is not the JSON asked for is an
 * error (string); single malformed proposals are skipped with a warning.
 */
export function parseDetectReply(
  text: string,
  count: number,
  classes: readonly DetectClass[],
): ParsedReply | string {
  const raw = extractJson(text);
  const parsed = Reply.safeParse(raw);
  if (!parsed.success) {
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    return `The model did not answer in the detection format${head ? `: "${head}"` : '.'}`;
  }
  const byId = new Map(classes.map((c) => [c.id.toLowerCase(), c.id]));
  const byLabel = new Map(classes.map((c) => [c.label.toLowerCase(), c.id]));
  const results: AiDetection[][] = Array.from({ length: count }, () => []);
  const warnings: string[] = [];
  for (const img of parsed.data.images) {
    const slot = results[img.image - 1];
    if (!slot) {
      warnings.push(`The model answered for image ${String(img.image)}, which was not sent.`);
      continue;
    }
    for (const d of img.detections) {
      const r = ReplyDetection.safeParse(d);
      if (!r.success || (!r.data.box && !r.data.polygon)) {
        warnings.push(
          `Image ${String(img.image)}: one proposal had no usable box and was skipped.`,
        );
        continue;
      }
      const word = r.data.class.trim();
      const key = word.toLowerCase();
      const classId = byId.get(key) ?? byLabel.get(key) ?? '';
      const out: AiDetection = { classId, label: word };
      if (r.data.box) {
        const [x = 0, y = 0, w = 0, h = 0] = r.data.box;
        out.box = [clamp01(x), clamp01(y), clamp01(w), clamp01(h)];
      }
      if (r.data.polygon) {
        out.polygon = r.data.polygon.map((p): [number, number] => [
          clamp01(p[0] ?? 0),
          clamp01(p[1] ?? 0),
        ]);
      }
      if (r.data.confidence !== undefined) out.confidence = clamp01(r.data.confidence);
      if (r.data.severity !== undefined) {
        out.severity = r.data.severity === null ? null : Math.round(r.data.severity);
      }
      if (r.data.uncertain !== undefined) out.uncertain = r.data.uncertain;
      if (r.data.note?.trim()) out.note = r.data.note.trim().slice(0, 500);
      slot.push(out);
    }
  }
  return { results, warnings };
}
