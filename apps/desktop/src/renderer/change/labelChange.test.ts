import { changeStore, type ChangePairContext, type RegisterRow } from '@aio/change';
import type { ChangeItem, ChangeSet, IpcResponse, Layer, ProjectManifest, Vec3 } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CropIo } from '../survey/orthoCrop';
import type { LabelIo } from './labelChange';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
}));

const {
  labelOrthos,
  labelConfirmInfo,
  labelNeedsConfirm,
  labelRouteName,
  prepareLabel,
  sendLabel,
  labelRoute,
  labelUnavailable,
  labelWindow,
  outlinePixels,
  withAiLabel,
} = await import('./labelChange');

type Region = Extract<ChangeItem, { kind: 'region' }>;
const origin: Vec3 = [500_000, 2_800_000, 0];
const region = (extra: Partial<Region> = {}): Region => ({
  kind: 'region',
  id: 'region:1',
  verdict: 'changed',
  bounds: { min: [10, 0, -20], max: [30, 2, 0] },
  areaM2: 400,
  ...extra,
});
const ortho = (id: string, format = 'image'): Layer =>
  ({
    id,
    name: id,
    kind: 'raster',
    role: 'ortho',
    format,
    src: { path: `layers/${id}.png` },
    corners: { tl: [0, 0, -100], tr: [100, 0, -100], bl: [0, 0, 100] },
  }) as unknown as Layer;

const status = (over: Partial<IpcResponse<'ai:askStatus'>> = {}): IpcResponse<'ai:askStatus'> => ({
  cloud: { usable: true, providers: ['anthropic'] },
  keepLocal: false,
  local: { ready: true, model: 'qwen' },
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('labelWindow', () => {
  it('centres a padded square on the region, at least 10 m a side, and marks the region', () => {
    const r = labelWindow(region(), origin, 100);
    if (!r) throw new Error('no window');
    // 20 m wide, 20 m deep: 30 m side; centre E 500020, N 2800010
    expect(r.window.res * r.window.size).toBeCloseTo(30);
    expect(r.window.x0).toBeCloseTo(500_005);
    expect(r.window.y1).toBeCloseTo(2_800_025);
    for (const [got, want] of r.mark.map((v, n) => [v, [1 / 6, 1 / 6, 5 / 6, 5 / 6][n]]))
      expect(got).toBeCloseTo(want ?? 0);
    const small = labelWindow(region({ bounds: { min: [0, 0, 0], max: [1, 0, 1] } }), origin);
    expect((small?.window.res ?? 0) * (small?.window.size ?? 0)).toBeCloseTo(10);
    expect(labelWindow({ kind: 'region', id: 'x', verdict: 'added' }, origin)).toBeNull();
  });

  it('draws the local outline, else the bounds, in crop pixels', () => {
    const r = labelWindow(region(), origin, 30);
    if (!r) throw new Error('no window');
    const rect = outlinePixels(region(), r.window, origin);
    expect(rect[0]?.map((v) => Math.round(v))).toEqual([5, 5]);
    expect(rect[2]?.map((v) => Math.round(v))).toEqual([25, 25]);
    const tri = outlinePixels(
      region({
        outlineLocal: [
          [10, 0, 0],
          [30, 0, 0],
          [20, 0, -20],
        ],
      }),
      r.window,
      origin,
    );
    expect(tri).toHaveLength(3);
    expect(tri[2]?.map((v) => Math.round(v))).toEqual([15, 5]);
  });
});

describe('availability', () => {
  const ctx = { layersFrom: [ortho('o1')], layersTo: [ortho('o2')] };
  it('needs a croppable ortho on each date of its own', () => {
    expect(labelOrthos(ctx)?.to.id).toBe('o2');
    expect(labelOrthos({ layersFrom: [ortho('o1')], layersTo: [ortho('o1')] })).toBeNull();
    expect(labelOrthos({ layersFrom: [ortho('o1', 'cog')], layersTo: [ortho('o2')] })).toBeNull();
  });

  it('routes like a custom change ask: cloud when usable, local when kept local or forbidden', () => {
    expect(labelRoute(status())).toMatchObject({ kind: 'cloud', provider: 'anthropic' });
    expect(labelRoute(status({ keepLocal: true }))).toEqual({ kind: 'local' });
    expect(
      labelRoute(status({ cloud: { usable: false, reason: 'forbidden', providers: [] } })),
    ).toEqual({ kind: 'local' });
    expect(
      labelRoute(status({ cloud: { usable: false, providers: [] }, local: { ready: false } })),
    ).toBeNull();
    expect(labelRoute(null)).toBeNull();
  });

  it('says why a region cannot be labelled, and nothing for other kinds', () => {
    expect(labelUnavailable(region(), ctx, status(), origin)).toBeNull();
    expect(labelUnavailable(region(), { layersFrom: [], layersTo: [] }, status(), origin)).toMatch(
      /ortho/,
    );
    expect(labelUnavailable(region(), ctx, null, origin)).toMatch(/AI/);
    expect(
      labelUnavailable({ kind: 'region', id: 'x', verdict: 'added' }, ctx, status(), origin),
    ).toMatch(/position/);
    expect(
      labelUnavailable(
        {
          kind: 'frame',
          id: 'f',
          verdict: 'changed',
          a: { layer: 'v', t: 1 },
          b: { layer: 'v', t: 2 },
        },
        ctx,
        null,
        null,
      ),
    ).toBeNull();
  });
});

const set = (): ChangeSet => ({
  schema: 'aio.change/1',
  id: 'c1-c2-raster',
  from: 'c1',
  to: 'c2',
  producer: 'change.raster',
  createdAt: '2026-11-01T00:00:00Z',
  items: [region()],
  layers: [],
  stats: {},
});

describe('withAiLabel', () => {
  it('sets and clears the label on one region only', () => {
    const at = '2026-11-11T00:00:00Z';
    const s = withAiLabel(set(), 'region:1', { kind: 'water', at });
    expect(s.items[0]).toMatchObject({ aiLabel: { kind: 'water' } });
    expect(withAiLabel(s, 'region:1', null).items[0]).not.toHaveProperty('aiLabel');
    expect(() => withAiLabel(set(), 'nope', { kind: 'water', at })).toThrow();
  });
});

describe('labelRegion', () => {
  const fakeCrop: CropIo = {
    url: (ref) => (typeof ref === 'string' ? ref : JSON.stringify(ref)),
    fetchJson: () => Promise.resolve({}),
    image: () => Promise.resolve({ width: 10, height: 10, source: {} as CanvasImageSource }),
    canvas: (size) => ({
      ctx: {
        setTransform: vi.fn(),
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        fillStyle: '#000',
        imageSmoothingQuality: 'high',
        getImageData: () => ({ data: new Uint8ClampedArray(size * size * 4) }) as ImageData,
      },
    }),
  };
  const ctx: ChangePairContext = {
    projectId: 'p',
    manifest: { origin, layers: [], captures: [] } as unknown as ProjectManifest,
    from: 'c1',
    to: 'c2',
    layersFrom: [ortho('o1')],
    layersTo: [ortho('o2')],
  };
  const row: RegisterRow = {
    setId: 'c1-c2-raster',
    producer: 'change.raster',
    item: region(),
    status: 'open',
  };

  const answer = (): IpcResponse<'ai:ask'> => ({
    ok: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    promptVersion: 'ask-v1',
    items: [
      {
        box: [0.2, 0.2, 0.8, 0.8],
        label: 'a tipper truck',
        note: '',
        fields: [{ key: 'kind', label: 'Kind of change', type: 'choice', value: 'vehicle' }],
      },
    ],
    inputTokens: 1,
    outputTokens: 1,
    warnings: [],
  });
  const io = (over: Partial<LabelIo> = {}): LabelIo => ({
    crop: fakeCrop,
    encode: () => Promise.resolve('data:image/jpeg;base64,x'),
    ask: () => Promise.resolve(answer()),
    status: () => Promise.resolve(status()),
    now: () => '2026-11-11T09:00:00Z',
    runId: () => 'run-1',
    ...over,
  });
  const prepared = async (over: Partial<LabelIo> = {}) => {
    const p = await prepareLabel({
      row,
      ctx,
      dates: { from: '1 Oct 2026', to: '1 Nov 2026' },
      io: io(over),
    });
    if ('error' in p) throw new Error(p.error);
    return p;
  };

  it('makes both crops, outlined, into a change request on the chosen route', async () => {
    const encode = vi.fn(() => Promise.resolve('data:image/jpeg;base64,x'));
    const p = await prepared({ encode });
    expect(p.request.images.map((i) => i.label)).toEqual(['1 Oct 2026', '1 Nov 2026']);
    expect(p.route).toMatchObject({ kind: 'cloud', provider: 'anthropic' });
    expect(p.request.backend).toEqual(p.route);
    expect(encode).toHaveBeenCalledTimes(2);
    const outline = encode.mock.calls[0] as unknown as [unknown, number, unknown[]];
    expect(outline[2]).toHaveLength(4);
  });

  it('asks before a cloud label leaves the computer, unless skipped for the project', async () => {
    const p = await prepared();
    expect(labelNeedsConfirm(p, () => false)).toBe(true);
    expect(labelNeedsConfirm(p, () => true)).toBe(false);
    expect(labelNeedsConfirm({ ...p, route: { kind: 'local' } }, () => false)).toBe(false);
    const ask = vi.fn(() => Promise.resolve(answer()));
    await expect(
      sendLabel(p, { confirmed: false, io: { ask, now: () => '' }, skipped: () => false }),
    ).rejects.toThrow(/confirmed/);
    expect(ask).not.toHaveBeenCalled();
    const info = labelConfirmInfo(p);
    expect(info).toMatchObject({ providerLabel: 'Anthropic', photos: 2, frames: 0 });
    expect(info.images).toHaveLength(2);
    expect(info.userText).toContain('marked area');
  });

  it('names who answers for the tip', () => {
    expect(labelRouteName({ kind: 'cloud', provider: 'anthropic', model: 'm' })).toBe('Anthropic');
    expect(labelRouteName({ kind: 'local' })).toBe("this computer's model");
    expect(labelRouteName(null)).toBeNull();
  });

  it('sends a confirmed label and saves what the answer says on the region', async () => {
    let saved: ChangeSet | null = null;
    changeStore.setState({
      sets: { 'c1-c2-raster': set() },
      save: (next: ChangeSet) => {
        saved = next;
        return Promise.resolve(true);
      },
    });
    const p = await prepared();
    const ask = vi.fn(() => Promise.resolve(answer()));
    const err = await sendLabel(p, {
      confirmed: true,
      io: { ask, now: () => '2026-11-11T09:00:00Z' },
    });
    expect(err).toBeNull();
    expect(ask).toHaveBeenCalledWith(p.request);
    expect((saved as ChangeSet | null)?.items[0]).toMatchObject({
      aiLabel: {
        kind: 'vehicle',
        what: 'a tipper truck',
        model: 'claude-sonnet-5-5',
        at: '2026-11-11T09:00:00Z',
      },
    });
  });

  it('says the error when the ask fails and saves nothing', async () => {
    const save = vi.fn(() => Promise.resolve(true));
    changeStore.setState({ sets: { 'c1-c2-raster': set() }, save });
    const p = await prepared();
    const err = await sendLabel(p, {
      confirmed: true,
      io: { ask: () => Promise.resolve({ ok: false, error: 'The cloud is off.' }), now: () => '' },
    });
    expect(err).toMatch(/The cloud is off/);
    expect(save).not.toHaveBeenCalled();
  });

  it('says why when no AI can answer', async () => {
    const p = await prepareLabel({
      row,
      ctx,
      dates: { from: 'a', to: 'b' },
      io: io({ status: () => Promise.resolve(null) }),
    });
    expect(p).toEqual({ error: expect.stringMatching(/AI/) as string });
  });
});
