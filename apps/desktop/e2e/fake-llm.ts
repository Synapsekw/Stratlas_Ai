/**
 * A fake local model server for the e2e suite (M8 C7): Ollama's own API (`/api/version`,
 * `/api/tags`, `/api/show`) or a plain OpenAI-compatible server (LM Studio, llama.cpp), and
 * `/v1/models` and `/v1/chat/completions` (streamed and not) for both. It listens on 127.0.0.1
 * only, so a spec allows exactly its origin through the zero-network guard
 * (`AIO_NETWORK_GUARD_ALLOW`).
 *
 * Scripted replies, by the newest user text:
 * - the probe ("Call the tool named ready") gets a call of `ready`;
 * - "fly to" gets a `find_places` call with the words after "fly to", in malformed JSON (single
 *   quotes, trailing comma) as small models write it, so the app's tool-call repair is exercised;
 *   after its result a `fly_to` call with the id of the first place found; after that result it
 *   answers in text (FLOWN);
 * - "top view" gets a malformed `set_view` call;
 * - "slow" waits 60 s before the first token (the cancel test);
 * - an image gets "Red.", or the detection JSON for a detection request;
 * - the RF Auto-plan request (its instructions say "plan the radio coverage") gets picks for the
 *   units it lists (`rfPlanReply`): the generic panel and radio on B3 for each, except the last
 *   unit, whose pick names an entry the catalogue does not have (`RF_UNKNOWN_ENTRY`);
 * - the `detect.vlm` job's two prompts, which carry no model name (`vlmReply`): a detect prompt
 *   ("You are a detector for drone inspection photos.") gets two boxes (`VLM_BOXES`, in pixels of
 *   the 1344 x 1008 frame sent), a check prompt ("This is a crop from a drone inspection photo.")
 *   gets Yes and No with `top_logprobs`, scoring `VLM_HIGH` for the crop of the large box and
 *   `VLM_LOW` for the small one (told apart by the width of the JPEG sent);
 * - anything else gets a fixed greeting.
 * A model without tools answers a request with tools with the 400 Ollama gives; a model without
 * vision refuses images the same way.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeModel {
  id: string;
  tools: boolean;
  vision: boolean;
  contextTokens: number;
}

export interface FakeLlmOptions {
  kind: 'ollama' | 'openai-compatible';
  models: FakeModel[];
}

export interface FakeRequest {
  method: string;
  path: string;
  model?: string;
  tools?: string[];
  image?: boolean;
  authorization?: string;
  /** The tool call the fake answered with, if any. */
  call?: { tool: string; args: string };
}

export interface FakeLlm {
  /** `http://127.0.0.1:<port>`: the origin to allow and the address to type. */
  origin: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export const GREETING = 'Hello from the local test model.';
export const FLOWN = 'The camera is there now.';
export const DETECT_REPLY = {
  images: [
    { image: 1, detections: [{ class: 'marker', box: [0.1, 0.1, 0.2, 0.2], confidence: 0.8 }] },
    { image: 2, detections: [{ class: 'marker', box: [0.5, 0.5, 0.1, 0.1], confidence: 0.6 }] },
  ],
};

/** What the fake finds on every photo: a large and a small box, `[x1, y1, x2, y2]` in pixels of
 * the 1344 x 1008 frame the job sends. */
export const VLM_BOXES = [
  { bbox_2d: [100, 100, 500, 400], label: 'patch', note: 'large patch, upper left' },
  { bbox_2d: [800, 600, 900, 680], label: 'patch', note: 'small patch, lower right' },
] as const;
/** The check scores: the large box is likely a match, the small one is not. */
export const VLM_HIGH = 0.95;
export const VLM_LOW = 0.6;
/** A crop wider than this many pixels is the large box's (the small one is about 100 px). */
const VLM_LARGE_CROP_PX = 250;

/** The entry id the fake's RF plan gives its last unit: not in any catalogue. */
export const RF_UNKNOWN_ENTRY = 'fake-entry-not-in-catalogue';
/** The equipment the fake's RF plan picks for the other units (in the bundled catalogue). */
export const RF_FAKE_PICK = {
  entryId: 'generic-panel-65-17',
  radioId: 'generic-rru-4t4r-4x40w',
  band: 'B3',
  tech: 'lte',
  bandwidthMhz: 20,
} as const;
export const RF_FAKE_REASON = 'Thin panel face, so a passive panel on B3.';

/**
 * The fake model's RF plan for the units listed in the request text (`- <unitId>: ...` lines
 * under "Units (N):"), as the `{"picks": [...]}` JSON the app asks for.
 */
export function rfPlanReply(userText: string): string {
  const units = userText.split('Catalogue (')[0] ?? '';
  const ids = [...units.matchAll(/^- ([^:\s]+):/gm)].map((m) => m[1] ?? '');
  const picks = ids.map((unitId, i) =>
    i === ids.length - 1
      ? {
          ...RF_FAKE_PICK,
          unitId,
          entryId: RF_UNKNOWN_ENTRY,
          reason: 'Unsure.',
          confidence: 'medium',
        }
      : { ...RF_FAKE_PICK, unitId, reason: RF_FAKE_REASON, confidence: 'high' },
  );
  return JSON.stringify({ picks });
}

interface ChatPart {
  type: string;
  text?: string;
  image_url?: { url?: string };
}
interface ChatMessage {
  role: string;
  content: string | ChatPart[] | null;
  tool_calls?: { function: { name: string } }[];
}
interface ChatBody {
  model: string;
  messages: ChatMessage[];
  tools?: { function: { name: string } }[];
  stream?: boolean;
}

type Reply = { text: string } | { tool: string; args: string };

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** The last text part of the newest user message (the context block comes before it). */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const texts = (m.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '');
    return texts.at(-1) ?? '';
  }
  return '';
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
  );
}

function allText(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((p) => p.text ?? '').join(' '),
    )
    .join('\n');
}

/** The id of the first place in the newest tool result (a `find_places` result). */
function firstPlaceId(messages: ChatMessage[]): string | null {
  const content = messages.at(-1)?.content;
  const raw =
    typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join('');
  return /"places":\s*\[\s*\{[^{}]*?"id":\s*"([^"]+)"/.exec(raw)?.[1] ?? null;
}

/** The tool the model called last (the assistant message before the tool results). */
function lastToolCalled(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const name = messages[i]?.tool_calls?.at(-1)?.function.name;
    if (name) return name;
  }
  return null;
}

/** The width of the first JPEG image of the newest message (its SOF marker), or 0. */
function jpegWidth(messages: ChatMessage[]): number {
  const last = messages.at(-1);
  const part = Array.isArray(last?.content)
    ? last.content.find((p) => p.type === 'image_url')
    : undefined;
  const url = part?.image_url?.url ?? '';
  const b = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return 0;
    const marker = b[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return b.readUInt16BE(i + 7);
    i += 2 + b.readUInt16BE(i + 2);
  }
  return 0;
}

function vlmCompletion(message: unknown, logprobs: unknown = null) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1,
    model: 'vlm-fake',
    choices: [{ index: 0, message, logprobs, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  };
}

/**
 * The reply to a `detect.vlm` prompt (these requests name no model), or null for any other:
 * the two boxes as JSON text, or the token `Yes` with `No` beside it in `top_logprobs`.
 */
function vlmReply(body: ChatBody): unknown {
  const text = lastUserText(body.messages);
  if (text.startsWith('You are a detector for drone inspection photos.'))
    return vlmCompletion({ role: 'assistant', content: JSON.stringify(VLM_BOXES) });
  if (!text.startsWith('This is a crop from a drone inspection photo.')) return null;
  const p = jpegWidth(body.messages) > VLM_LARGE_CROP_PX ? VLM_HIGH : VLM_LOW;
  const top = [
    { token: 'Yes', logprob: Math.log(p) },
    { token: 'No', logprob: Math.log(1 - p) },
  ];
  return vlmCompletion(
    { role: 'assistant', content: 'Yes' },
    { content: [{ token: 'Yes', logprob: Math.log(p), top_logprobs: top }] },
  );
}

function script(body: ChatBody): Reply {
  const original = lastUserText(body.messages);
  const text = original.toLowerCase();
  const last = body.messages.at(-1);
  if (hasImage(body.messages)) {
    return allText(body.messages).includes('<aio-detect>')
      ? { text: JSON.stringify(DETECT_REPLY) }
      : { text: 'Red.' };
  }
  if (allText(body.messages).includes('plan the radio coverage')) {
    return { text: rfPlanReply(original) };
  }
  if (body.tools?.length) {
    if (last?.role === 'tool') {
      const id = lastToolCalled(body.messages) === 'find_places' && firstPlaceId(body.messages);
      if (id)
        return { tool: 'fly_to', args: JSON.stringify({ target: { kind: 'place', name: id } }) };
      return { text: FLOWN };
    }
    if (text.includes('tool named ready')) return { tool: 'ready', args: '{"ok":true}' };
    if (text.includes('fly to')) {
      const words = original.slice(text.indexOf('fly to') + 'fly to'.length).trim();
      return { tool: 'find_places', args: `{'query': '${words}',}` };
    }
    if (text.includes('top view')) return { tool: 'set_view', args: "{'view': 'top',}" };
  }
  return { text: GREETING };
}

function sse(res: ServerResponse, model: string, reply: Reply): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model };
  const send = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
  if ('text' in reply) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  } else {
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${String(Date.now())}`,
                type: 'function',
                function: { name: reply.tool, arguments: reply.args },
              },
            ],
          },
        },
      ],
    });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  }
  send({
    ...base,
    choices: [],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  });
  res.end('data: [DONE]\n\n');
}

function completion(res: ServerResponse, model: string, reply: Reply): void {
  const message =
    'text' in reply
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: reply.tool, arguments: reply.args },
            },
          ],
        };
  json(res, 200, {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  });
}

export async function startFakeLlm(opts: FakeLlmOptions): Promise<FakeLlm> {
  const requests: FakeRequest[] = [];
  const byId = new Map(opts.models.map((m) => [m.id, m]));
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const method = req.method ?? 'GET';
      const record: FakeRequest = { method, path };
      if (req.headers.authorization) record.authorization = req.headers.authorization;
      requests.push(record);
      const raw = method === 'POST' ? await readBody(req) : '';

      if (opts.kind === 'ollama' && path === '/api/version') {
        json(res, 200, { version: '0.0.0-fake' });
        return;
      }
      if (opts.kind === 'ollama' && path === '/api/tags') {
        json(res, 200, {
          models: opts.models.map((m) => ({
            name: m.id,
            model: m.id,
            size: 2_000_000_000,
            details: { family: 'fake', quantization_level: 'Q4_K_M' },
          })),
        });
        return;
      }
      if (opts.kind === 'ollama' && path === '/api/show') {
        const { model } = JSON.parse(raw) as { model: string };
        const m = byId.get(model);
        if (!m) {
          json(res, 404, { error: `model "${model}" not found` });
          return;
        }
        json(res, 200, {
          model_info: { 'general.architecture': 'fake', 'fake.context_length': m.contextTokens },
          capabilities: [
            'completion',
            ...(m.tools ? ['tools'] : []),
            ...(m.vision ? ['vision'] : []),
          ],
        });
        return;
      }
      if (path === '/v1/models') {
        json(res, 200, {
          object: 'list',
          data: opts.models.map((m) => ({ id: m.id, object: 'model', owned_by: 'fake' })),
        });
        return;
      }
      if (method === 'POST' && path === '/v1/chat/completions') {
        const body = JSON.parse(raw) as ChatBody;
        const vlm = vlmReply(body);
        if (vlm) {
          record.image = hasImage(body.messages);
          json(res, 200, vlm);
          return;
        }
        record.model = body.model;
        record.image = hasImage(body.messages);
        if (body.tools) record.tools = body.tools.map((t) => t.function.name);
        const m = byId.get(body.model);
        if (!m) {
          json(res, 404, { error: { message: `model "${body.model}" not found` } });
          return;
        }
        if (body.tools?.length && !m.tools) {
          json(res, 400, { error: { message: `${m.id} does not support tools` } });
          return;
        }
        if (record.image && !m.vision) {
          json(res, 400, { error: { message: `${m.id} does not support images` } });
          return;
        }
        if (lastUserText(body.messages).toLowerCase().includes('slow')) {
          // A model still loading: nothing for a minute, unless the app hangs up first.
          const timer = setTimeout(() => {
            if (!res.writableEnded) sse(res, m.id, { text: GREETING });
          }, 60_000);
          req.on('close', () => {
            clearTimeout(timer);
          });
          return;
        }
        const reply = script(body);
        if ('tool' in reply) record.call = { tool: reply.tool, args: reply.args };
        if (body.stream) sse(res, m.id, reply);
        else completion(res, m.id, reply);
        return;
      }
      json(res, 404, { error: 'Unexpected endpoint or method.' });
    })();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => {
          ok();
        });
      }),
  };
}
