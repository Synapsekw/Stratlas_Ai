/**
 * A fake local model server for the e2e suite (M8 C7): Ollama's own API (`/api/version`,
 * `/api/tags`, `/api/show`) or a plain OpenAI-compatible server (LM Studio, llama.cpp), and
 * `/v1/models` and `/v1/chat/completions` (streamed and not) for both. It listens on 127.0.0.1
 * only, so a spec allows exactly its origin through the zero-network guard
 * (`AIO_NETWORK_GUARD_ALLOW`).
 *
 * Scripted replies, by the newest user text:
 * - the probe ("Call the tool named ready") gets a call of `ready`;
 * - "fly to" gets a `fly_to` call with malformed JSON (single quotes, trailing comma), as small
 *   models write it, so the app's tool-call repair is exercised; after the tool result it answers
 *   in text;
 * - "slow" waits 60 s before the first token (the cancel test);
 * - an image gets "Red.", or the detection JSON for a detection request;
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
}

export interface FakeLlm {
  /** `http://127.0.0.1:<port>`: the origin to allow and the address to type. */
  origin: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export const GREETING = 'Hello from the local test model.';
export const FLOWN = 'The camera is at Unit quad now.';
export const DETECT_REPLY = {
  images: [
    { image: 1, detections: [{ class: 'rust', box: [0.1, 0.1, 0.2, 0.2], confidence: 0.8 }] },
    { image: 2, detections: [{ class: 'rust', box: [0.5, 0.5, 0.1, 0.1], confidence: 0.6 }] },
  ],
};

interface ChatPart {
  type: string;
  text?: string;
}
interface ChatMessage {
  role: string;
  content: string | ChatPart[] | null;
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

function script(body: ChatBody): Reply {
  const text = lastUserText(body.messages).toLowerCase();
  const last = body.messages.at(-1);
  if (hasImage(body.messages)) {
    return allText(body.messages).includes('<aio-detect>')
      ? { text: JSON.stringify(DETECT_REPLY) }
      : { text: 'Red.' };
  }
  if (body.tools?.length) {
    if (last?.role === 'tool') return { text: FLOWN };
    if (text.includes('tool named ready')) return { tool: 'ready', args: '{"ok":true}' };
    if (text.includes('fly to')) {
      return { tool: 'fly_to', args: "{'target': {'kind': 'place', 'name': 'Unit quad'},}" };
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
