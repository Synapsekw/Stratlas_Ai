import type { LocalModelSettings } from '@aio/schema';
import type { ModelRoute } from './routes';

/** What a model can do, as far as the engineer step cares. */
export interface ModelCaps {
  /** Reads images. */
  vision: boolean;
  /** Returns output that follows a JSON schema (`generateObject`). */
  structured: boolean;
  /** Images per request. */
  maxImages: number;
  /** Longest image side, in pixels, worth sending. */
  maxImagePx: number;
}

/** What the local model capability probe found (`ai:localProbe`). */
export type LocalCaps = NonNullable<LocalModelSettings['capabilities']>;

/**
 * Known models by provider and id pattern, never by one current id: a new model of a known family
 * is covered without a code change. Anything else is unknown (`null`).
 */
const TABLE: readonly { provider: string; pattern: RegExp; exclude?: RegExp; caps: ModelCaps }[] = [
  {
    provider: 'anthropic',
    pattern: /^claude-(opus|sonnet)-/,
    caps: { vision: true, structured: true, maxImages: 20, maxImagePx: 1568 },
  },
  {
    provider: 'anthropic',
    pattern: /^claude-haiku-/,
    caps: { vision: true, structured: true, maxImages: 20, maxImagePx: 1568 },
  },
  {
    provider: 'openai',
    // the family must end at a separator (gpt-5.5, gpt-6-luna, not gpt-50); speech, realtime and
    // search variants of those families do not take images with structured output
    pattern: /^gpt-(4o|4\.1|5|6)(?:[.-]|$)/,
    exclude: /-(audio|realtime|transcribe|tts|search)(?:-|$)/,
    caps: { vision: true, structured: true, maxImages: 20, maxImagePx: 2048 },
  },
];

/** Limits for a model the person vouches for, or a local model with vision: small on purpose. */
const CONSERVATIVE: ModelCaps = { vision: true, structured: true, maxImages: 8, maxImagePx: 1024 };
const TEXT_ONLY: ModelCaps = { vision: false, structured: true, maxImages: 0, maxImagePx: 0 };

/**
 * The capabilities of `model` on `provider`, or `null` when unknown. A local model is read from
 * the capability probe (`o.local`); a cloud model from the table. `treatAsVision` gives an unknown
 * model conservative caps; it never overrides what the table or the probe says.
 */
export function capsFor(
  provider: string,
  model: string,
  o: { treatAsVision?: boolean; local?: LocalCaps } = {},
): ModelCaps | null {
  if (provider === 'local') {
    if (o.local) return o.local.vision ? { ...CONSERVATIVE } : { ...TEXT_ONLY };
  } else {
    const known = TABLE.find(
      (e) => e.provider === provider && e.pattern.test(model) && !e.exclude?.test(model),
    );
    if (known) return { ...known.caps };
  }
  return o.treatAsVision ? { ...CONSERVATIVE } : null;
}

/**
 * Whether `route` can run the engineer step (images in, structured proposal out). `local` is what
 * the probe found when the route runs on the local model. The reason names what to change.
 */
export function engineerReady(
  route: ModelRoute,
  local?: LocalCaps,
): { ok: true; caps: ModelCaps } | { ok: false; reason: string } {
  const isLocal = route.provider === 'local';
  const caps = capsFor(route.provider, route.model, {
    ...(route.treatAsVision === undefined ? {} : { treatAsVision: route.treatAsVision }),
    ...(isLocal && local ? { local } : {}),
  });
  const name = isLocal ? `The local model ${route.model}` : `The model ${route.model}`;
  if (!caps) {
    return {
      ok: false,
      reason: isLocal
        ? `${name} has not been checked for vision yet, so it cannot run the engineering step. Check it in Settings, AI providers, or turn on "Treat as vision model" for its route there.`
        : `${name} is not one this app knows can read images and return structured answers, so it cannot run the engineering step. Choose a known vision model in Settings, AI providers, or turn on "Treat as vision model" for its route there.`,
    };
  }
  if (!caps.vision) {
    return {
      ok: false,
      reason: `${name} cannot read images, so it cannot run the engineering step. Choose a model with vision in Settings, AI providers.`,
    };
  }
  if (!caps.structured) {
    return {
      ok: false,
      reason: `${name} cannot return structured answers, so it cannot run the engineering step. Choose another model in Settings, AI providers.`,
    };
  }
  return { ok: true, caps };
}
