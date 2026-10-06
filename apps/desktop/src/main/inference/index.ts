/**
 * Local ONNX detection (M8 stream C6, BLD-10): `inference:models|importModel|removeModel|run|cancel`
 * and the `inference:progress` event. onnxruntime-node runs in a utility process. C0 stubs: every
 * channel answers "not available yet" until C6 fills it.
 */
import { notYet, type Handle } from '../notYet';

export interface InferenceIpcDeps {
  handle: Handle;
}

export function registerInferenceIpc({ handle }: InferenceIpcDeps): void {
  const what = 'Local detection';
  handle('inference:models', () => ({
    runtime: { available: false, problem: notYet(what).error },
    models: [],
  }));
  handle('inference:importModel', () => notYet(what));
  handle('inference:removeModel', () => notYet(what));
  handle('inference:run', () => notYet(what));
  handle('inference:cancel', () => ({ ok: false }));
}
