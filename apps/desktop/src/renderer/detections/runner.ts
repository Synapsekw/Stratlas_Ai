/**
 * One AI detection run (BLD-6): prepare each batch's images, send it with `ai:detect`, turn the
 * answers into draft detections and add them to the review, metering tokens and cost. A provider
 * error stops the run with the provider's exact message and keeps what is left, so the person can
 * send the rest later. Dependencies are injected so the loop is tested without a model or a DOM.
 */
import { planBatches, type DetectClass, type DetectSeverity } from '@aio/ai';
import type { Detection, DetectionRun } from '@aio/annotate/detections';
import type { IpcRequest, IpcResponse } from '@aio/schema';
import { itemKey, type DetectItem } from './convert';

export interface PreparedImage {
  dataUrl: string;
  /** The original's pixel size (detections are stored in it). */
  width: number;
  height: number;
}

export interface RunProgress {
  phase: 'running' | 'done' | 'stopped' | 'failed';
  batchesDone: number;
  batches: number;
  imagesDone: number;
  images: number;
  found: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** False when some request had no price: the cost is then a lower bound. */
  costKnown: boolean;
  error?: string;
  status?: number;
  warnings: string[];
  /** Items not sent (after a failure or a stop). */
  remaining: DetectItem[];
}

export interface RunnerDeps {
  detect(
    req: IpcRequest<'ai:detect'>,
  ): Promise<IpcResponse<'ai:detect'> | { ok: false; error: string }>;
  cancel(runId: string): void;
  prepare(item: DetectItem): Promise<PreparedImage>;
  /** Draft detections for one batch's answers (see convert.ts). */
  convert(
    res: Extract<IpcResponse<'ai:detect'>, { ok: true }>,
    items: ReadonlyMap<string, DetectItem>,
    sizes: ReadonlyMap<string, { width: number; height: number }>,
  ): { detections: Detection[]; skipped: number };
  add(detections: Detection[], run?: DetectionRun): void;
  progress(p: RunProgress): void;
  now(): string;
}

export interface RunInput {
  runId: string;
  projectId: string;
  items: readonly DetectItem[];
  classes: DetectClass[];
  severity?: DetectSeverity | undefined;
  hint?: string | undefined;
  batchSize: number;
}

export interface DetectRunner {
  done: Promise<RunProgress>;
  stop(): void;
}

export function startDetectRun(input: RunInput, deps: RunnerDeps): DetectRunner {
  const batches = planBatches(input.items, input.batchSize);
  let stopped = false;
  /** Read through a function: `stop()` flips it while the loop awaits. */
  const isStopped = () => stopped;
  const p: RunProgress = {
    phase: 'running',
    batchesDone: 0,
    batches: batches.length,
    imagesDone: 0,
    images: input.items.length,
    found: 0,
    skipped: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costKnown: true,
    warnings: [],
    remaining: [],
  };
  const emit = () => {
    deps.progress({ ...p, warnings: [...p.warnings], remaining: [...p.remaining] });
  };
  let provider = '';
  let model = '';
  let promptVersion = '';

  const finish = (phase: RunProgress['phase'], from: number) => {
    p.phase = phase;
    p.remaining = batches.slice(from).flat();
    if (p.batchesDone > 0) {
      const run: DetectionRun = {
        id: input.runId,
        at: deps.now(),
        kind: 'ai',
        provider,
        model,
        promptVersion,
        images: p.imagesDone,
        detections: p.found,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        ...(p.costKnown ? { costUsd: p.costUsd } : {}),
      };
      deps.add([], run);
    }
    emit();
    return { ...p };
  };

  const loop = async (): Promise<RunProgress> => {
    emit();
    for (const [i, batch] of batches.entries()) {
      if (isStopped()) return finish('stopped', i);
      let images: (PreparedImage & { key: string })[];
      try {
        images = await Promise.all(
          batch.map(async (item) => ({ key: itemKey(item), ...(await deps.prepare(item)) })),
        );
      } catch (e) {
        p.error = e instanceof Error ? e.message : String(e);
        return finish('failed', i);
      }
      if (isStopped()) return finish('stopped', i);
      const res = await deps.detect({
        runId: `${input.runId}:${String(i)}`,
        projectId: input.projectId,
        classes: input.classes,
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.hint?.trim() ? { hint: input.hint.trim() } : {}),
        images: images.map(({ key, dataUrl, width, height }) => ({ key, dataUrl, width, height })),
      });
      if (!res.ok) {
        if ('stopped' in res && res.stopped) return finish('stopped', i);
        p.error = res.error;
        if ('status' in res && res.status !== undefined) p.status = res.status;
        return finish('failed', i);
      }
      provider = res.provider;
      model = res.model;
      promptVersion = res.promptVersion;
      const items = new Map(batch.map((it) => [itemKey(it), it]));
      const sizes = new Map(images.map((im) => [im.key, { width: im.width, height: im.height }]));
      const converted = deps.convert(res, items, sizes);
      if (converted.detections.length) deps.add(converted.detections);
      p.batchesDone += 1;
      p.imagesDone += batch.length;
      p.found += converted.detections.length;
      p.skipped += converted.skipped;
      p.inputTokens += res.inputTokens;
      p.outputTokens += res.outputTokens;
      if (res.costUsd === undefined) p.costKnown = false;
      else p.costUsd += res.costUsd;
      p.warnings.push(...res.warnings);
      emit();
    }
    return finish('done', batches.length);
  };

  return {
    done: loop(),
    stop: () => {
      stopped = true;
      for (let i = 0; i < batches.length; i++) deps.cancel(`${input.runId}:${String(i)}`);
    },
  };
}
