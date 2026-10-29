/**
 * Custom requests on the model on this PC: one request at a time to the Analytics pack's
 * `llama-server`, never beside a detector run or a GPU photo job (`gpuBusy`). The prompts, the
 * reply parser and the guards are the shared ones in `@aio/ai`; this file only finds the server,
 * sends the images and reads the answer.
 */
import { ASK_PROMPT_VERSION, CHANGE_FIELDS, askMaxTokens, askPrompt, parseAskReply } from '@aio/ai';
import type { HardwareCheck, IpcRequest, IpcResponse } from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { localVlmModel } from './models';
import type { AnalyticsPack, UnusablePack } from './pack';
import type { VlmServer } from './server';

type AskRequest = IpcRequest<'ai:ask'>;
type AskResponse = IpcResponse<'ai:ask'>;

export interface LocalAskDeps {
  env: Record<string, string | undefined>;
  findPack(): Promise<AnalyticsPack | null>;
  unusable(): Promise<UnusablePack[]>;
  hardware(minFreeMb: number): Promise<HardwareCheck>;
  server: Pick<VlmServer, 'ensure' | 'attach' | 'serves' | 'lease'>;
  /** Why the card is taken (a detector run or a GPU job), null when free. */
  gpuBusy(): string | null;
  /** A request goes to the model now (a model kept warm stays loaded). */
  started?(): void;
  /** The request ended: keep the model warm a while, then stop it when nothing else uses it. */
  idleIfUnused(): void;
  fetch: typeof fetch;
  now(): number;
}

export interface LocalAsk {
  run(req: AskRequest): Promise<AskResponse>;
  cancel(runId: string): boolean;
  active(): boolean;
  status(): Promise<{ ready: boolean; model?: string; problem?: string }>;
}

export const LOCAL_ASK_TIMEOUT_MS = 180_000;
/** Earlier turns after the first question sent to the model on this PC (`--ctx-size 8192`). */
export const LOCAL_MAX_TURNS = 8;
const TOO_LONG =
  'This conversation is too long for the model on this PC. Start a new question on this photo.';
const BUSY = 'The model on this PC is answering another request.';
const DEFAULT_MODEL = 'qwen3.5-9b-q4_k_m';
const SEAM_SHA = 'a'.repeat(64);

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface Message {
  role: 'user' | 'assistant';
  content: string | Part[];
}

const fail = (error: string, code?: Extract<AskResponse, { ok: false }>['code']): AskResponse => ({
  ok: false,
  error,
  ...(code ? { code } : {}),
});

const stripThink = (s: string): string =>
  s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .trim();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createLocalAsk(d: LocalAskDeps): LocalAsk {
  let current: { runId: string; abort: AbortController; stopped: boolean } | null = null;
  const seamUrl = d.env.QUADRION_VLM_SERVER_URL;
  const seamModel = d.env.QUADRION_VLM_MODEL ?? DEFAULT_MODEL;

  /** The server to talk to: the model, its family and the url and key. */
  async function resolve(): Promise<
    { model: string; url: string; key: string; error?: undefined } | { error: AskResponse }
  > {
    if (seamUrl) {
      try {
        const s = await d.server.attach(seamUrl, SEAM_SHA);
        return { model: seamModel, url: s.url, key: s.apiKey };
      } catch (e) {
        return { error: fail(message(e), 'no-pack') };
      }
    }
    const pack = await d.findPack();
    if (!pack) {
      const [newest] = await d.unusable();
      return { error: fail(newest?.reason ?? en['detect.preset.pack.missing'], 'no-pack') };
    }
    const model = pack.manifest.model.id;
    let gpuIndex: number | null = null;
    // a server already loaded holds the memory the check looks for
    if (!d.server.serves(pack.dir)) {
      const hw = await d.hardware(localVlmModel(model).minFreeMb);
      if (!hw.ok) return { error: fail(hw.reason, 'no-card') };
      gpuIndex = hw.gpuIndex;
    }
    const up = await d.server.ensure(pack, gpuIndex);
    if (!up.ok) {
      const missing = up.error === en['detect.preset.server.noExe'];
      return {
        error: fail(
          missing ? up.error : en['detect.preset.server.failed'].replace('{reason}', up.error),
          'no-pack',
        ),
      };
    }
    return { model, url: up.state.url, key: up.state.apiKey };
  }

  function buildMessages(req: AskRequest, family: 'qwen25' | 'qwen3'): Message[] {
    const turns = req.turns ?? [];
    // a thread's first question rides with the images; anything before it is dropped and, with
    // no question at all, the request goes alone (as the cloud route does, `askRun.ts`)
    const start = turns.findIndex((t) => t.role === 'user');
    const first = start >= 0 ? turns[start] : undefined;
    // the model on this PC has a small context: only the newest earlier turns go with it
    const rest = first ? turns.slice(start + 1).slice(-LOCAL_MAX_TURNS) : [];
    // the image message is a question: the kept turns start with an answer
    if (rest.length < turns.length - start - 1 && rest[0]?.role === 'user') rest.shift();
    const text = askPrompt({
      family,
      kind: req.kind,
      prompt: first?.text ?? req.prompt,
      fields: req.kind === 'change' ? [...CHANGE_FIELDS, ...req.fields] : req.fields,
      images: req.images.map((im) => ({
        width: im.width,
        height: im.height,
        ...(im.label ? { label: im.label } : {}),
      })),
    });
    const parts: Part[] = [];
    req.images.forEach((im, i) => {
      parts.push({
        type: 'text',
        text: im.label ? `Image ${String(i + 1)} (${im.label}):` : `Image ${String(i + 1)}:`,
      });
      parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
    });
    parts.push({ type: 'text', text });
    const out: Message[] = [{ role: 'user', content: parts }];
    for (const t of rest) out.push({ role: t.role, content: t.text });
    if (first) out.push({ role: 'user', content: req.prompt });
    return out;
  }

  async function post(
    r: { model: string; url: string; key: string },
    req: AskRequest,
    messages: Message[],
    signal: AbortSignal,
  ): Promise<
    | { ok: true; text: string; cut: boolean; inTok: number; outTok: number }
    | { ok: false; error: string; status?: number }
  > {
    const model = localVlmModel(r.model);
    const res = await d.fetch(`${r.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${r.key}` },
      body: JSON.stringify({
        messages,
        temperature: 0,
        max_tokens: askMaxTokens(req.kind, 'local'),
        ...(model.thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      const head = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
      // llama-server refuses a prompt past its context with a 400 that names the context size
      if (res.status === 400 && /context (size|length)|exceed_context/i.test(head))
        return { ok: false, status: res.status, error: TOO_LONG };
      return {
        ok: false,
        status: res.status,
        error: `The model on this PC answered ${String(res.status)}${head ? `: ${head}` : '.'}`,
      };
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    return {
      ok: true,
      text: typeof content === 'string' ? content : '',
      cut: choice?.finish_reason === 'length',
      inTok: json.usage?.prompt_tokens ?? 0,
      outTok: json.usage?.completion_tokens ?? 0,
    };
  }

  async function answer(
    r: { model: string; url: string; key: string },
    req: AskRequest,
    run: NonNullable<typeof current>,
  ): Promise<AskResponse> {
    const info = localVlmModel(r.model);
    const messages = buildMessages(req, info.family);
    const sent = req.images[req.images.length - 1] ?? { width: 1, height: 1 };
    let inputTokens = 0;
    let outputTokens = 0;
    const timer = setTimeout(() => {
      run.abort.abort();
    }, LOCAL_ASK_TIMEOUT_MS);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const got = await post(r, req, messages, run.abort.signal);
        if (!got.ok) return { ...fail(got.error), ...(got.status ? { status: got.status } : {}) };
        inputTokens += got.inTok;
        outputTokens += got.outTok;
        const warnings = got.cut ? ['The answer was cut short.'] : [];
        const base = {
          ok: true as const,
          provider: 'local',
          model: r.model,
          promptVersion: ASK_PROMPT_VERSION,
          inputTokens,
          outputTokens,
          costUsd: 0,
        };
        if (req.kind === 'ask') {
          const text = stripThink(got.text);
          if (text === '' && !got.cut && attempt === 0) continue;
          return { ...base, items: [], text, warnings };
        }
        const parsed = parseAskReply(got.text, {
          family: info.family,
          kind: req.kind,
          sent,
          fields: req.fields,
          ...(req.wholeImage !== undefined ? { wholeImage: req.wholeImage } : {}),
        });
        if ('error' in parsed) {
          // a list cut off before its first item cannot be kept: ask once more
          if (attempt === 0) continue;
          return fail(parsed.error, 'format');
        }
        // parseAskReply already ran the guards
        return { ...base, items: parsed.items, warnings: [...warnings, ...parsed.warnings] };
      }
      return fail('The model gave no answer.', 'format');
    } catch (e) {
      if (run.stopped) return { ok: false, error: 'Stopped.', stopped: true };
      if (run.abort.signal.aborted) {
        return fail('The model on this PC took too long to answer (3 minutes).');
      }
      return fail(`The model on this PC could not be reached: ${message(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async run(req) {
      if (current) return fail(BUSY, 'busy');
      const busy = d.gpuBusy();
      if (busy) return fail(busy, 'busy');
      const run = { runId: req.runId, abort: new AbortController(), stopped: false };
      current = run;
      d.started?.();
      let release: (() => void) | null = null;
      try {
        release = d.server.lease();
        const r = await resolve();
        if ('error' in r && r.error) return r.error;
        if (run.stopped) return { ok: false, error: 'Stopped.', stopped: true };
        return await answer(r, req, run);
      } catch (e) {
        return run.stopped ? { ok: false, error: 'Stopped.', stopped: true } : fail(message(e));
      } finally {
        release?.();
        current = null;
        d.idleIfUnused();
      }
    },
    cancel(runId) {
      if (current?.runId !== runId) return false;
      current.stopped = true;
      current.abort.abort();
      return true;
    },
    active: () => current !== null,
    async status() {
      if (seamUrl) return { ready: true, model: seamModel };
      const pack = await d.findPack();
      if (!pack) {
        const [newest] = await d.unusable();
        return { ready: false, problem: newest?.reason ?? en['detect.preset.pack.missing'] };
      }
      const model = pack.manifest.model.id;
      if (!d.server.serves(pack.dir)) {
        const hw = await d.hardware(localVlmModel(model).minFreeMb);
        if (!hw.ok) return { ready: false, model, problem: hw.reason };
      }
      return { ready: true, model };
    },
  };
}
