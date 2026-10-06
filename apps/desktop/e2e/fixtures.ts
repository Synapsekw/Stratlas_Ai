/**
 * Shared Playwright fixtures for the Electron e2e suite.
 *
 * - `dataRoot`: a temporary data root holding one tiny synthetic native project
 *   (`projects/e2e-tiny/` with a schema-valid manifest.json, a 1 x 1 m quad GLB and an empty
 *   issues.json). Deleted after the test.
 * - `app` / `win`: the built app (`out/main/index.js`) launched with STRATLAS_DATA pointing at
 *   `dataRoot.root` and STRATLAS_USER_DATA at a throwaway profile, with the zero-network guard
 *   attached and a Playwright trace kept on failure.
 * - `network`: the zero-network guard. Every test that uses `app` or `win` fails if the app
 *   made any request outside `ALLOWED_PROTOCOLS`, from the renderer or from the main process.
 *
 * Usage in a spec:
 *   import { expect, test } from './fixtures';
 *   test('does a thing', async ({ win }) => { ... });
 */
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { expect };

/** Schemes the app may load. Anything else (http, https, ws, ftp, ...) is a network request. */
export const ALLOWED_PROTOCOLS = [
  'file:',
  'aio:',
  'devtools:',
  'data:',
  'blob:',
  'chrome-extension:',
];

export const MAIN_ENTRY = join(import.meta.dirname, '../out/main/index.js');
const GUARD = join(import.meta.dirname, 'network-guard.cjs');

/**
 * Chromium switches for every launch. STRATLAS_E2E_SWGL=1 draws with SwiftShader, the software
 * GPU the CI runners fall back to, so a difference that depends on the GPU (the detected
 * graphics tier, timing of a slow frame) shows up on a workstation as well.
 */
export const GPU_ARGS =
  process.env.STRATLAS_E2E_SWGL === '1'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : [];

export const TINY_PROJECT_ID = 'e2e-tiny';

/** Chromium switches that force the software GPU (SwiftShader), which the app runs on Low. */
export const SOFTWARE_GPU = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Manifest of the synthetic project, validated against the frozen contract. */
export function tinyManifest(): ProjectManifest {
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: TINY_PROJECT_ID,
    name: 'E2E tiny project',
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [{ id: 'capture-1', label: 'Synthetic capture', date: '2026-01-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        src: { path: 'models/quad.glb' },
        transform: IDENTITY,
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  return ProjectManifest.parse(input);
}

/** A valid glTF 2.0 binary: one 1 x 1 m quad on the ground plane (Y up), facing up. */
export function tinyGlb(): Buffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = {
    asset: { version: '2.0', generator: 'aio e2e fixtures' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'quad' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: indices.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [0, 0, -1],
        max: [1, 0, 0],
      },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const body = pad(bin, 0);
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(json, 0x4e4f534a), chunk(body, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}

export interface DataRoot {
  /** Temporary folder holding `data/` and `user/`; removed after the test. */
  base: string;
  /** Value for STRATLAS_DATA. */
  root: string;
  /** Value for STRATLAS_USER_DATA, so settings and library.json never touch the real profile. */
  userData: string;
  projectId: string;
  projectDir: string;
}

/** Create `<tmp>/data/projects/e2e-tiny/` (manifest.json, models/quad.glb, issues.json). */
export async function createDataRoot(): Promise<DataRoot> {
  const base = await mkdtemp(join(tmpdir(), 'aio-e2e-'));
  const root = join(base, 'data');
  const userData = join(base, 'user');
  await mkdir(userData, { recursive: true });
  const projectDir = join(root, 'projects', TINY_PROJECT_ID);
  await mkdir(join(projectDir, 'models'), { recursive: true });
  await mkdir(join(root, 'packs'), { recursive: true });
  await writeFile(join(projectDir, 'manifest.json'), JSON.stringify(tinyManifest(), null, 2));
  await writeFile(join(projectDir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(projectDir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  return { base, root, userData, projectId: TINY_PROJECT_ID, projectDir };
}

/** Collects outbound requests from the renderer (Playwright) and the main process (guard). */
export class NetworkGuard {
  private readonly renderer: string[] = [];
  private app: ElectronApplication | undefined;
  /**
   * @param allow Loopback origins (`http://127.0.0.1:<port>`) a test serves itself and lets the
   *   main process reach, e.g. the map pack download test. Pass the same list to `launchApp` as
   *   `AIO_NETWORK_GUARD_ALLOW`. Anything else stays blocked and fails the test.
   */
  constructor(private readonly allow: readonly string[] = []) {
    for (const origin of allow) {
      const u = new URL(origin);
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
        throw new Error(`The zero-network guard only allows loopback origins, not ${origin}`);
    }
  }

  async attach(app: ElectronApplication): Promise<void> {
    this.app = app;
    const context = app.context();
    context.on('request', (req) => {
      const url = req.url();
      if (!ALLOWED_PROTOCOLS.includes(new URL(url).protocol)) this.renderer.push(url);
    });
    // Fail network requests instead of letting them reach the internet.
    await context.route(/^(https?|wss?|ftp):/i, (route) => route.abort('internetdisconnected'));
    // Electron's own net module bypasses Node, so guard it in main as well.
    await app.evaluate(({ net, session }, allow) => {
      const log = (globalThis as { __aioNetworkLog?: string[] }).__aioNetworkLog;
      const passed = (globalThis as { __aioNetworkAllowed?: string[] }).__aioNetworkAllowed;
      if (!log || !passed) throw new Error('network-guard.cjs did not load in the main process');
      const block = (target: string) => {
        log.push(target);
        return new Error(`Network access blocked by the e2e zero-network guard: ${target}`);
      };
      const allowed = (url: string) => {
        try {
          return allow.includes(new URL(url).origin);
        } catch {
          return false;
        }
      };
      const originalFetch = net.fetch.bind(net);
      // net.fetch goes through net.request, so both pass the allowed origins.
      const originalRequest = net.request.bind(net);
      net.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
        if (allowed(url)) {
          passed.push(url);
          return originalFetch(input, init);
        }
        return Promise.reject(block(url));
      };
      net.request = (options) => {
        const url = typeof options === 'string' ? options : (options.url ?? 'net.request');
        if (allowed(url)) return originalRequest(options);
        throw block(url);
      };
      // Every session's fetch (the map downloads use their own session).
      const proto = Object.getPrototypeOf(session.defaultSession) as {
        fetch: (this: unknown, input: string | Request, init?: RequestInit) => Promise<Response>;
      };
      const sessionFetch = proto.fetch;
      proto.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input.url;
        if (allowed(url)) {
          passed.push(url);
          return sessionFetch.call(this, input, init);
        }
        return Promise.reject(block(url));
      };
    }, this.allow);
  }

  /** Requests let through to the allowed loopback origins, in order. */
  async allowed(): Promise<string[]> {
    return this.app
      ? this.app.evaluate(
          () =>
            (globalThis as { __aioNetworkAllowed?: string[] }).__aioNetworkAllowed?.slice() ?? [],
        )
      : [];
  }

  /** Outbound requests so far, renderer and main, without clearing them. */
  async outbound(): Promise<string[]> {
    const main = this.app
      ? await this.app.evaluate(
          () => (globalThis as { __aioNetworkLog?: string[] }).__aioNetworkLog?.slice() ?? [],
        )
      : [];
    return [...this.renderer, ...main];
  }

  /** Return and clear the recorded requests, for tests that provoke one on purpose. */
  async drain(): Promise<string[]> {
    const all = await this.outbound();
    this.renderer.length = 0;
    await this.app?.evaluate(() => {
      (globalThis as { __aioNetworkLog?: string[] }).__aioNetworkLog?.splice(0);
    });
    return all;
  }
}

/** Launch the built app against `dataRoot` with the main-process network guard preloaded. */
export async function launchApp(
  dataRoot: DataRoot,
  env: Record<string, string> = {},
  /** Arguments after the app entry, e.g. a double-clicked `.aio` path. */
  extraArgs: string[] = [],
): Promise<ElectronApplication> {
  return electron.launch({
    // `-r` preloads the guard before the app's main module (Playwright drops NODE_OPTIONS).
    args: [...GPU_ARGS, '-r', GUARD, MAIN_ENTRY, ...extraArgs],
    env: {
      ...(process.env as Record<string, string>),
      STRATLAS_DATA: dataRoot.root,
      STRATLAS_USER_DATA: dataRoot.userData,
      ...env,
    },
  });
}

interface Fixtures {
  dataRoot: DataRoot;
  network: NetworkGuard;
  app: ElectronApplication;
  win: Page;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  dataRoot: async ({}, use) => {
    const data = await createDataRoot();
    await use(data);
    await rm(data.base, { recursive: true, force: true });
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  network: async ({}, use) => {
    await use(new NetworkGuard());
  },

  app: async ({ dataRoot, network }, use, testInfo) => {
    const app = await launchApp(dataRoot);
    await network.attach(app);
    const tracing = app.context().tracing;
    await tracing.start({ screenshots: true, snapshots: true });
    let outbound: string[] = [];
    try {
      await use(app);
      outbound = await network.outbound();
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus || outbound.length > 0;
      await tracing
        .stop(failed ? { path: testInfo.outputPath('trace.zip') } : {})
        .catch(() => undefined);
      await app.close();
    }
    // Zero-network assertion for every test that runs the app.
    expect(outbound, 'the app made network requests').toEqual([]);
  },

  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});
