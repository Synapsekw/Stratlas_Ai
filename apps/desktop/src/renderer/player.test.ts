import type { IpcChannel, PackageInfo, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import type { Bridge, Res } from './bridge';
import { cloudAiBlocked, exportAllowed, welcomeTips } from './player';
import { createShellStore } from './store';

type Handlers = Partial<Record<IpcChannel, (req: unknown) => unknown>>;

function fakeBridge(handlers: Handlers) {
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: Bridge = {
    call: (channel, req) => {
      calls.push({ channel, req });
      const h = handlers[channel];
      if (!h) return Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>);
      return Promise.resolve({ ok: true, value: h(req) } as Res<never>);
    },
  };
  return { bridge, calls };
}

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'hcl',
  name: 'HCl Tank',
  customer: 'KOC',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [{ id: 'c', label: 'Survey', date: '2023-11-22' }],
  layers: [
    {
      kind: 'mesh',
      id: 'tank',
      name: 'Tank',
      visible: true,
      src: { path: 'models/tank.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
  severityModels: [],
  classCatalogues: [],
};

const pkg = (readOnly: boolean, aiPolicy: 'forbid' | 'allow' = 'forbid'): PackageInfo => ({
  file: 'D:\\hcl.aio',
  encrypted: false,
  sizeBytes: 1000,
  header: {
    schema: 'aio.package/1',
    projectId: 'hcl',
    createdAt: '2026-10-04T08:00:00Z',
    readOnly,
    aiPolicy,
    exports: ['issues-csv'],
    excludedLayers: [],
  },
});

function setup(open: (req: unknown) => unknown) {
  const { bridge, calls } = fakeBridge({ 'project:open': open });
  const readOnly: boolean[] = [];
  const s = createShellStore(bridge, createWorkspace(), {
    onReadOnly: (on) => readOnly.push(on),
  });
  return { s, calls, readOnly };
}

describe('player mode', () => {
  it('opens a read-only package on the customer welcome screen with editing off', async () => {
    const { s, readOnly } = setup(() => ({
      ok: true,
      id: 'hcl',
      root: 'D:\\hcl.aio',
      manifest,
      issues: [],
      package: pkg(true),
    }));
    await s.getState().openProject('D:\\hcl.aio');
    expect(s.getState().pkg?.header.readOnly).toBe(true);
    expect(s.getState().screen).toBe('welcome');
    expect(s.getState().annotating).toBe(false);
    expect(readOnly).toEqual([true]);
  });

  it('asks for the passphrase, then opens with it', async () => {
    let n = 0;
    const { s, calls } = setup(() =>
      n++ === 0
        ? { ok: false, error: 'hcl.aio is encrypted.', needsPassphrase: true }
        : { ok: true, id: 'hcl', root: 'D:\\hcl.aio', manifest, issues: [], package: pkg(true) },
    );
    await s.getState().openProject('D:\\hcl.aio');
    expect(s.getState().unlock).toEqual({ path: 'D:\\hcl.aio', error: 'hcl.aio is encrypted.' });
    expect(s.getState().openError).toBeNull();
    await s.getState().openProject('D:\\hcl.aio', 'correct horse');
    const opens = calls.filter((c) => c.channel === 'project:open');
    expect(opens.at(-1)?.req).toEqual({ path: 'D:\\hcl.aio', passphrase: 'correct horse' });
    expect(s.getState().unlock).toBeNull();
    expect(s.getState().pkg).not.toBeNull();
  });

  it('turns editing back on for a folder project and when the package closes', async () => {
    let asPackage = true;
    const { s, readOnly } = setup(() => ({
      ok: true,
      id: 'hcl',
      root: 'x',
      manifest,
      issues: [],
      ...(asPackage ? { package: pkg(true) } : {}),
    }));
    await s.getState().openProject('D:\\hcl.aio');
    s.getState().closeProject();
    expect(s.getState().pkg).toBeNull();
    asPackage = false;
    await s.getState().openProject('E:\\hcl');
    expect(readOnly).toEqual([true, false, false]);
    expect(s.getState().screen).toBe('scene');
  });

  it('keeps the annotation tools closed while a read-only package is open', async () => {
    const { s } = setup(() => ({
      ok: true,
      id: 'hcl',
      root: 'x',
      manifest,
      issues: [],
      package: pkg(true),
    }));
    await s.getState().openProject('D:\\hcl.aio');
    s.getState().setAnnotating(true);
    expect(s.getState().annotating).toBe(false);
  });
});

describe('player helpers', () => {
  it('blocks cloud AI for a package that forbids it, whatever the setting', () => {
    expect(cloudAiBlocked(pkg(true, 'forbid'))).toBe(true);
    expect(cloudAiBlocked(pkg(true, 'allow'))).toBe(false);
    expect(cloudAiBlocked(null)).toBe(false);
    expect(exportAllowed(null, 'report-pdf')).toBe(true);
    expect(exportAllowed(pkg(true), 'issues-csv')).toBe(true);
    expect(exportAllowed(pkg(true), 'report-pdf')).toBe(false);
  });

  it('suggests what to try from the layers and issues of the project', () => {
    const tips = welcomeTips(manifest, 3);
    expect(tips.some((t) => t.includes('3D'))).toBe(true);
    expect(tips.some((t) => t.includes('3 issues'))).toBe(true);
    expect(tips.every((t) => !/[\u2013\u2014]/.test(t))).toBe(true);
  });
});
