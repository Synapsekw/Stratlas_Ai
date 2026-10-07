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
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNotRealData,
  copyRealProjects,
  REAL_DATA_ROOT,
  REALDATA,
  type RealCopyOptions,
  type RealDataCopy,
} from './realData';

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

/** Writes the app's real-data guard refused so far (`src/main/realDataGuard.ts`). */
export async function realDataRefusals(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () =>
      (
        globalThis as { __stratlasRealDataRefusals?: string[] }
      ).__stratlasRealDataRefusals?.slice() ?? [],
  );
}

/**
 * Launch the built app against `dataRoot` with the main-process network guard preloaded.
 *
 * Refuses a data root (or profile) inside the founder's real data (`realData.ts`): real projects
 * are copied first (`copyRealProjects`, `realProject`). The app runs with STRATLAS_E2E=1, so its
 * own guard refuses any write under STRATLAS_REAL_DATA_ROOT; `app.close()` then throws when it
 * refused one, failing the test even if the app swallowed the error.
 */
export async function launchApp(
  dataRoot: DataRoot,
  env: Record<string, string> = {},
  /** Arguments after the app entry, e.g. a double-clicked `.aio` path. */
  extraArgs: string[] = [],
): Promise<ElectronApplication> {
  assertNotRealData(env.STRATLAS_DATA ?? dataRoot.root, 'The e2e data root');
  assertNotRealData(env.STRATLAS_USER_DATA ?? dataRoot.userData, 'The e2e profile');
  const app = await electron.launch({
    // `-r` preloads the guard before the app's main module (Playwright drops NODE_OPTIONS).
    args: [...GPU_ARGS, '-r', GUARD, MAIN_ENTRY, ...extraArgs],
    env: {
      ...(process.env as Record<string, string>),
      STRATLAS_E2E: '1',
      STRATLAS_REAL_DATA_ROOT: REAL_DATA_ROOT,
      STRATLAS_DATA: dataRoot.root,
      STRATLAS_USER_DATA: dataRoot.userData,
      ...env,
    },
  });
  const close = app.close.bind(app);
  app.close = async () => {
    const refused = await realDataRefusals(app).catch(() => []);
    await close();
    // fails the running test even where a spec ignores errors of close()
    if (refused.length > 0)
      try {
        expect.soft(refused, 'the app tried to write into the real data').toEqual([]);
      } catch {
        // not inside a test: the throw below says it
      }
    if (refused.length > 0)
      throw new Error(`The app tried to write into the real data:\n${refused.join('\n')}`);
  };
  return app;
}

// ---------------------------------------------------------------- M8: two dates and the change demo

export const TWO_DATE_PROJECT_ID = 'e2e-two-dates';

/** A small two-date project in the data root (see `twoDateProject`). */
export interface TwoDateProject {
  id: string;
  dir: string;
  /** Capture ids, earlier first. */
  captures: [string, string];
}

/**
 * Write `projects/e2e-two-dates/` into `dataRoot`: captures `c1` (2026-03-02) and `c2`
 * (2026-04-13), a 1 m quad model per date (`quad-c1`; `quad-c2` moved 2 m east), a map vector
 * layer per date (`site-c2` adds a track `TR-2`), and one issue per date at the same place
 * (`c2` area grown from 0.4 to 0.6 m2). Every layer and issue names its capture.
 */
export async function createTwoDateProject(dataRoot: DataRoot): Promise<TwoDateProject> {
  const id = TWO_DATE_PROJECT_ID;
  const dir = join(dataRoot.root, 'projects', id);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'vectors'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  const line = (coords: [number, number][], fid: string, name: string) => ({
    type: 'Feature',
    id: fid,
    properties: { id: fid, name },
    geometry: { type: 'LineString', coordinates: coords },
  });
  const track: [number, number][] = [
    [51.0, 28.92],
    [51.0005, 28.92],
  ];
  const spur: [number, number][] = [
    [51.0005, 28.92],
    [51.0005, 28.9205],
  ];
  await writeFile(
    join(dir, 'vectors', 'site-c1.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: [line(track, 'TR-1', 'Track')] }),
  );
  await writeFile(
    join(dir, 'vectors', 'site-c2.geojson'),
    JSON.stringify({
      type: 'FeatureCollection',
      features: [line(track, 'TR-1', 'Track'), line(spur, 'TR-2', 'New track')],
    }),
  );
  const moved = [...IDENTITY];
  moved[12] = 2;
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id,
    name: 'E2E two dates',
    customer: 'E2E',
    site: 'Synthetic site, 2 dates',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [
      { id: 'c1', label: 'Survey 2 March 2026', date: '2026-03-02' },
      { id: 'c2', label: 'Survey 13 April 2026', date: '2026-04-13' },
    ],
    layers: [
      {
        kind: 'mesh',
        id: 'quad-c1',
        name: 'Quad 2026-03-02',
        capture: 'c1',
        src: { path: 'models/quad.glb' },
        transform: IDENTITY,
      },
      {
        kind: 'mesh',
        id: 'quad-c2',
        name: 'Quad 2026-04-13',
        capture: 'c2',
        src: { path: 'models/quad.glb' },
        transform: moved,
      },
      {
        kind: 'vector',
        id: 'site-c1',
        name: 'Site 2026-03-02',
        capture: 'c1',
        src: { path: 'vectors/site-c1.geojson' },
        format: 'geojson',
      },
      {
        kind: 'vector',
        id: 'site-c2',
        name: 'Site 2026-04-13',
        capture: 'c2',
        src: { path: 'vectors/site-c2.geojson' },
        format: 'geojson',
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  const issue = (capture: string, code: string, area: number, layer: string) => ({
    id: `${capture}-${code.toLowerCase()}`,
    code,
    classId: 'damage',
    severityModelId: 'none',
    severity: 'uncertain',
    status: 'reviewed',
    title: 'Damage on the quad',
    note: '',
    author: 'E2E',
    createdAt: `2026-0${capture === 'c1' ? '3-02' : '4-13'}T10:00:00.000Z`,
    updatedAt: `2026-0${capture === 'c1' ? '3-02' : '4-13'}T10:00:00.000Z`,
    sightings: [{ on: 'mesh', layer, geom: { type: 'spoint', p: [0.5, 0, -0.5], n: [0, 1, 0] } }],
    measurements: [{ kind: 'area', value: area, unit: 'm2' }],
    source: 'human',
    capture,
  });
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify(
      {
        schema: 'aio.issues/1',
        issues: [issue('c1', 'F01', 0.4, 'quad-c1'), issue('c2', 'F11', 0.6, 'quad-c2')],
      },
      null,
      2,
    ),
  );
  return { id, dir, captures: ['c1', 'c2'] };
}

export const THREE_DATE_PROJECT_ID = 'e2e-three-dates';

/**
 * Write `projects/e2e-three-dates/` into `dataRoot`: three surveys (4 Sep, 2 Oct and 6 Nov 2024;
 * captures `sep`, `oct`, `nov`), a model (`quad-<id>`) and a site outline (`site-<id>`) per date,
 * and one undated layer (`design`). Meshes and vectors only, no media files.
 */
export async function createThreeDateProject(dataRoot: DataRoot): Promise<{ id: string }> {
  const id = THREE_DATE_PROJECT_ID;
  const dir = join(dataRoot.root, 'projects', id);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'vectors'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  const outline = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'B',
        properties: { id: 'B', name: 'Boundary' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [51.0, 28.92],
            [51.0005, 28.92],
          ],
        },
      },
    ],
  });
  const dates = [
    { id: 'sep', date: '2024-09-04' },
    { id: 'oct', date: '2024-10-02' },
    { id: 'nov', date: '2024-11-06' },
  ];
  for (const d of dates) await writeFile(join(dir, 'vectors', `site-${d.id}.geojson`), outline);
  await writeFile(join(dir, 'vectors', 'design.geojson'), outline);
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id,
    name: 'E2E three dates',
    customer: 'E2E',
    site: 'Synthetic site, 3 dates',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: dates.map((d) => ({ id: d.id, label: `Survey ${d.date}`, date: d.date })),
    layers: [
      ...dates.flatMap((d) => [
        {
          kind: 'mesh' as const,
          id: `quad-${d.id}`,
          name: `Quad ${d.date}`,
          capture: d.id,
          src: { path: 'models/quad.glb' },
          transform: IDENTITY,
        },
        {
          kind: 'vector' as const,
          id: `site-${d.id}`,
          name: `Site ${d.date}`,
          capture: d.id,
          src: { path: `vectors/site-${d.id}.geojson` },
          format: 'geojson' as const,
        },
      ]),
      {
        kind: 'vector' as const,
        id: 'design',
        name: 'Design outline',
        src: { path: 'vectors/design.geojson' },
        format: 'geojson' as const,
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  return { id };
}

/**
 * The bundled demo folder (`pnpm demo:build --quick`, or only `pnpm demo:change --quick` for the
 * change demo), or STRATLAS_E2E_DEMO.
 */
export const DEMO_FOLDER = process.env.STRATLAS_E2E_DEMO ?? join(import.meta.dirname, '..', 'demo');
/** The change and modelling demo (M8, tools/demo/build-change-demo.mjs). */
export const CHANGE_DEMO = { id: 'demo-change-site', name: 'Demo change site (2 dates)' };

export const hasChangeDemo = (): boolean =>
  existsSync(join(DEMO_FOLDER, CHANGE_DEMO.id, 'truth.json'));

/**
 * `truth.json` of the change demo: every seeded change per layer type with counts and places
 * (`changes.component`, `.surface`, `.cloud`, `.raster`, `.issue`, `.detection`, `.vector`,
 * `.frame`), the modelling inputs (`modelling.drawing`, `modelling.scan`), the test detector
 * (`detector`) and the markers it should find (`markers.photos`).
 */
export interface ChangeDemoTruth {
  schema: 'aio.truth/1';
  project: string;
  captures: { from: string; to: string };
  layers: Record<string, Record<string, string | number>>;
  sources: Record<string, string>;
  changes: Record<string, { verdicts?: Record<string, number> } & Record<string, unknown>>;
  modelling: Record<string, Record<string, unknown>>;
  detector: { model: string; card: string; sha256: string; classes: string[] };
  markers: { photos: Record<string, Record<string, { marker: string; bbox: number[] }[]>> };
  counts: {
    layers: number;
    issues: { d1: number; d2: number };
    photos: { d1: number; d2: number };
    videoFrames: number;
  };
}

export function changeDemoTruth(): ChangeDemoTruth {
  return JSON.parse(
    readFileSync(join(DEMO_FOLDER, CHANGE_DEMO.id, 'truth.json'), 'utf8'),
  ) as ChangeDemoTruth;
}

interface WorkspaceProbe {
  __stratlas: {
    workspace: { getState(): { project: { root: string; manifest: { id: string } } | null } };
  };
}

/** The open project's id and folder, or nulls. */
export async function openProject(win: Page): Promise<{ id: string | null; root: string | null }> {
  return win.evaluate(() => {
    const p = (window as unknown as WorkspaceProbe).__stratlas.workspace.getState().project;
    return { id: p?.manifest.id ?? null, root: p?.root ?? null };
  });
}

/**
 * Open the change demo from the library of an app launched with STRATLAS_DEMO (the `demoProject`
 * fixture does this). Returns the working copy's folder (userData `demo/demo-change-site`).
 */
export async function openChangeDemo(win: Page): Promise<{ root: string }> {
  const card = win.getByTestId('project-card').filter({ hasText: CHANGE_DEMO.name });
  if (
    !(await card
      .first()
      .isVisible()
      .catch(() => false))
  )
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await card.first().click();
  await expect
    .poll(async () => (await openProject(win)).id, { timeout: 60_000 })
    .toBe(CHANGE_DEMO.id);
  return { root: (await openProject(win)).root ?? '' };
}

/** What the `demoProject` fixture hands a test: the app with the change demo open. */
export interface DemoProject {
  app: ElectronApplication;
  win: Page;
  /** The working copy that is open (never the bundled folder). */
  root: string;
  truth: ChangeDemoTruth;
  network: NetworkGuard;
}

/**
 * The development pipeline runtime for specs that run pipeline jobs: the venv Python
 * (`uv sync` in python/, or STRATLAS_E2E_PYTHON) and PDAL (AIO_PDAL, else the workstation's
 * install). Pass `PIPELINE_ENV` as `appEnv` and skip with `hasPipelinePython` / `hasPdal`.
 */
const REPO = join(import.meta.dirname, '..', '..', '..');
export const VENV_PYTHON =
  process.env.STRATLAS_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(REPO, 'python', '.venv', 'Scripts', 'python.exe')
    : join(REPO, 'python', '.venv', 'bin', 'python'));
export const PDAL =
  process.env.AIO_PDAL ??
  (process.platform === 'win32' ? 'E:/Dev/tools/pdal/Library/bin/pdal.exe' : '/usr/bin/pdal');
export const hasPipelinePython = (): boolean => existsSync(VENV_PYTHON);
export const hasPdal = (): boolean => existsSync(PDAL);
export const PIPELINE_ENV: Record<string, string> = {
  STRATLAS_PIPELINE_PYTHON: VENV_PYTHON,
  AIO_PDAL: PDAL,
};

interface Fixtures {
  /**
   * Extra environment of the app the `app` and `demoProject` fixtures launch, e.g.
   * `test.use({ appEnv: PIPELINE_ENV })` for specs that run pipeline jobs.
   */
  appEnv: Record<string, string>;
  dataRoot: DataRoot;
  network: NetworkGuard;
  app: ElectronApplication;
  win: Page;
  /** A two-date project written into `dataRoot` before the app starts (list it before `win`). */
  twoDateProject: TwoDateProject;
  /** A three-date project (`e2e-three-dates`) written into `dataRoot` before the app starts. */
  threeDateProject: { id: string };
  /**
   * Its own app with the bundled demos (STRATLAS_DEMO) and the change demo open. Use it instead
   * of `app` and `win`, not with them. Skips the test when the change demo is not built.
   */
  demoProject: DemoProject;
}

export const test = base.extend<Fixtures>({
  appEnv: [{}, { option: true }],

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

  app: async ({ dataRoot, network, appEnv }, use, testInfo) => {
    const app = await launchApp(dataRoot, appEnv);
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

  twoDateProject: async ({ dataRoot }, use) => {
    await use(await createTwoDateProject(dataRoot));
  },

  threeDateProject: async ({ dataRoot }, use) => {
    await use(await createThreeDateProject(dataRoot));
  },

  demoProject: async ({ dataRoot, appEnv }, use, testInfo) => {
    testInfo.skip(
      !hasChangeDemo(),
      `no change demo in ${DEMO_FOLDER}: run pnpm demo:change --quick (or pnpm demo:build --quick)`,
    );
    const network = new NetworkGuard();
    const app = await launchApp(dataRoot, { ...appEnv, STRATLAS_DEMO: DEMO_FOLDER });
    await network.attach(app);
    let outbound: string[];
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      const { root } = await openChangeDemo(win);
      await use({ app, win, root, truth: changeDemoTruth(), network });
      outbound = await network.outbound();
    } finally {
      await app.close();
    }
    expect(outbound, 'the app made network requests').toEqual([]);
  },
});

// ---------------------------------------------------------------- M9 T5: two reviewers

export const TEAM_PROJECT_ID = 'e2e-team';
export const TEAM_PROJECT_NAME = 'E2E team project';

/**
 * A small project two reviewers share: one mesh, a severity model with four levels and two
 * issues (F01 and F02, severity 2). Each reviewer gets their own copy, as from a USB stick.
 */
export async function writeTeamProject(dataRoot: string): Promise<string> {
  const dir = join(dataRoot, 'projects', TEAM_PROJECT_ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  const manifest = ProjectManifest.parse({
    ...tinyManifest(),
    id: TEAM_PROJECT_ID,
    name: TEAM_PROJECT_NAME,
    severityModels: [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
          { value: 2, label: 'Moderate', color: '#f08c3c', criteria: 'Plan' },
          { value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Act' },
          { value: 4, label: 'Critical', color: '#9b1c31', criteria: 'Act now' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'facade',
        classes: [{ id: 'crack', label: 'Crack', color: '#ee3f4b', severityModel: 'sev' }],
      },
    ],
  });
  const issue = (code: string) => ({
    id: code.toLowerCase(),
    code,
    classId: 'crack',
    severityModelId: 'sev',
    severity: 2,
    status: 'draft',
    title: `Crack ${code}`,
    note: '',
    author: 'Rana Example',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    source: 'human',
    sightings: [
      { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [0.5, 0, -0.5], n: [0, 1, 0] } },
    ],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [issue('F01'), issue('F02')] }, null, 2),
  );
  return dir;
}

/** One reviewer: their own app, profile (identity and device key), data root and project copy. */
export interface Reviewer {
  name: string;
  initials: string;
  app: ElectronApplication;
  win: Page;
  dataRoot: DataRoot;
  /** The profile's userData (`<dataRoot.userData>/profiles/<profile>`). */
  userData: string;
  /** Their copy of the team project. */
  project: string;
  /** Their zero-network guard. */
  network: NetworkGuard;
}

export interface TwoReviewers {
  /** Rana Example. */
  a: Reviewer;
  /** Omar Sample. */
  b: Reviewer;
  /** An empty folder both can reach: the "NAS" hub. */
  hub: string;
  /** Where exchange files and identity cards are saved. */
  out: string;
}

/** Options of `launchReviewer`: extra environment and the loopback origins the guard lets through. */
export interface ReviewerOptions {
  env?: Record<string, string>;
  allow?: readonly string[];
}

/**
 * One person on their own isolated profile (`--profile=<profile>`, T2: own userData, own device
 * key in the TEST-ONLY vault file), named through `identity:set` as the Settings screen does, with
 * their own copy of the team project. The window is reloaded so the renderer reads the name.
 */
export async function launchReviewer(
  profile: string,
  name: string,
  initials: string,
  opts: ReviewerOptions = {},
): Promise<Reviewer> {
  const dataRoot = await createDataRoot();
  const project = await writeTeamProject(dataRoot.root);
  const app = await launchApp(dataRoot, opts.env ?? {}, [`--profile=${profile}`]);
  const network = new NetworkGuard(opts.allow ?? []);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const set = await win.evaluate((patch) => window.aio.invoke('identity:set', patch), {
    name,
    initials,
  });
  if (!set.ok) throw new Error(`identity:set failed: ${set.error}`);
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  const userData = join(dataRoot.userData, 'profiles', profile);
  return { name, initials, app, win, dataRoot, userData, project, network };
}

/** Close a reviewer's app and remove their folders (a screenshot first when the test failed). */
export async function closeReviewer(r: Reviewer, failed: boolean, shot?: string): Promise<void> {
  if (failed && shot) await r.win.screenshot({ path: shot }).catch(() => undefined);
  await r.app.close().catch(() => undefined);
  await rm(r.dataRoot.base, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Two instances of the app side by side, each on its own profile (so its own identity and device
 * key) with its own copy of the team project, plus one temp hub folder. Neither is a member of
 * the other's team until a spec adds them (`addMember` in team.ts). Windows stay off-screen like
 * every other launch; both pass the zero-network guard.
 */
export const twoReviewersTest = test.extend<{ twoReviewers: TwoReviewers }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  twoReviewers: async ({}, use, testInfo) => {
    const shared = await mkdtemp(join(tmpdir(), 'aio-e2e-team-'));
    const hub = join(shared, 'hub');
    const out = join(shared, 'out');
    await mkdir(hub, { recursive: true });
    await mkdir(out, { recursive: true });
    const a = await launchReviewer('rana', 'Rana Example', 'RE');
    const b = await launchReviewer('omar', 'Omar Sample', 'OS');
    const guards = [a.network, b.network] as const;
    const outbound: string[] = [];
    try {
      await use({ a, b, hub, out });
      for (const g of guards) outbound.push(...(await g.outbound()));
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      for (const r of [a, b]) {
        await closeReviewer(r, failed, testInfo.outputPath(`${r.name.split(' ')[0] ?? 'app'}.png`));
      }
      await rm(shared, { recursive: true, force: true }).catch(() => undefined);
    }
    expect(outbound, 'the apps made network requests').toEqual([]);
  },
});

// ---------------------------------------------------------------- real client data (@realdata)

/** How `realProject` and `realDataTest` copy the real projects and start the app on the copy. */
export interface RealLaunchOptions extends RealCopyOptions {
  /** Extra environment of the app. */
  env?: Record<string, string>;
  /** Arguments after the app entry. */
  args?: string[];
  /** Content size of the main window, e.g. `[1600, 960]`. */
  size?: [number, number];
}

/** The app started on a temporary copy of real projects (`realProject`). */
export interface RealProject {
  app: ElectronApplication;
  win: Page;
  /** The copy the app runs on. */
  data: RealDataCopy;
  network: NetworkGuard;
  /** Check zero network, close the app (failing on a refused real-data write), delete the copy. */
  close(): Promise<void>;
}

/** Throw unless the running test carries `@realdata` in its title (or a describe's). */
function requireRealDataTag(titlePath: readonly string[]): void {
  if (!titlePath.some((t) => t.includes(REALDATA)))
    throw new Error(
      `"${titlePath.join(' > ')}" uses real client data: put ${REALDATA} in its title (realData.ts)`,
    );
}

async function sizeWindow(app: ElectronApplication, size: [number, number] | undefined) {
  if (size)
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(w, h);
    }, size);
}

/**
 * The one way a spec runs the app on real client data: copy the real projects `ids` (and
 * `opts.packs`) to a temp data root (`copyRealProjects`), launch the app on the copy with the
 * zero-network guard, and on `close()` delete the copy. The real folder is never the app's data
 * root. Skip on `hasRealProject` first; tag the test `@realdata`.
 */
export async function realProject(
  ids: string | readonly string[],
  opts: RealLaunchOptions = {},
): Promise<RealProject> {
  requireRealDataTag(base.info().titlePath);
  const data = await copyRealProjects(typeof ids === 'string' ? [ids] : ids, opts);
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(data, opts.env ?? {}, opts.args ?? []);
    const network = new NetworkGuard();
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await sizeWindow(app, opts.size);
    const running = app;
    return {
      app: running,
      win,
      data,
      network,
      close: async () => {
        let outbound: string[];
        try {
          outbound = await network.outbound();
        } finally {
          try {
            await running.close();
          } finally {
            await data.dispose();
          }
        }
        expect(outbound, 'the app made network requests').toEqual([]);
      },
    };
  } catch (e) {
    await app?.close().catch(() => undefined);
    await data.dispose();
    throw e;
  }
}

interface RealFixtures {
  /** The real projects to copy; `test.use({ realProjects: ['hcl'] })` narrows it per describe. */
  realProjects: string[];
  /** The temp data root with the copies (deleted after the test). */
  realData: RealDataCopy;
  network: NetworkGuard;
  app: ElectronApplication;
  win: Page;
}

/**
 * A test whose `app` and `win` run on a fresh copy of the real projects `ids` (see `realProject`),
 * with the zero-network guard and a trace on failure. Skip with `hasRealProject` in the spec.
 */
export function realDataTest(ids: readonly string[], opts: RealLaunchOptions = {}) {
  return base.extend<RealFixtures>({
    realProjects: [[...ids], { option: true }],

    realData: async ({ realProjects }, use, testInfo) => {
      requireRealDataTag(testInfo.titlePath);
      const data = await copyRealProjects(realProjects, opts);
      try {
        await use(data);
      } finally {
        await data.dispose();
      }
    },

    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
    network: async ({}, use) => {
      await use(new NetworkGuard());
    },

    app: async ({ realData, network }, use, testInfo) => {
      const app = await launchApp(realData, opts.env ?? {}, opts.args ?? []);
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
      expect(outbound, 'the app made network requests').toEqual([]);
    },

    win: async ({ app }, use) => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      await sizeWindow(app, opts.size);
      await use(win);
    },
  });
}
