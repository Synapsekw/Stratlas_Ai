/**
 * One custom request (`ai:ask`) on a cloud model, after main's gates have passed: the images,
 * the prompt and the thread's earlier turns as one conversation, one `generateText` call (asked
 * once more when the reply cannot be read), the reply read into items or a text answer. No
 * temperature, no top_p and no assistant prefill (Claude 5.5 models refuse them); effort comes
 * from `askProviderOptions`. Every call is metered. Nothing here logs prompts, images or keys.
 */
import type { IpcRequest, IpcResponse } from '@aio/schema';
import { generateText, type LanguageModelUsage, type ModelMessage, type UserContent } from 'ai';
import {
  askMaxTokens,
  askPrompt,
  askProviderOptions,
  ASK_PROMPT_VERSION,
  parseAskReply,
} from './ask';
import { describeError } from './errors';
import type { StepUsage } from './main';
import { estimateCostUsd } from './pricing';
import type { ModelProvider } from './providers';
import type { ModelRoute } from './routes';

/** One custom request (one or two large images) may take a while on a busy provider. */
export const ASK_TIMEOUT_MS = 180_000;
/** The warning on a reply that stopped at the answer length cap. */
export const ASK_CUT_SHORT = 'The answer was cut short.';
const STOPPED = 'Stopped.';

type AskResponse = IpcResponse<'ai:ask'>;

/** The media type and base64 data of an image data URL; null for anything else. */
export function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  return m?.[1] && m[2] ? { mediaType: m[1], base64: m[2] } : null;
}

/**
 * The conversation of a request: the first user message holds, per image, `Image n:` (or
 * `Image n (<label>):`) and the image, then the request text. A thread's earlier turns follow
 * (the first of them is the opening question, so it goes into the request text), and the new
 * prompt closes as a user message. Turns before the first question are dropped.
 */
export function askMessages(req: IpcRequest<'ai:ask'>): ModelMessage[] | { error: string } {
  const content: UserContent = [];
  for (const [i, im] of req.images.entries()) {
    const img = parseDataUrl(im.dataUrl);
    if (!img) return { error: `Image ${String(i + 1)} is not an image.` };
    const n = String(i + 1);
    content.push({ type: 'text', text: im.label ? `Image ${n} (${im.label}):` : `Image ${n}:` });
    content.push({ type: 'file', data: img.base64, mediaType: img.mediaType });
  }
  const turns = req.turns ?? [];
  const start = turns.findIndex((t) => t.role === 'user');
  const opening = start >= 0 ? turns[start] : undefined;
  content.push({
    type: 'text',
    text: askPrompt({
      family: 'cloud',
      kind: req.kind,
      prompt: opening ? opening.text : req.prompt,
      fields: req.fields,
      images: req.images.map((im) => ({
        width: im.width,
        height: im.height,
        ...(im.label !== undefined ? { label: im.label } : {}),
      })),
    }),
  });
  const messages: ModelMessage[] = [{ role: 'user', content }];
  if (!opening) return messages;
  for (const t of turns.slice(start + 1)) {
    messages.push(
      t.role === 'user'
        ? { role: 'user', content: [{ type: 'text', text: t.text }] }
        : { role: 'assistant', content: [{ type: 'text', text: t.text }] },
    );
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: req.prompt }] });
  return messages;
}

function stepUsage(route: ModelRoute, u: LanguageModelUsage): StepUsage {
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  const costUsd = estimateCostUsd(route.model, {
    inputTokens,
    outputTokens,
    cacheReadTokens: u.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: u.inputTokenDetails.cacheWriteTokens ?? 0,
  });
  return {
    provider: route.provider,
    model: route.model,
    inputTokens,
    outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Send one custom request to a cloud model and read the answer. */
export async function runAsk(o: {
  req: IpcRequest<'ai:ask'>;
  route: ModelRoute;
  provider: ModelProvider;
  key: string | null;
  signal: AbortSignal;
  maxRetries: number;
  recordUsage: (u: StepUsage) => void;
}): Promise<AskResponse> {
  const { req, route, provider } = o;
  const stopped = () => o.signal.aborted;
  if (stopped()) return { ok: false, error: STOPPED, stopped: true };
  const messages = askMessages(req);
  if ('error' in messages) return { ok: false, error: messages.error };
  const last = req.images[req.images.length - 1];
  const sent = { width: last?.width ?? 1, height: last?.height ?? 1 };
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
  let unreadable = '';
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await generateText({
        model: provider.languageModel(route.model, o.key),
        messages,
        maxOutputTokens: askMaxTokens(req.kind, 'cloud'),
        providerOptions: askProviderOptions(route.provider, route.model, req.kind),
        maxRetries: o.maxRetries,
        abortSignal: AbortSignal.any([o.signal, timeout]),
      });
      const u = stepUsage(route, result.usage);
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      if (u.costUsd !== undefined) costUsd = (costUsd ?? 0) + u.costUsd;
      o.recordUsage(u);
      if (result.finishReason === 'content-filter') {
        return {
          ok: false,
          code: 'refused',
          error: `${provider.label}, ${route.model}: the model declined this request.`,
        };
      }
      const warnings = result.finishReason === 'length' ? [ASK_CUT_SHORT] : [];
      const ok = {
        ok: true as const,
        provider: route.provider,
        model: route.model,
        promptVersion: ASK_PROMPT_VERSION,
        inputTokens,
        outputTokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
      if (req.kind === 'ask') {
        return { ...ok, items: [], text: result.text.trim(), warnings };
      }
      const parsed = parseAskReply(result.text, {
        family: 'cloud',
        kind: req.kind,
        sent,
        fields: req.fields,
        ...(req.wholeImage !== undefined ? { wholeImage: req.wholeImage } : {}),
      });
      if ('error' in parsed) {
        unreadable = parsed.error;
        continue;
      }
      return { ...ok, items: parsed.items, warnings: [...warnings, ...parsed.warnings] };
    }
  } catch (e) {
    // read through a call: the abort may have come while the request was out
    if (stopped()) return { ok: false, error: STOPPED, stopped: true };
    if (timeout.aborted) {
      return {
        ok: false,
        error: `${provider.label}, ${route.model}: no answer within ${String(ASK_TIMEOUT_MS / 1000)} s. Try again.`,
      };
    }
    const described = describeError(e, {
      label: provider.label,
      model: route.model,
      secrets: [o.key],
    });
    console.warn(`custom request failed: ${described.log}`);
    return {
      ok: false,
      error: described.message,
      ...(described.status !== undefined ? { status: described.status } : {}),
    };
  }
  return { ok: false, code: 'format', error: unreadable };
}
