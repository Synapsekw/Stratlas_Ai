/**
 * Local ONNX detection (M8 stream C6, BLD-10): `inference:models|importModel|removeModel|run|cancel`
 * and the `inference:progress` event. onnxruntime-node runs in a utility process (`utility.ts`,
 * `worker.ts`); `electron.ts` builds the environment main passes in. No detector ships: a person
 * imports one with its model card (data-conventions section 16).
 */
import type { InferenceSettings } from '@aio/schema';
import type { Handle } from '../notYet';
import { findModel, importModel, listModels, removeModel, type ModelDirs } from './models';
import { createRunner, probeWith, type RunDeps } from './run';
import type { InferenceHost } from './utility';

export interface InferenceEnv extends Omit<RunDeps, 'model' | 'provider' | 'host'> {
  /** The person's model folder and the pipeline pack's, if any. */
  dirs(): Promise<ModelDirs>;
  settings(): InferenceSettings | undefined;
  host(): InferenceHost;
}

export interface InferenceIpcDeps {
  handle: Handle;
  env: InferenceEnv;
}

export function registerInferenceIpc({ handle, env }: InferenceIpcDeps): void {
  const provider = () => env.settings()?.provider ?? 'auto';
  const runner = createRunner({
    ...env,
    host: () => env.host(),
    provider,
    model: async (id) => findModel(await env.dirs(), id),
  });

  handle('inference:models', async () => {
    const models = (await listModels(await env.dirs())).map((m) => m.info);
    try {
      const p = await env.host().probe(provider());
      return {
        runtime: {
          available: p.available,
          ...(p.provider ? { provider: p.provider } : {}),
          ...(p.version ? { version: p.version } : {}),
          ...(p.problem ? { problem: p.problem } : {}),
        },
        models,
      };
    } catch (e) {
      return {
        runtime: { available: false, problem: e instanceof Error ? e.message : String(e) },
        models,
      };
    }
  });
  handle('inference:importModel', async (req) =>
    importModel(
      req,
      await env.dirs(),
      probeWith(() => env.host()),
    ),
  );
  handle('inference:removeModel', async ({ id }) => {
    const dirs = await env.dirs();
    const found = await findModel(dirs, id);
    if (found)
      await env
        .host()
        .close(found.onnx)
        .catch(() => undefined);
    return removeModel(dirs, id);
  });
  handle('inference:run', (req) => runner.run(req));
  handle('inference:cancel', ({ runId }) => ({ ok: runner.cancel(runId) }));
}
