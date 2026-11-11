import {
  ADDON_SCHEMA,
  type AddonListResponse,
  type AddonManifest,
  type AddonProgress,
  type AioBridge,
  type IpcChannel,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createAddonsStore, installedOf } from './addonsStore';
import type { Bridge, Res } from './bridge';

const SHA = 'a'.repeat(64);
const manifest = (id: string, version: string): AddonManifest => ({
  schema: ADDON_SCHEMA,
  id,
  name: id === 'ground-classifier' ? 'Ground classifier' : 'Segmentation',
  version,
  kind: id === 'ground-classifier' ? 'point-classifier' : 'segmenter',
  licence: 'Apache-2.0',
  source: 'https://example.org/model-card',
  sizeBytes: 10,
  files: [{ path: 'classifier.json', sizeBytes: 10, sha256: SHA }],
});
const entry = (id: string, version: string) => ({
  manifest: manifest(id, version),
  archive: { url: `${id}-${version}.aioaddon`, sizeBytes: 24 * 1024 * 1024, sha256: SHA },
});

const NONE: AddonListResponse = {
  baseUrl: 'https://addons.example.org/',
  addons: [
    {
      id: 'segmentation',
      kind: 'segmenter',
      installed: null,
      available: entry('segmentation', '1.0.0'),
      update: false,
    },
    {
      id: 'ground-classifier',
      kind: 'point-classifier',
      installed: null,
      available: entry('ground-classifier', '1.0.0'),
      update: false,
    },
  ],
};
const GROUND: AddonListResponse = {
  ...NONE,
  addons: NONE.addons.map((a) =>
    a.id === 'ground-classifier'
      ? { ...a, installed: { manifest: manifest(a.id, '1.0.0'), dir: 'D:\\x', sizeBytes: 10 } }
      : a,
  ),
};

type Handlers = Partial<Record<IpcChannel, (req: unknown) => unknown>>;

function fakeBridge(handlers: Handlers) {
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: Bridge = {
    call: (channel, req) => {
      calls.push({ channel, req });
      const h = handlers[channel];
      return Promise.resolve(
        (h ? { ok: true, value: h(req) } : { ok: false, error: `no ${channel}` }) as Res<never>,
      );
    },
  };
  return { bridge, calls };
}

/** A fake `on` that hands the test the progress listener. */
function events() {
  let listener: ((p: AddonProgress) => void) | null = null;
  const on = ((channel: string, fn: (p: AddonProgress) => void) => {
    if (channel === 'addons:progress') listener = fn;
    return () => undefined;
  }) as unknown as AioBridge['on'];
  return { on, emit: (p: AddonProgress) => listener?.(p) };
}

describe('the add-ons store', () => {
  it('load reads the list; installedOf answers by kind', async () => {
    let list = NONE;
    const { bridge } = fakeBridge({ 'addons:list': () => list });
    const s = createAddonsStore(bridge, undefined);
    await s.getState().load();
    expect(s.getState().list).toEqual(NONE);
    expect(installedOf(s.getState(), 'point-classifier')).toBeNull();
    list = GROUND;
    await s.getState().load();
    expect(installedOf(s.getState(), 'point-classifier')?.id).toBe('ground-classifier');
    expect(installedOf(s.getState(), 'segmenter')).toBeNull();
  });

  it('ensure reads the list only once', async () => {
    const { bridge, calls } = fakeBridge({ 'addons:list': () => NONE });
    const s = createAddonsStore(bridge, undefined);
    await Promise.all([s.getState().ensure(), s.getState().ensure()]);
    await s.getState().ensure();
    expect(calls.filter((c) => c.channel === 'addons:list')).toHaveLength(1);
  });

  it('says why the list could not be read', async () => {
    const { bridge } = fakeBridge({});
    const s = createAddonsStore(bridge, undefined);
    await s.getState().load();
    expect(s.getState()).toMatchObject({ list: null, listError: 'no addons:list' });
  });

  it('install follows the progress of its row, then reads the list again', async () => {
    const ev = events();
    let list = NONE;
    const seen: (AddonProgress | null)[] = [];
    const { bridge, calls } = fakeBridge({
      'addons:list': () => list,
      'addons:install': () => {
        ev.emit({ id: 'ground-classifier', phase: 'download', bytesDone: 5, bytesTotal: 10 });
        seen.push(s.getState().running?.progress ?? null);
        list = GROUND;
        return { ok: true, manifest: manifest('ground-classifier', '1.0.0') };
      },
    });
    const s = createAddonsStore(bridge, ev.on);
    await s.getState().load();
    await s.getState().install('ground-classifier');
    expect(calls.find((c) => c.channel === 'addons:install')?.req).toEqual({
      id: 'ground-classifier',
    });
    expect(seen[0]).toMatchObject({ phase: 'download', bytesDone: 5 });
    expect(s.getState()).toMatchObject({
      running: null,
      list: GROUND,
      note: { id: 'ground-classifier', kind: 'installed', version: '1.0.0' },
      errors: {},
    });
  });

  it('a failed install shows on its row; a cancelled one shows nothing', async () => {
    let answer: unknown = {
      ok: false,
      error: 'The file does not match its SHA-256.',
      code: 'refused',
    };
    const { bridge } = fakeBridge({ 'addons:list': () => NONE, 'addons:install': () => answer });
    const s = createAddonsStore(bridge, undefined);
    await s.getState().install('segmentation');
    expect(s.getState().errors).toEqual({ segmentation: 'The file does not match its SHA-256.' });
    answer = { ok: false, error: 'Cancelled.', code: 'cancelled' };
    await s.getState().install('segmentation');
    expect(s.getState().errors).toEqual({});
    expect(s.getState().running).toBeNull();
  });

  it('install is refused while another runs', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { bridge, calls } = fakeBridge({
      'addons:install': () => new Promise((r) => (release = r)),
      'addons:list': () => NONE,
    });
    const s = createAddonsStore(bridge, undefined);
    const first = s.getState().install('segmentation');
    await s.getState().install('ground-classifier');
    expect(calls.filter((c) => c.channel === 'addons:install')).toHaveLength(1);
    release({ ok: true, manifest: manifest('segmentation', '1.0.0') });
    await first;
  });

  it('chooseFile installs the picked file and files its error under the add-on it named', async () => {
    const ev = events();
    const { bridge, calls } = fakeBridge({
      'addons:choose': () => ({ path: 'E:\\usb\\segmentation-1.0.0.aioaddon' }),
      'addons:installFile': () => {
        ev.emit({ id: 'segmentation', phase: 'check', bytesDone: 0, bytesTotal: 0 });
        expect(s.getState().running?.id).toBe('segmentation');
        return { ok: false, error: 'Not an add-on file.', code: 'refused' };
      },
      'addons:list': () => NONE,
    });
    const s = createAddonsStore(bridge, ev.on);
    await s.getState().load();
    await s.getState().chooseFile();
    expect(calls.find((c) => c.channel === 'addons:installFile')?.req).toEqual({
      path: 'E:\\usb\\segmentation-1.0.0.aioaddon',
    });
    expect(s.getState().errors).toEqual({ segmentation: 'Not an add-on file.' });
  });

  it('chooseFile does nothing when the dialog is closed; a refusal before progress is the file row', async () => {
    let path: string | null = null;
    const { bridge, calls } = fakeBridge({
      'addons:choose': () => ({ path }),
      'addons:installFile': () => ({ ok: false, error: 'Not an add-on file.' }),
    });
    const s = createAddonsStore(bridge, undefined);
    await s.getState().chooseFile();
    expect(calls.map((c) => c.channel)).toEqual(['addons:choose']);
    path = 'E:\\x.aioaddon';
    await s.getState().chooseFile();
    expect(s.getState().errors).toEqual({ file: 'Not an add-on file.' });
  });

  it('remove reads the list again, or keeps the error on the row', async () => {
    let list = GROUND;
    let ok = true;
    const { bridge } = fakeBridge({
      'addons:list': () => list,
      'addons:remove': () => {
        if (!ok) return { ok: false, error: 'The folder is in use.' };
        list = NONE;
        return { ok: true };
      },
    });
    const s = createAddonsStore(bridge, undefined);
    await s.getState().load();
    ok = false;
    expect(await s.getState().remove('ground-classifier')).toBe(false);
    expect(s.getState().errors).toEqual({ 'ground-classifier': 'The folder is in use.' });
    ok = true;
    expect(await s.getState().remove('ground-classifier')).toBe(true);
    expect(s.getState()).toMatchObject({
      list: NONE,
      errors: {},
      note: { id: 'ground-classifier', kind: 'removed', version: '1.0.0' },
    });
  });
});
