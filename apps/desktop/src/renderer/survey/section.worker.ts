// The section worker (M11 G5): samples cross-sections off the main thread (sectionEngine.ts).
import {
  createSectionEngine,
  fetchBytes,
  type WorkerCall,
  type WorkerReply,
} from './sectionEngine';

/** The parts of DedicatedWorkerGlobalScope used here (the webworker lib clashes with DOM). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerCall>) => void) | null;
  postMessage(message: WorkerReply): void;
}
const scope = globalThis as unknown as WorkerScope;
const engine = createSectionEngine(fetchBytes);

scope.onmessage = (e) => {
  const { id, op, arg } = e.data;
  const run = (): Promise<unknown> => {
    switch (op) {
      case 'setSources':
        return engine.setSources(arg as Parameters<typeof engine.setSources>[0]);
      case 'section':
        return engine.section(arg as Parameters<typeof engine.section>[0]);
      case 'pin':
        return engine.pin(arg as Parameters<typeof engine.pin>[0]);
    }
  };
  run().then(
    (value) => {
      scope.postMessage({ id, ok: true, value });
    },
    (err: unknown) => {
      scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    },
  );
};
