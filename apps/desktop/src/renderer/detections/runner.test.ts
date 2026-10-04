import type { Detection, DetectionRun } from '@aio/annotate/detections';
import type { IpcRequest, IpcResponse } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import type { DetectItem } from './convert';
import { startDetectRun, type RunnerDeps, type RunProgress } from './runner';

const items: DetectItem[] = Array.from({ length: 10 }, (_, i) => ({
  kind: 'photo',
  layer: 'photos',
  photo: `p${String(i + 1).padStart(3, '0')}`,
}));

type Ok = Extract<IpcResponse<'ai:detect'>, { ok: true }>;

function okFor(req: IpcRequest<'ai:detect'>, cost?: number): Ok {
  return {
    ok: true,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    promptVersion: 'detect-v1',
    results: req.images.map((im) => ({
      key: im.key,
      detections: [{ classId: 'moderate', label: 'moderate', box: [0.1, 0.1, 0.2, 0.2] }],
    })),
    inputTokens: 1000 * req.images.length,
    outputTokens: 100,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    warnings: [],
  };
}

function deps(detect: RunnerDeps['detect']) {
  const added: { detections: Detection[]; run?: DetectionRun }[] = [];
  const cancel = vi.fn();
  const progress: RunProgress[] = [];
  const d: RunnerDeps = {
    detect,
    cancel,
    prepare: (item) =>
      Promise.resolve({
        dataUrl: `data:image/jpeg;base64,${item.kind}`,
        width: 2560,
        height: 1708,
      }),
    convert: (res) => ({
      detections: res.results.flatMap((r) => r.detections.map(() => ({ id: r.key }) as Detection)),
      skipped: 0,
    }),
    add: (detections, run) => {
      added.push({ detections, ...(run ? { run } : {}) });
    },
    progress: (p) => {
      progress.push(p);
    },
    now: () => '2026-10-05T10:00:00.000Z',
  };
  return { d, added, progress, cancel };
}

const input = {
  runId: 'run-1',
  pass: 'ai-run-1.json',
  projectId: 'ebsm',
  items,
  classes: [{ id: 'moderate', label: 'Moderate' }],
  batchSize: 4,
};

describe('AI detection run', () => {
  it('sends batches in order, adds drafts per batch and records one run with the cost', async () => {
    const sent: IpcRequest<'ai:detect'>[] = [];
    const t = deps((req) => {
      sent.push(req);
      return Promise.resolve(okFor(req, 0.01));
    });
    const p = await startDetectRun(input, t.d).done;
    expect(sent.map((r) => r.images.length)).toEqual([4, 4, 2]);
    expect(sent.map((r) => r.runId)).toEqual(['run-1:0', 'run-1:1', 'run-1:2']);
    expect(sent[0]?.images[0]?.key).toBe('photo:photos:p001');
    expect(p).toMatchObject({
      phase: 'done',
      batchesDone: 3,
      imagesDone: 10,
      found: 10,
      inputTokens: 10_000,
      outputTokens: 300,
    });
    expect(p.costUsd).toBeCloseTo(0.03);
    expect(t.added.map((a) => a.detections.length)).toEqual([4, 4, 2, 0]);
    expect(t.added.at(-1)?.run).toMatchObject({
      id: 'run-1',
      images: 10,
      detections: 10,
      model: 'claude-opus-5-5',
      promptVersion: 'detect-v1',
    });
    expect(t.progress[0]).toMatchObject({ phase: 'running', batches: 3, batchesDone: 0 });
  });

  it('stops at a provider error with its exact text and keeps the rest to send later', async () => {
    let n = 0;
    const t = deps((req) => {
      n++;
      return Promise.resolve(
        n === 2
          ? {
              ok: false as const,
              error:
                'Anthropic is busy or rate limited: slow down. (HTTP 429) Wait a moment and try again.',
              status: 429,
            }
          : okFor(req),
      );
    });
    const p = await startDetectRun(input, t.d).done;
    expect(p.phase).toBe('failed');
    expect(p.error).toBe(
      'Anthropic is busy or rate limited: slow down. (HTTP 429) Wait a moment and try again.',
    );
    expect(p.status).toBe(429);
    expect(p.remaining.map((i) => (i.kind === 'photo' ? i.photo : ''))).toEqual([
      'p005',
      'p006',
      'p007',
      'p008',
      'p009',
      'p010',
    ]);
    expect(p.found).toBe(4);
    // a model without a price makes the cost a lower bound
    expect(p.costKnown).toBe(false);
    expect(t.added.at(-1)?.run).toMatchObject({ images: 4, detections: 4 });
    expect(t.added.at(-1)?.run?.costUsd).toBeUndefined();
  });

  it('a refused first request adds nothing at all', async () => {
    const t = deps(() => Promise.resolve({ ok: false as const, error: 'Cloud AI is off.' }));
    const p = await startDetectRun(input, t.d).done;
    expect(p).toMatchObject({ phase: 'failed', error: 'Cloud AI is off.', batchesDone: 0 });
    expect(t.added).toEqual([]);
    expect(p.remaining).toHaveLength(10);
  });

  it('stop cancels the request in flight and keeps what came back', async () => {
    let release: (v: IpcResponse<'ai:detect'>) => void = () => undefined;
    const t = deps(
      (req) =>
        new Promise((resolve) => {
          if (req.runId === 'run-1:0') resolve(okFor(req, 0.01));
          else release = resolve;
        }),
    );
    const r = startDetectRun(input, t.d);
    await vi.waitFor(() => {
      expect(t.progress.at(-1)?.batchesDone).toBe(1);
    });
    r.stop();
    expect(t.cancel).toHaveBeenCalledWith('run-1:1');
    release({ ok: false, error: 'Stopped.', stopped: true });
    const p = await r.done;
    expect(p.phase).toBe('stopped');
    expect(p.found).toBe(4);
    expect(p.remaining).toHaveLength(6);
  });
});
