// Entry of the inference utility process (Electron utilityProcess, `inferenceWorker.js`). It loads
// onnxruntime-node on first use and answers main's messages (worker.ts). One process for the app.
import { createWorkerCore, type OrtNodeLike, type ToWorker } from './worker';

const port = process.parentPort;

const core = createWorkerCore(async () => {
  const spec = 'onnxruntime-node';
  const mod = (await import(/* @vite-ignore */ spec)) as {
    default?: unknown;
  } & Partial<OrtNodeLike>;
  const ort = (mod.InferenceSession ? mod : mod.default) as Partial<OrtNodeLike> | undefined;
  return ort?.InferenceSession && ort.Tensor ? (ort as OrtNodeLike) : null;
});

port.on('message', (e) => {
  void core.handle(e.data as ToWorker).then((reply) => {
    port.postMessage(reply);
  });
});
