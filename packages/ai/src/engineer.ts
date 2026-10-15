/**
 * The engineer step (engineering model plan, Task 31): one structured, cached and budgeted model
 * call that turns the evidence pack's images and measurement summary into an `EngineerProposal`.
 * Main process only (node:crypto, node:fs, the provider SDKs through the registry).
 *
 * Gate order: offline-only, model capability, project policy, sharing flags, key, cache, budget,
 * then the call. Every refusal before the call sends nothing; the offline refusal also reads no
 * key. What leaves the machine: the setup choices (family, scope, detail, reference), the summary
 * with local paths redacted, and the images with their metadata stripped and downscaled to the
 * model's limit. Never the setup's sources (photo paths), EXIF, or anything else.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineerProposal, type EngineerSetup } from '@aio/schema';
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  type LanguageModelUsage,
  type ModelMessage,
  type UserContent,
} from 'ai';
import { z } from 'zod';
import { capsFor, engineerReady, type LocalCaps, type ModelCaps } from './capabilities';
import {
  engineerRepairText,
  engineerSystem,
  engineerUserText,
  imageLabel,
  PROMPT_VERSION,
  type EngineerSetupView,
} from './engineerPrompt';
import {
  BudgetReachedError,
  describeError,
  InvalidProposalError,
  isNetworkError,
  OFFLINE_ONLY_MESSAGE,
  OfflineOnlyError,
} from './errors';
import { estimateCostUsd as priceUsd } from './pricing';
import type { ProviderRegistry } from './providers';
import { missingKeyMessage, PROVIDER_LABELS, type ModelRoute } from './routes';

/** AI wall time of one engineer call (the plan's 10 minutes per run is enforced by the caller). */
export const ENGINEER_TIMEOUT_MS = 600_000;
/** Output tokens a reply may use, and the output part of the cost estimate. */
export const ENGINEER_MAX_OUTPUT_TOKENS = 8_000;
const ESTIMATE_OUTPUT_TOKENS = 4_000;
/** Version of the reply format (the wire schema below and its mapping to `EngineerProposal`). */
const PROPOSAL_FORMAT = 'proposal-1';

export type EngineerImageKind = 'photo' | 'side' | 'top' | 'slice' | 'crop' | 'generated';

export interface EngineerImage {
  /** Pack image id, e.g. `p3` or `side-090`: letters, digits, `.`, `_`, `-` (never a path). */
  id: string;
  kind: EngineerImageKind;
  /** `data:image/png|jpeg|webp;base64,...` */
  dataUrl: string;
  bytes: number;
  /** Short view label for the prompt, e.g. `east` or `slice at 0.4 H`. */
  view?: string;
}

export interface EngineerCall {
  projectId: string;
  runId: string;
  pass: number;
  images: EngineerImage[];
  /** The evidence pack's measurement summary (JSON text). Treated as data, paths redacted. */
  summary: string;
  setup: EngineerSetup;
  previous?: EngineerProposal;
  /**
   * The person confirmed the cost in the preview although the model has no price (the estimate is
   * unknown). Without it a model without a price is refused with `budget`.
   */
  costConfirmed?: boolean;
}

/** One model request's tokens and estimated cost, for the per-project meter. */
export interface EngineerUsage {
  projectId: string;
  runId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Absent when the model has no price. */
  costUsd?: number;
}

export interface EngineerHost {
  route(): ModelRoute;
  /** API key from the OS vault. Read only after every gate before it passed. */
  key(provider: string): Promise<string | null>;
  offlineOnly(): boolean;
  /** The project's AI policy and its sharing flags (`aiCloudPhotos`, `aiCloudScans`), re-read. */
  policy(): { ai: 'allow' | 'forbid'; photos: boolean; scans: boolean };
  cache: {
    get(key: string): Promise<EngineerProposal | null>;
    put(key: string, p: EngineerProposal): Promise<void>;
  };
  /** US dollars this run has spent on AI so far. */
  spent(runId: string): number;
  usage(u: EngineerUsage): void;
  /** The run's AI cost cap (`DETAIL_BUDGETS[detail].costUsd`). */
  budgetUsd: number;
  /** Aborted by `ai:cancel`. */
  signal: AbortSignal;
  providers: ProviderRegistry;
  /** What the local model probe found, when the route runs on the local model. */
  localCaps?(): LocalCaps | undefined;
  /** Downscale an image so its longest side is at most `maxPx` (Electron `nativeImage` in main). */
  resize?(dataUrl: string, maxPx: number): Promise<string>;
  /** Provider retries per request; 2 by default. */
  maxRetries?: number;
}

export type EngineerOutcome =
  | {
      kind: 'proposal';
      proposal: EngineerProposal;
      cached: boolean;
      costUsd: number;
      /**
       * The images show more than one structure: the caller stops before generate and lets the
       * person drop the flagged images. Such a proposal is never cached.
       */
      identityConflict?: true;
      /** The cost cap stopped this pass: `proposal` is the previous pass's, with a note. */
      stopped?: 'budget';
    }
  | {
      kind: 'refused';
      reason: string;
      code: 'offline' | 'policy' | 'no-key' | 'capability' | 'budget' | 'identity';
    }
  | {
      kind: 'failed';
      error: string;
      code: 'invalid' | 'rate-limit' | 'network' | 'provider' | 'cancelled';
    };

// ---------------------------------------------------------------- reply format

/**
 * What the model fills in: every field present (strict structured output modes need that), params
 * as name and value pairs (no free-form records), no bounds (they differ between providers'
 * schema dialects). `EngineerProposal` validates the result afterwards.
 */
const WireProposal = z.object({
  family: z.object({ value: z.string(), reasons: z.array(z.string()) }),
  identity: z.object({
    sameAsset: z.boolean(),
    conflicts: z.array(z.object({ imageIds: z.array(z.string()), reason: z.string() })),
  }),
  components: z.array(
    z.object({
      role: z.string(),
      kind: z.string(),
      count: z.number(),
      units: z.enum(['ratio', 'm']),
      params: z.array(
        z.object({ name: z.string(), value: z.union([z.number(), z.string(), z.boolean()]) }),
      ),
      levels: z.array(z.number()),
      imageIds: z.array(z.string()),
      observed: z.boolean(),
      description: z.string(),
    }),
  ),
  unresolved: z.array(z.string()),
  notes: z.string(),
});
type WireProposal = z.infer<typeof WireProposal>;

/** The wire reply as a proposal candidate (not yet validated). */
function fromWire(w: WireProposal): unknown {
  return {
    family: w.family,
    identity: w.identity,
    components: w.components.map((c) => ({
      role: c.role,
      kind: c.kind,
      count: c.count,
      units: c.units,
      params: Object.fromEntries(c.params.map((p) => [p.name, p.value])),
      ...(c.levels.length > 0 ? { levels: c.levels } : {}),
      imageIds: c.imageIds,
      observed: c.observed,
      ...(c.description.trim() ? { description: c.description } : {}),
    })),
    unresolved: w.unresolved,
    notes: w.notes,
  };
}

/** zod issues as one line: `components.1.kind: ...; family.value: ...`. */
function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

// ---------------------------------------------------------------- images

type Mime = 'image/png' | 'image/jpeg' | 'image/webp';

function decodeDataUrl(url: string): { mediaType: Mime; bytes: Buffer } | null {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!m?.[1] || !m[2]) return null;
  return { mediaType: m[1] as Mime, bytes: Buffer.from(m[2], 'base64') };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG, JPEG or WebP header; null when unreadable. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIG)) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      const len = b.readUInt16BE(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (sof) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      if (marker === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }
  if (
    b.length >= 30 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** PNG chunks that carry text, EXIF or times: never sent. */
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/**
 * The image without metadata: JPEG APP1 to APP15 (EXIF, XMP, IPTC) and comments, PNG text, EXIF
 * and time chunks, WebP EXIF and XMP chunks. The pixels are untouched. Throws on a broken file.
 */
export function stripImageMetadata(b: Buffer, mediaType: Mime): Buffer {
  if (mediaType === 'image/png') {
    if (!b.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
    const parts: Buffer[] = [PNG_SIG];
    let i = 8;
    while (i + 12 <= b.length) {
      const len = b.readUInt32BE(i);
      const type = b.toString('latin1', i + 4, i + 8);
      const end = i + 12 + len;
      if (end > b.length) throw new Error('broken PNG');
      if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
      i = end;
      if (type === 'IEND') break;
    }
    return Buffer.concat(parts);
  }
  if (mediaType === 'image/jpeg') {
    if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
    const parts: Buffer[] = [b.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) throw new Error('broken JPEG');
      const marker = b[i + 1] ?? 0;
      if (marker === 0xda) {
        parts.push(b.subarray(i));
        return Buffer.concat(parts);
      }
      const end = i + 2 + b.readUInt16BE(i + 2);
      if (end > b.length) throw new Error('broken JPEG');
      const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
      if (!drop) parts.push(b.subarray(i, end));
      i = end;
    }
    throw new Error('broken JPEG');
  }
  // WebP: RIFF chunks; drop EXIF and XMP, clear their flags in VP8X, fix the RIFF size.
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP');
  }
  const parts: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > b.length) throw new Error('broken WebP');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      if (type === 'VP8X') chunk[8] = (chunk[8] ?? 0) & ~0x0c;
      parts.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

const IMAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const VIEW = /^[A-Za-z0-9 .,%°-]{0,40}$/;

/** Kinds made from the scan (renders, slices, generated views): need `aiCloudScans`. */
const SCAN_KINDS: ReadonlySet<EngineerImageKind> = new Set(['side', 'top', 'slice', 'generated']);

/** Windows drive and UNC paths, and absolute POSIX paths under the usual roots. */
const PATHS = [
  /\b[A-Za-z]:[\\/][^\s"',;)]*/g,
  /\\\\[^\s"',;)]+/g,
  /(?<![\w.])\/(?:home|Users|mnt|media|Volumes|var|tmp|data|srv|opt|root)\/[^\s"',;)]*/g,
  /\bfile:\/\/[^\s"',;)]*/g,
];

/** The summary with anything that looks like a local path replaced by `[path]`. */
export function redactPaths(text: string): string {
  return PATHS.reduce((t, re) => t.replace(re, '[path]'), text);
}

/** The setup choices the model may see; the sources (layer ids, photo paths) stay here. */
function setupView(s: EngineerSetup): EngineerSetupView {
  return {
    family: s.family,
    scope: s.scope,
    detail: s.detail,
    ...(s.reference
      ? {
          reference: {
            what: s.reference.what,
            valueM: s.reference.valueM,
            ...(s.reference.label ? { label: redactPaths(s.reference.label) } : {}),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------- cache key and estimate

const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');

/**
 * The cache key: sha256 over the image ids, kinds, views and content sha1s, the summary, the
 * setup, the pass, the previous proposal, the prompt version, the reply format, provider and model.
 * Run and project ids are left out, so a resumed or repeated run reuses the reply.
 */
export function engineerCacheKey(c: EngineerCall, route: ModelRoute): string {
  const images = c.images.map((im) => ({
    id: im.id,
    kind: im.kind,
    view: im.view ?? '',
    sha1: sha1(decodeDataUrl(im.dataUrl)?.bytes ?? im.dataUrl),
  }));
  const material = JSON.stringify({
    promptVersion: PROMPT_VERSION,
    format: PROPOSAL_FORMAT,
    provider: route.provider,
    model: route.model,
    pass: c.pass,
    summary: c.summary,
    setup: c.setup,
    previous: c.previous ?? null,
    images,
  });
  return createHash('sha256').update(material).digest('hex');
}

/** Limits to estimate and send with: the model's, else conservative ones. */
function limitsFor(route: ModelRoute, local?: LocalCaps): ModelCaps {
  return (
    capsFor(route.provider, route.model, {
      treatAsVision: true,
      ...(local ? { local } : {}),
    }) ?? { vision: true, structured: true, maxImages: 8, maxImagePx: 1024 }
  );
}

/** Image tokens: (w * h) / 750 after fitting the longest side into `maxPx`. */
function imageTokens(dims: { w: number; h: number } | null, maxPx: number): number {
  const { w, h } = dims ?? { w: maxPx, h: maxPx };
  const s = Math.min(1, maxPx / Math.max(w, h, 1));
  return Math.ceil((w * s * (h * s)) / 750);
}

/**
 * The estimated cost of one engineer request in US dollars: images at (w * h) / 750 tokens each
 * (capped by the model's image size), the summary and the system text at four characters a token,
 * and 4000 output tokens, priced with the meter's table. 0 on the local model; undefined when the
 * model has no price.
 */
export function estimateEngineerCostUsd(
  c: EngineerCall,
  route: ModelRoute,
  local?: LocalCaps,
): number | undefined {
  if (route.provider === 'local') return 0;
  const caps = limitsFor(route, local);
  const images = c.images.slice(0, caps.maxImages);
  const inputTokens =
    images.reduce((n, im) => {
      const d = decodeDataUrl(im.dataUrl);
      return n + imageTokens(d ? imageSize(d.bytes) : null, caps.maxImagePx);
    }, 0) +
    Math.ceil((c.summary.length + engineerSystem().length) / 4) +
    (c.previous ? Math.ceil(JSON.stringify(c.previous).length / 4) : 0);
  return priceUsd(route.model, { inputTokens, outputTokens: ESTIMATE_OUTPUT_TOKENS });
}

// ---------------------------------------------------------------- the call

interface Prepared {
  content: UserContent;
  leftOut: number;
}

/** The user content: setup and summary text, then each image after its label. */
async function prepare(
  c: EngineerCall,
  caps: ModelCaps,
  host: EngineerHost,
): Promise<Prepared | { refused: string }> {
  const images = c.images.slice(0, caps.maxImages);
  const content: UserContent = [
    {
      type: 'text',
      text: engineerUserText({
        summary: redactPaths(c.summary),
        setup: setupView(c.setup),
        pass: c.pass,
        imageCount: images.length,
        ...(c.previous ? { previous: c.previous } : {}),
      }),
    },
  ];
  for (const im of images) {
    let decoded = decodeDataUrl(im.dataUrl);
    if (!decoded) return { refused: `Image ${im.id} is not a PNG, JPEG or WebP image.` };
    const dims = imageSize(decoded.bytes);
    if (!dims) return { refused: `Image ${im.id} could not be read.` };
    if (Math.max(dims.w, dims.h) > caps.maxImagePx) {
      if (!host.resize) {
        return {
          refused: `Image ${im.id} is larger than this model accepts (${String(caps.maxImagePx)} px) and cannot be made smaller here.`,
        };
      }
      decoded = decodeDataUrl(await host.resize(im.dataUrl, caps.maxImagePx));
      const after = decoded ? imageSize(decoded.bytes) : null;
      if (!decoded || !after || Math.max(after.w, after.h) > caps.maxImagePx) {
        return { refused: `Image ${im.id} could not be made smaller for this model.` };
      }
    }
    let clean: Buffer;
    try {
      clean = stripImageMetadata(decoded.bytes, decoded.mediaType);
    } catch {
      return { refused: `Image ${im.id} could not be read.` };
    }
    content.push({ type: 'text', text: imageLabel(im.id, im.kind, im.view) });
    content.push({ type: 'file', data: clean.toString('base64'), mediaType: decoded.mediaType });
  }
  return { content, leftOut: c.images.length - images.length };
}

function costOf(
  route: ModelRoute,
  u: LanguageModelUsage | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | undefined;
} {
  const inputTokens = u?.inputTokens ?? 0;
  const outputTokens = u?.outputTokens ?? 0;
  if (route.provider === 'local') return { inputTokens, outputTokens, costUsd: 0 };
  return {
    inputTokens,
    outputTokens,
    costUsd: priceUsd(route.model, {
      inputTokens,
      outputTokens,
      cacheReadTokens: u?.inputTokenDetails.cacheReadTokens ?? 0,
      cacheWriteTokens: u?.inputTokenDetails.cacheWriteTokens ?? 0,
    }),
  };
}

const unwrap = (e: unknown) => (RetryError.isInstance(e) ? e.lastError : e);

function withNote(p: EngineerProposal, note: string): EngineerProposal {
  const unresolved = [...p.unresolved, note.slice(0, 200)].slice(-40);
  return { ...p, unresolved };
}

/** One engineer request: gates, cache, budget, the structured call with one repair. */
export async function runEngineer(c: EngineerCall, host: EngineerHost): Promise<EngineerOutcome> {
  const route = host.route();
  const provider = host.providers.get(route.provider);
  const cloud = provider ? provider.cloud : route.provider !== 'local';
  const label = provider?.label ?? PROVIDER_LABELS[route.provider];
  if (cloud && host.offlineOnly()) {
    return { kind: 'refused', code: 'offline', reason: OFFLINE_ONLY_MESSAGE };
  }
  const local = route.provider === 'local' ? host.localCaps?.() : undefined;
  const ready = engineerReady(route, local);
  if (!ready.ok) return { kind: 'refused', code: 'capability', reason: ready.reason };
  if (!provider) {
    return {
      kind: 'refused',
      code: 'capability',
      reason: `${label} is not available. Choose another model in Settings, AI providers.`,
    };
  }
  const bad = c.images.find((im) => !IMAGE_ID.test(im.id) || !VIEW.test(im.view ?? ''));
  if (bad) {
    return {
      kind: 'refused',
      code: 'capability',
      reason: 'An image id or view label is not valid.',
    };
  }
  if (cloud) {
    const policy = host.policy();
    if (policy.ai === 'forbid') {
      return {
        kind: 'refused',
        code: 'policy',
        reason:
          'This project does not allow sending its data to cloud AI. A local model set up in Settings, AI providers, can still be used.',
      };
    }
    const photos = c.images.some((im) => !SCAN_KINDS.has(im.kind));
    const scans = c.images.some((im) => SCAN_KINDS.has(im.kind));
    if (photos && !policy.photos) {
      return {
        kind: 'refused',
        code: 'policy',
        reason:
          'This project does not allow sending photos to cloud AI. Allow photos in the preview, or leave them out.',
      };
    }
    if (scans && !policy.scans) {
      return {
        kind: 'refused',
        code: 'policy',
        reason:
          'This project does not allow sending scan views to cloud AI. Allow scan views in the preview, or leave them out.',
      };
    }
  }
  const key = provider.needsKey || provider.optionalKey ? await host.key(route.provider) : null;
  if (provider.needsKey && !key) {
    return { kind: 'refused', code: 'no-key', reason: missingKeyMessage(label) };
  }

  const cacheKey = engineerCacheKey(c, route);
  const hit = await host.cache.get(cacheKey).catch(() => null);
  const cached = hit ? EngineerProposal.safeParse(hit) : null;
  if (cached?.success) {
    return { kind: 'proposal', proposal: cached.data, cached: true, costUsd: 0 };
  }

  const capUsd = host.budgetUsd;
  let spent = host.spent(c.runId);
  const estimate = estimateEngineerCostUsd(c, route, local);
  const over = estimate === undefined ? !c.costConfirmed : spent + estimate > capUsd;
  if (over) {
    const err = new BudgetReachedError({ capUsd, spentUsd: spent, estimateUsd: estimate });
    if (c.previous && estimate !== undefined) {
      return {
        kind: 'proposal',
        proposal: withNote(
          c.previous,
          `Pass ${String(c.pass)} was not run: it would pass the AI cost cap of US$${capUsd.toFixed(2)}.`,
        ),
        cached: false,
        costUsd: 0,
        stopped: 'budget',
      };
    }
    return { kind: 'refused', code: 'budget', reason: err.message };
  }

  const prepared = await prepare(c, ready.caps, host);
  if ('refused' in prepared) {
    return { kind: 'refused', code: 'capability', reason: prepared.refused };
  }

  const timeout = AbortSignal.timeout(ENGINEER_TIMEOUT_MS);
  const signal = AbortSignal.any([host.signal, timeout]);
  const model = provider.languageModel(route.model, key);
  const instructions = engineerSystem();
  let costUsd = 0;
  const meter = (u: LanguageModelUsage | undefined) => {
    const cost = costOf(route, u);
    if (cost.costUsd !== undefined) {
      costUsd += cost.costUsd;
      spent += cost.costUsd;
    }
    host.usage({
      projectId: c.projectId,
      runId: c.runId,
      provider: route.provider,
      model: route.model,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      ...(cost.costUsd !== undefined ? { costUsd: cost.costUsd } : {}),
    });
  };

  /** One request: the proposal, or what was wrong with the reply. */
  const ask = async (
    messages: ModelMessage[],
  ): Promise<
    { ok: true; proposal: EngineerProposal } | { ok: false; raw: string; issues: string }
  > => {
    try {
      const r = await generateText({
        model,
        instructions,
        messages,
        output: Output.object({ schema: WireProposal, name: 'engineer_proposal' }),
        maxRetries: host.maxRetries ?? 2,
        maxOutputTokens: ENGINEER_MAX_OUTPUT_TOKENS,
        abortSignal: signal,
      });
      meter(r.usage);
      const parsed = EngineerProposal.safeParse(fromWire(r.output));
      return parsed.success
        ? { ok: true, proposal: parsed.data }
        : { ok: false, raw: JSON.stringify(r.output), issues: issuesText(parsed.error) };
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) {
        meter(e.usage);
        const cause = e.cause instanceof Error ? e.cause.message : e.message;
        return { ok: false, raw: e.text ?? '', issues: cause };
      }
      throw e;
    }
  };

  const messages: ModelMessage[] = [{ role: 'user', content: prepared.content }];
  try {
    let answer = await ask(messages);
    if (!answer.ok) {
      if (estimate !== undefined && spent + estimate > capUsd) {
        throw new InvalidProposalError(`${answer.issues} (no retry: the AI cost cap was reached)`);
      }
      answer = await ask([
        ...messages,
        { role: 'assistant', content: answer.raw.slice(0, 20_000) || '(empty reply)' },
        { role: 'user', content: engineerRepairText(answer.issues.slice(0, 2_000)) },
      ]);
      if (!answer.ok) throw new InvalidProposalError(answer.issues);
    }
    let proposal = answer.proposal;
    if (prepared.leftOut > 0) {
      proposal = withNote(
        proposal,
        `${String(prepared.leftOut)} images were not sent: this model takes ${String(ready.caps.maxImages)} per request.`,
      );
    }
    const conflict = !proposal.identity.sameAsset || proposal.identity.conflicts.length > 0;
    if (conflict)
      return { kind: 'proposal', proposal, cached: false, costUsd, identityConflict: true };
    await host.cache.put(cacheKey, proposal).catch(() => undefined);
    return { kind: 'proposal', proposal, cached: false, costUsd };
  } catch (e) {
    return failure(e, { host, timeout, label, route, key });
  }
}

function failure(
  e: unknown,
  o: {
    host: EngineerHost;
    timeout: AbortSignal;
    label: string;
    route: ModelRoute;
    key: string | null;
  },
): EngineerOutcome {
  const inner = unwrap(e);
  if (o.host.signal.aborted) return { kind: 'failed', code: 'cancelled', error: 'Stopped.' };
  if (inner instanceof OfflineOnlyError) {
    return { kind: 'refused', code: 'offline', reason: OFFLINE_ONLY_MESSAGE };
  }
  if (o.timeout.aborted) {
    return {
      kind: 'failed',
      code: 'network',
      error: `${o.label} did not answer within ${String(ENGINEER_TIMEOUT_MS / 60_000)} minutes. Try again.`,
    };
  }
  const described = describeError(e, { label: o.label, model: o.route.model, secrets: [o.key] });
  if (inner instanceof InvalidProposalError || NoOutputGeneratedError.isInstance(inner)) {
    const invalid =
      inner instanceof InvalidProposalError ? inner : new InvalidProposalError('no output');
    const d = describeError(invalid, { label: o.label, model: o.route.model });
    return { kind: 'failed', code: 'invalid', error: d.message };
  }
  if (APICallError.isInstance(inner)) {
    const s = inner.statusCode;
    if (s === 429 || s === 529)
      return { kind: 'failed', code: 'rate-limit', error: described.message };
    if (s === undefined) return { kind: 'failed', code: 'network', error: described.message };
    return { kind: 'failed', code: 'provider', error: described.message };
  }
  if (isNetworkError(inner)) return { kind: 'failed', code: 'network', error: described.message };
  return { kind: 'failed', code: 'provider', error: described.message };
}

// ---------------------------------------------------------------- file cache

const CACHE_KEY = /^[0-9a-f]{64}$/;

/**
 * A cache of proposals in `dir` (the run's `engineering/<run>/ai/`): one `<key>.json` per reply,
 * written to a temporary file and renamed, so a crash never leaves half a file under the key. A
 * file that does not parse is a miss.
 */
export function fileEngineerCache(dir: string): EngineerHost['cache'] {
  const fileOf = (key: string) => {
    if (!CACHE_KEY.test(key)) throw new Error('Not a cache key.');
    return join(dir, `${key}.json`);
  };
  return {
    async get(key) {
      if (!CACHE_KEY.test(key)) return null;
      try {
        const raw = JSON.parse(await readFile(fileOf(key), 'utf8')) as { proposal?: unknown };
        const p = EngineerProposal.safeParse(raw.proposal);
        return p.success ? p.data : null;
      } catch {
        return null;
      }
    },
    async put(key, proposal) {
      const file = fileOf(key);
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp-${randomUUID()}`;
      try {
        await writeFile(tmp, JSON.stringify({ promptVersion: PROMPT_VERSION, proposal }), 'utf8');
        await rename(tmp, file);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
  };
}
