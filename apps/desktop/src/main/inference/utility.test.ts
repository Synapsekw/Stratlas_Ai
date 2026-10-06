import { describe, expect, it } from 'vitest';
import type { OrtSession, OrtTensor } from '../maskAssist';
import { markerCard, markerDetectorOnnx } from './fixtures/markerDetector';
import { createInferenceHost, remoteOrt, type ChildLike } from './utility';
import {
  createWorkerCore,
  preferredProvider,
  type FromWorker,
  type OrtNodeLike,
  type ToWorker,
} from './worker';

/** A stand-in runtime: every session answers one marker box at (100, 100), 20 x 20. */
function fakeOrt(opts: { failDml?: boolean; failAll?: string } = {}) {
  const created: { path: string; providers: string[] }[] = [];
  const ort: OrtNodeLike = {
    listSupportedBackends: () => [{ name: 'cpu' }, { name: 'dml' }],
    env: { versions: { node: '9.9.9' } },
    Tensor: class {
      constructor(
        readonly type: 'float32',
        readonly data: Float32Array,
        readonly dims: readonly number[],
      ) {}
    },
    InferenceSession: {
      create(path, options) {
        const providers = options?.executionProviders ?? [];
        created.push({ path: String(path), providers });
        if (opts.failAll) return Promise.reject(new Error(opts.failAll));
        if (opts.failDml && providers.includes('dml'))
          return Promise.reject(new Error('DirectML device lost'));
        const session: OrtSession = {
          inputNames: ['images'],
          outputNames: ['output0'],
          run: (feeds: Record<string, OrtTensor>) => {
            const input = feeds.images;
            if (!input) return Promise.reject(new Error('no input'));
            // [1, 6, 1]: cx, cy, w, h, marker, cyan
            const data = Float32Array.from([110, 110, 20, 20, 0.9, 0.1]);
            return Promise.resolve({ output0: { data, dims: [1, 6, 1] } });
          },
        };
        return Promise.resolve(session);
      },
    },
  };
  return { ort, created };
}

/** A child that runs the worker core in this process, like the utility process would. */
function inProcessChild(core: ReturnType<typeof createWorkerCore>) {
  let onMessage: (m: FromWorker) => void = () => undefined;
  let onExit: (c: number | null) => void = () => undefined;
  const sent: ToWorker[] = [];
  const child: ChildLike & { crash(): void; sent: ToWorker[] } = {
    sent,
    postMessage(m) {
      sent.push(m);
      void core.handle(m).then((r) => {
        onMessage(r);
      });
    },
    onMessage(fn) {
      onMessage = fn;
    },
    onExit(fn) {
      onExit = fn;
    },
    kill() {
      onExit(null);
    },
    crash() {
      onExit(3);
    },
  };
  return child;
}

const card = markerCard(markerDetectorOnnx());
const image = { width: 320, height: 320, rgba: new Uint8Array(320 * 320 * 4) };

describe('execution provider choice', () => {
  it('prefers DirectML on Windows, CoreML on macOS, else CPU', () => {
    expect(preferredProvider('auto', 'win32', ['cpu', 'dml'])).toBe('dml');
    expect(preferredProvider('auto', 'darwin', ['cpu', 'coreml'])).toBe('coreml');
    expect(preferredProvider('auto', 'linux', ['cpu'])).toBe('cpu');
    expect(preferredProvider('auto', 'win32', ['cpu'])).toBe('cpu');
    expect(preferredProvider('cpu', 'win32', ['cpu', 'dml'])).toBe('cpu');
  });
});

describe('utility process protocol (fake runtime)', () => {
  it('probes the runtime, opens a session once and detects', async () => {
    const fake = fakeOrt();
    const host = createInferenceHost(() =>
      inProcessChild(createWorkerCore(() => Promise.resolve(fake.ort), 'win32')),
    );
    expect(await host.probe('auto')).toEqual({
      available: true,
      provider: 'dml',
      version: '9.9.9',
      backends: ['cpu', 'dml'],
    });
    const a = await host.open('C:/m/model.onnx', 'auto');
    const b = await host.open('C:/m/model.onnx', 'auto');
    expect(a).toEqual(b);
    expect(a.provider).toBe('dml');
    expect(fake.created).toEqual([{ path: 'C:/m/model.onnx', providers: ['dml', 'cpu'] }]);
    const boxes = await host.detect({ session: a.session, image, card, minConfidence: 0.5 });
    expect(boxes).toEqual([
      { x0: 100, y0: 100, x1: 120, y1: 120, score: expect.any(Number) as number, cls: 0 },
    ]);
  });

  it('knows the last probe without starting the process', async () => {
    let spawned = 0;
    const host = createInferenceHost(() => {
      spawned++;
      return inProcessChild(createWorkerCore(() => Promise.resolve(fakeOrt().ort), 'win32'));
    });
    expect(host.known()).toEqual({ running: false, probe: null });
    expect(spawned).toBe(0);
    await host.probe('cpu');
    expect(host.known()).toEqual({
      running: true,
      probe: { available: true, provider: 'cpu', version: '9.9.9', backends: ['cpu', 'dml'] },
    });
    host.dispose();
    expect(host.known().running).toBe(false);
    expect(host.known().probe?.version).toBe('9.9.9');
    expect(spawned).toBe(1);
  });

  it('falls back to CPU when DirectML refuses the model', async () => {
    const fake = fakeOrt({ failDml: true });
    const host = createInferenceHost(() =>
      inProcessChild(createWorkerCore(() => Promise.resolve(fake.ort), 'win32')),
    );
    expect((await host.open('m.onnx', 'auto')).provider).toBe('cpu');
  });

  it('reports a missing runtime and a model that cannot load, with the exact reason', async () => {
    const none = createInferenceHost(() =>
      inProcessChild(createWorkerCore(() => Promise.resolve(null), 'win32')),
    );
    expect(await none.probe('auto')).toEqual({
      available: false,
      problem: 'The ONNX runtime is not installed in this build.',
    });
    const broken = createInferenceHost(() =>
      inProcessChild(
        createWorkerCore(() =>
          Promise.resolve(fakeOrt({ failAll: 'protobuf parsing failed' }).ort),
        ),
      ),
    );
    await expect(broken.open('bad.onnx', 'cpu')).rejects.toThrow(
      'The model could not be loaded: protobuf parsing failed',
    );
  });

  it('fails requests in flight when the process dies, then starts it again', async () => {
    const fake = fakeOrt();
    const children: ReturnType<typeof inProcessChild>[] = [];
    const host = createInferenceHost(() => {
      const c = inProcessChild(createWorkerCore(() => Promise.resolve(fake.ort)));
      // the first child never answers: it dies instead
      if (children.length === 0) c.postMessage = (m) => void c.sent.push(m);
      children.push(c);
      return c;
    });
    const p = host.probe('cpu');
    children[0]?.crash();
    await expect(p).rejects.toThrow('The detection process stopped unexpectedly (code 3)');
    expect((await host.probe('cpu')).available).toBe(true);
    expect(children).toHaveLength(2);
  });

  it('gives mask assist a remote OrtLike whose sessions run in the process', async () => {
    const fake = fakeOrt();
    const host = createInferenceHost(() =>
      inProcessChild(createWorkerCore(() => Promise.resolve(fake.ort))),
    );
    const ort = remoteOrt(host, () => 'cpu');
    const s = await ort.InferenceSession.create('sam/encoder.onnx');
    expect(s.inputNames).toEqual(['images']);
    const out = await s.run({ images: new ort.Tensor('float32', new Float32Array(3), [1, 3]) });
    expect(out.output0?.dims).toEqual([1, 6, 1]);
  });
});
