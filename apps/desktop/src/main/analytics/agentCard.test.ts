/**
 * The offline agent and detector runs share one graphics card (A3): the pieces wired as index.ts
 * wires them (the local ask's one-at-a-time slot, the bundled agent on its `acquire`, the detector
 * queue waiting while `localAsk.active()`, the agent runtime with `host.bundled`), with a fake
 * model server and card. A detector run queued while the agent holds the model starts once the
 * agent's tool waits for the person's approval, and the agent's next step waits for the card.
 */
import { approvalFor, toolsForWindow } from '@aio/ai';
import { createAgentRuntime, toolCheckVersion, WAITING_FOR_MODEL } from '@aio/ai/main';
import type {
  BundledAgentCheck,
  IpcEvent,
  IpcRequest,
  JobRecord,
  LocalModelSettings,
} from '@aio/schema';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBundledAgent } from './agentModel';
import { createLocalAsk } from './ask';
import { DETECT_QUEUED, detectLane } from './gate';
import type { AnalyticsPack } from './pack';

type StartRequest = IpcRequest<'jobs:start'>;
type AiEvent = IpcEvent<'ai:event'>;

const KEY = 'k'.repeat(32);
const SHA = 'b'.repeat(64);
const RELEASE = 'b11489';
const MODEL = 'qwen3.5-9b-q4_k_m';

/** A compact 3D tool that waits for approval and takes no arguments. */
const WRITE_TOOL =
  toolsForWindow('scene3d', 'compact', { task: 'chat' }).find(
    (s) =>
      approvalFor(s.meta.name) &&
      (s.input as { safeParse?: (v: unknown) => { success: boolean } }).safeParse?.({}).success ===
        true,
  )?.meta.name ?? 'none';

let server: Server;
let origin: string;

/** One streamed tool call of WRITE_TOOL, then text once its result is in. */
beforeEach(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        model: string;
        messages?: { role: string }[];
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model };
      const send = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
      if (body.messages?.at(-1)?.role !== 'tool') {
        const call = { index: 0, id: 'call_1', type: 'function' };
        const fn = { name: WRITE_TOOL, arguments: '{}' };
        send({
          ...base,
          choices: [
            { index: 0, delta: { role: 'assistant', tool_calls: [{ ...call, function: fn }] } },
          ],
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => {
    server.close(() => {
      ok();
    });
  });
});

const pack = {
  version: '0.2.0',
  dir: 'D:/pack',
  manifest: {
    model: { id: MODEL, sha256: SHA },
    runtime: { name: 'llama.cpp', release: RELEASE, executable: 'llama-server.exe' },
  },
  server: 's',
  gguf: 'g',
  mmproj: 'm',
} as unknown as AnalyticsPack;

const check: BundledAgentCheck = {
  modelSha256: SHA,
  runtimeRelease: RELEASE,
  checkVersion: toolCheckVersion(),
  modelId: MODEL,
  packVersion: '0.2.0',
  passed: true,
  correct: 12,
  total: 12,
  needed: 10,
  invalidCalls: 0,
  meanLatencyMs: 400,
  checkedAt: '2026-11-12T00:00:00.000Z',
  cases: [],
};

const detectRequest = (): StartRequest =>
  ({
    pipeline: 'detect.vlm',
    project: 'D:/p',
    params: { run: 'run-a', layer: 'l1', photos: ['p1'], detectors: [] },
  }) as unknown as StartRequest;

/** The pieces as index.ts wires them, with a fake server, card and job list. */
function wire() {
  const jobs: JobRecord[] = [];
  const start = vi.fn((req: StartRequest) => {
    const j = {
      id: `job-${String(jobs.length + 1)}`,
      pipeline: 'pipeline' in req ? req.pipeline : 'detect.vlm',
      status: 'running',
    };
    jobs.push(j as unknown as JobRecord);
    return Promise.resolve({ ok: true as const, job: j as unknown as JobRecord });
  });
  const lease = vi.fn();
  const vlmServer = {
    ensure: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        state: {
          url: origin,
          pid: 1,
          apiKey: KEY,
          modelSha256: SHA,
          startedAt: '2026-11-12T00:00:00.000Z',
        },
      }),
    ),
    attach: vi.fn(),
    serves: () => true,
    lease: () => lease,
    idle: vi.fn(),
  };
  const queue = detectLane({
    gate: (req, running) => Promise.resolve(running() ? { queue: true as const } : { req }),
    start,
    jobs: () => jobs,
    server: vlmServer,
    othersOnCard: () => localAsk.active(),
    log: () => undefined,
  });
  const localAsk = createLocalAsk({
    env: {},
    findPack: () => Promise.resolve(pack),
    unusable: () => Promise.resolve([]),
    hardware: () =>
      Promise.resolve({ ok: true, gpu: 'x', gpuIndex: 0, totalMb: 16000, freeMb: 12000 }),
    server: vlmServer,
    // as index.ts: a detector run at work holds the card
    gpuBusy: () => queue.gpuBusy('photo.align'),
    started: () => {
      queue.askStarted();
    },
    idleIfUnused: () => {
      void queue.askEnded();
    },
    fetch,
    now: () => Date.now(),
  });
  const bundled = createBundledAgent({
    localAsk,
    findPack: () => Promise.resolve(pack),
    check: () => check,
  });
  const cfg: LocalModelSettings = {
    enabled: true,
    source: 'bundled',
    baseUrl: 'http://localhost:11434/v1',
    model: MODEL,
  };
  const events: AiEvent[] = [];
  const runtime = createAgentRuntime(
    {
      getKey: () => Promise.resolve(null),
      cloudAllowed: () => false,
      emit: (e) => events.push(e),
      routes: () => [{ task: 'chat', provider: 'local', model: MODEL }],
      localModel: () => cfg,
      bundled: { ready: () => bundled.ready(), acquire: (s) => bundled.acquire(s) },
    },
    { maxRetries: 0 },
  );
  const endJob = async (id: string) => {
    const i = jobs.findIndex((j) => j.id === id);
    const now = { ...jobs[i], status: 'done' } as JobRecord;
    jobs[i] = now;
    await queue.settled({ type: 'update', job: now });
  };
  return { queue, localAsk, runtime, events, start, endJob };
}

describe('the offline agent and detector runs on one card (A3)', () => {
  it('a detector run queued behind an open approval card starts; the agent then waits for it', async () => {
    expect(WRITE_TOOL).not.toBe('none');
    const t = wire();
    expect(
      await t.runtime.send({
        runId: 'r1',
        window: 'scene3d',
        context: {},
        messages: [{ role: 'user', content: 'Do it.' }],
      }),
    ).toEqual({ ok: true });
    // the agent holds the model while the model answers
    await vi.waitFor(() => {
      expect(t.localAsk.active()).toBe(true);
    });
    // a detector run asked for now waits behind it
    expect(await t.queue.start(detectRequest())).toEqual({ ok: false, error: DETECT_QUEUED });
    expect(t.start).not.toHaveBeenCalled();
    // the agent's tool waits for the person's approval: the model goes back, the run starts
    await vi.waitFor(() => {
      expect(t.events.some((e) => e.type === 'tool-call')).toBe(true);
    });
    await vi.waitFor(() => {
      expect(t.start).toHaveBeenCalledTimes(1);
    });
    expect(t.localAsk.active()).toBe(false);
    // the person approves while the detector run works: the agent's next step waits for the card
    const call = t.events.find((e) => e.type === 'tool-call');
    if (call?.type !== 'tool-call') throw new Error('no tool call');
    t.runtime.toolResult({ runId: 'r1', callId: call.callId, approved: true, result: {} });
    await vi.waitFor(() => {
      const text = t.events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
      expect(text).toContain(WAITING_FOR_MODEL);
    });
    // the detector run ends: the agent takes the model again and finishes
    await t.endJob('job-1');
    await vi.waitFor(
      () => {
        expect(t.events.some((e) => e.type === 'done')).toBe(true);
      },
      { timeout: 8000 },
    );
    expect(t.localAsk.active()).toBe(false);
  }, 15_000);
});
