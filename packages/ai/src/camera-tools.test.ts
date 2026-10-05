import { fromWgs84, projectToLocal, toWgs84 } from '@aio/geo';
import type { Vec3, WindowKind } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { parseCoordinate, resolveName, scorePlace, type Place } from './places';
import { runRendererTool, type AppHooks, type RendererToolContext } from './renderer-tools';
import { spatialContext } from './site';
import {
  fakeStage,
  SITE_NODES,
  SITE_ORIGIN,
  SITE_T0,
  siteFlight,
  siteManifest,
  siteWorkspace,
} from './test-fixtures';
import { toolsForWindow } from './tools';

function ctx(
  opts: { stage?: boolean; app?: AppHooks; window?: WindowKind } = {},
): RendererToolContext & { stage: ReturnType<typeof fakeStage> | null } {
  const ws = siteWorkspace();
  const stage = opts.stage === false ? null : fakeStage(ws);
  return {
    workspace: ws,
    window: opts.window ?? 'scene3d',
    scene: () => stage,
    fetchJson: () => Promise.resolve(siteFlight()),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-05T12:00:00Z'),
    ...(opts.app ? { app: opts.app } : {}),
    stage,
  };
}

const view = (c: ReturnType<typeof ctx>) => {
  const v = c.stage?.saveView();
  if (!v) throw new Error('no stage');
  return v;
};
const near = (a: readonly number[], b: readonly number[], tol = 0.01) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) <= tol);
const centreOf = (tag: string): Vec3 => {
  const n = SITE_NODES.find((x) => x[0] === tag);
  if (!n) throw new Error(tag);
  return n[2];
};
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

describe('place names', () => {
  const tank = (tag: string, area = '20 · LNG tanks'): Place => ({
    id: `asset:${tag}`,
    kind: 'asset',
    name: tag,
    detail: area,
  });

  it('reads words and numbers: "tank 3" is 20-T-0003, not tank 1 or pump 3A', () => {
    const t3 = scorePlace('tank 3', tank('20-T-0003'));
    expect(t3).toBeGreaterThan(70);
    expect(scorePlace('tank 3', tank('20-T-0001'))).toBeLessThan(50);
    expect(scorePlace('tank 3', tank('20-P-0003A'))).toBeLessThan(t3 - 8);
    expect(scorePlace('T-0003', tank('20-T-0003'))).toBeGreaterThan(80);
    expect(scorePlace('20t0003', tank('20-T-0003'))).toBe(100);
    expect(scorePlace('20-t-0003', tank('20-T-0003'))).toBe(100);
  });

  it('keeps "tank 3" on the tank when other glTF names mention tanks (Al-Zour)', () => {
    const named = (tag: string, name: string): Place => ({
      ...tank(tag),
      aliases: [name],
    });
    const t3 = scorePlace('tank 3', named('20-T-0003', 'LNG STORAGE TANK'));
    for (const other of [
      named('20-DCP-003', 'DRY CHEMICAL PACKAGE SYSTEM FOR LNG TANK'),
      named('20-A-0033', 'PERSONNEL ELEVATOR FOR LNG TANK (20-T-0003)'),
      named('20-A-0031', 'JIB CRANE FOR LP LNG PUMP FOR 20-T-0003'),
      {
        ...named('70-A-0012-V-03', 'DIESEL DAY TANK FOR MAIN EMERGENCY DIESEL GENERATOR 3'),
        detail: '70 · Utilities',
      },
    ])
      expect(t3 - scorePlace('tank 3', other), other.name).toBeGreaterThanOrEqual(8);
  });

  it('finds an area by a word of its name', () => {
    const jetty: Place = {
      id: 'group:10 · Jetty & berths',
      kind: 'group',
      name: '10 · Jetty & berths',
    };
    expect(scorePlace('the jetty', jetty)).toBeGreaterThan(80);
    expect(scorePlace('the jetty', tank('10-A-0004', '10 · Jetty & berths'))).toBeLessThan(60);
    // bare model nodes named like it (Al-Zour: Area_10_Jetty, jetty1-ditch) rank below the area
    const node = (name: string): Place => ({ id: `asset:${name}`, kind: 'asset', name, rank: -10 });
    expect(
      scorePlace('jetty', jetty) - scorePlace('jetty', node('Area_10_Jetty')),
    ).toBeGreaterThanOrEqual(8);
    expect(
      scorePlace('jetty', jetty) - scorePlace('jetty', node('jetty1-ditch')),
    ).toBeGreaterThanOrEqual(8);
    expect(scorePlace('Area_10_Jetty', node('Area_10_Jetty'))).toBe(100);
    // and above a component whose glTF name mentions the jetty
    const arm = { ...tank('10-A-0004', '10 · Jetty & berths'), aliases: ['Loading arm, jetty 1'] };
    expect(scorePlace('jetty', jetty) - scorePlace('jetty', arm)).toBeGreaterThanOrEqual(8);
  });

  it('resolves a clear name and lists the candidates of an unclear one', () => {
    const c = ctx();
    expect(resolveName(c, 'Tank 3').id).toBe('asset:20-T-0003');
    expect(resolveName(c, 'asset:20-T-0002').id).toBe('asset:20-T-0002');
    expect(resolveName(c, 'jetty').id).toBe('group:10 · Jetty & berths');
    expect(() => resolveName(c, 'tank')).toThrow(/matches several places: .*20-T-0001.*20-T-0002/);
    expect(() => resolveName(c, 'cooling tower')).toThrow('No place matches "cooling tower"');
  });

  it('measures assets in the live scene', () => {
    const c = ctx();
    const t = resolveName(c, '20-T-0002');
    expect(t.box).toEqual({ min: [160, 0, -90], max: [240, 50, -10] });
  });
});

describe('coordinates', () => {
  it('parses latitude and longitude, easting and northing, in the usual ways', () => {
    expect(parseCoordinate('29.07N 48.08E')).toEqual({ kind: 'latlon', lat: 29.07, lon: 48.08 });
    expect(parseCoordinate('48.08 E, 29.07 N')).toEqual({ kind: 'latlon', lat: 29.07, lon: 48.08 });
    expect(parseCoordinate('33.9S 151.2E')).toEqual({ kind: 'latlon', lat: -33.9, lon: 151.2 });
    expect(parseCoordinate('29.07, 48.08')).toEqual({ kind: 'latlon', lat: 29.07, lon: 48.08 });
    expect(parseCoordinate('E 245 884.9  N 3 179 597.1')).toEqual({
      kind: 'en',
      e: 245884.9,
      n: 3179597.1,
    });
    expect(parseCoordinate('245714, 3179542, 112')).toEqual({
      kind: 'en',
      e: 245714,
      n: 3179542,
      h: 112,
    });
    expect(parseCoordinate('tank 3')).toBeNull();
  });

  it('flies to a latitude and longitude through the project CRS', async () => {
    const c = ctx();
    const [lon, lat] = toWgs84([SITE_ORIGIN[0] + 120, SITE_ORIGIN[1] + 80, 0], 32639);
    await runRendererTool('fly_to', { target: { kind: 'latlon', lat, lon } }, c);
    const [e, n] = fromWgs84([lon, lat, 0], 32639);
    const want = projectToLocal([e, n, SITE_ORIGIN[2]], SITE_ORIGIN);
    // height: the ground (no hit in the fake: local 0)
    expect(near(view(c).target, [want[0], 0, want[2]], 0.01)).toBe(true);
    expect(near(view(c).target, [120, 0, -80], 0.01)).toBe(true);
  });

  it('flies to easting and northing, and to a coordinate written as a place', async () => {
    const c = ctx();
    const r = await runRendererTool(
      'fly_to',
      { target: { kind: 'en', e: SITE_ORIGIN[0] + 50, n: SITE_ORIGIN[1] + 30, h: 110 } },
      c,
    );
    expect(view(c).target).toEqual([50, 10, -30]);
    expect(r.result).toMatchObject({
      lookingAt: { en: [SITE_ORIGIN[0] + 50, SITE_ORIGIN[1] + 30] },
    });
    const [lon, lat] = toWgs84([SITE_ORIGIN[0] - 200, SITE_ORIGIN[1], 0], 32639);
    await runRendererTool(
      'fly_to',
      { target: { kind: 'place', name: `${lat.toFixed(6)}N ${lon.toFixed(6)}E` } },
      c,
    );
    expect(near(view(c).target, [-200, 0, 0], 0.2)).toBe(true);
  });

  it('keeps local points for numbers a tool returned', async () => {
    const c = ctx();
    await runRendererTool('fly_to', { target: { kind: 'point', p: [1, 2, 3] } }, c);
    expect(view(c).target).toEqual([1, 2, 3]);
  });
});

describe('fly_to', () => {
  it('frames a named tank, from the top when asked, and reports it in site terms', async () => {
    const c = ctx();
    const r = await runRendererTool(
      'fly_to',
      { target: { kind: 'place', name: 'tank 3' }, view: 'top' },
      c,
    );
    const v = view(c);
    expect(near(v.target, centreOf('20-T-0003'))).toBe(true);
    expect(v.position[0]).toBeCloseTo(300, 0);
    expect(v.position[1]).toBeGreaterThan(100);
    expect(r.result).toMatchObject({
      place: { id: 'asset:20-T-0003', kind: 'asset' },
      lookingAt: { place: '20-T-0003', en: [SITE_ORIGIN[0] + 300, SITE_ORIGIN[1] + 50] },
      pitchDeg: -90,
    });
    expect(r.summary).toContain('20-T-0003');
  });

  it('flies to an asset by a loose tag, an area, and from a side', async () => {
    const c = ctx();
    await runRendererTool('fly_to', { target: { kind: 'asset', id: 't-0001' } }, c);
    expect(near(view(c).target, centreOf('20-T-0001'))).toBe(true);
    await runRendererTool('fly_to', { target: { kind: 'place', name: 'jetty' }, view: 'north' }, c);
    const v = view(c);
    expect(near(v.target, [-407.5, 5, 317.5], 0.01)).toBe(true);
    // the camera stands north of it (north is -z)
    expect(v.position[2]).toBeLessThan(v.target[2] - 10);
  });

  it('goes to an issue by its code: the middle of its sightings, close up', async () => {
    const c = ctx();
    await runRendererTool('fly_to', { target: { kind: 'issue', id: 'f5' } }, c);
    const v = view(c);
    expect(near(v.target, [300, 50, -50])).toBe(true);
    expect(dist(v.position, v.target)).toBeLessThan(20);
    // a camera request the 3D view understands (not an issue selection it would ignore)
    expect(c.workspace.getState().lastCamera?.target.kind).toBe('point');
  });

  it('stands where a photo was taken, looking where it looked', async () => {
    const c = ctx();
    const r = await runRendererTool('fly_to', { target: { kind: 'photo', id: 'DJI_0661' } }, c);
    const v = view(c);
    expect(near(v.position, [150, 80, 50])).toBe(true);
    // straight down
    expect(near([v.target[0], v.target[2]], [150, 50], 0.01)).toBe(true);
    expect(v.target[1]).toBeLessThan(80);
    expect(r.result).toMatchObject({ view: 'eye' });
  });

  it('"the photo of F05" stands where the issue was photographed', async () => {
    const c = ctx();
    const issue = c.workspace.getState().issues[0];
    if (!issue) throw new Error('no issue');
    c.workspace.getState().upsertIssue({
      ...issue,
      sightings: [
        ...issue.sightings,
        {
          on: 'image',
          layer: 'photos',
          photo: 'DJI_0661',
          geom: { type: 'point', x: 0.5, y: 0.5 },
        },
      ],
    });
    await runRendererTool('fly_to', { target: { kind: 'place', name: 'photo of F05' } }, c);
    expect(near(view(c).position, [150, 80, 50])).toBe(true);
  });

  it('puts the camera where the drone was at a site time', async () => {
    const c = ctx();
    // 13:25 site time (UTC+3) is three minutes into the flight: x = 180
    expect(new Date(SITE_T0).toISOString()).toContain('T10:22');
    const r = await runRendererTool('fly_to', { target: { kind: 'clip', at: '13:25' } }, c);
    expect(near(view(c).position, [180, 100, 0], 0.01)).toBe(true);
    expect(r.summary).toContain('10:25:00');
    await runRendererTool('fly_to', { target: { kind: 'clip', id: 'DJI_0658', atSeconds: 30 } }, c);
    expect(near(view(c).position, [30, 100, 0], 0.01)).toBe(true);
  });

  it('turns to a panorama heading at its position', async () => {
    const c = ctx();
    await runRendererTool('fly_to', { target: { kind: 'pano', id: '100_0655' } }, c);
    const v = view(c);
    expect(v.position).toEqual([0, 120, 0]);
    // heading 90: east
    expect(v.target[0]).toBeGreaterThan(1);
    expect(Math.abs(v.target[2])).toBeLessThan(1e-6);
  });

  it('explains an unknown or unclear place and moves nothing', async () => {
    const c = ctx();
    const before = view(c);
    await expect(
      runRendererTool('fly_to', { target: { kind: 'place', name: 'tank' } }, c),
    ).rejects.toThrow('matches several places');
    await expect(
      runRendererTool('fly_to', { target: { kind: 'asset', id: 'T-101' } }, c),
    ).rejects.toThrow('No place matches "T-101"');
    expect(view(c)).toEqual(before);
  });

  it('undo puts the camera back', async () => {
    const c = ctx();
    const before = view(c);
    const r = await runRendererTool('fly_to', { target: { kind: 'place', name: 'tank 2' } }, c);
    expect(view(c)).not.toEqual(before);
    r.undo?.();
    expect(near(view(c).position, before.position)).toBe(true);
    expect(near(view(c).target, before.target)).toBe(true);
  });

  it('without a 3D view the request waits for it and the map follows it', async () => {
    const c = ctx({ stage: false });
    await runRendererTool('fly_to', { target: { kind: 'issue', id: 'F05' } }, c);
    const req = c.workspace.getState().lastCamera?.target;
    expect(req).toMatchObject({ kind: 'point', p: [300, 50, -50] });
  });

  it('on a Map-only stage pans the map, and opens the 3D view when asked', async () => {
    const show3d = vi.fn();
    const app: AppHooks = { stageView: () => ({ show3d: false, showMap: true }), show3d };
    const c = ctx({ app, window: 'map' });
    const r = await runRendererTool('fly_to', { target: { kind: 'place', name: 'tank 1' } }, c);
    expect(show3d).not.toHaveBeenCalled();
    expect(c.workspace.getState().lastCamera?.target).toMatchObject({
      kind: 'point',
      p: centreOf('20-T-0001'),
    });
    expect(r.result).toMatchObject({ note: expect.stringContaining('map') as string });
    await runRendererTool('fly_to', { target: { kind: 'place', name: 'tank 1' }, open3d: true }, c);
    expect(show3d).toHaveBeenCalledTimes(1);
  });
});

describe('camera tools', () => {
  const heading = (v: { position: number[]; target: number[] }) =>
    (Math.atan2(
      (v.target[0] ?? 0) - (v.position[0] ?? 0),
      -((v.target[2] ?? 0) - (v.position[2] ?? 0)),
    ) *
      180) /
    Math.PI;

  it('set_view top and home of the whole site', async () => {
    const c = ctx();
    const r = await runRendererTool('set_view', { view: 'top' }, c);
    let v = view(c);
    expect(near([v.position[0], v.position[2]], [v.target[0], v.target[2]], 1)).toBe(true);
    expect(r.result).toMatchObject({ pitchDeg: -90 });
    await runRendererTool('set_view', { view: 'home' }, c);
    v = view(c);
    // iso from the south-east
    expect(v.position[0]).toBeGreaterThan(v.target[0]);
    expect(v.position[2]).toBeGreaterThan(v.target[2]);
  });

  it('set_view of a place from a side', async () => {
    const c = ctx();
    await runRendererTool(
      'set_view',
      { view: 'east', target: { kind: 'place', name: '20-T-0002' } },
      c,
    );
    const v = view(c);
    expect(near(v.target, centreOf('20-T-0002'))).toBe(true);
    expect(v.position[0]).toBeGreaterThan(240);
  });

  it('frame_all fits the site and says how big it is', async () => {
    const c = ctx();
    await runRendererTool('fly_to', { target: { kind: 'place', name: 'tank 1' } }, c);
    const r = await runRendererTool('frame_all', {}, c);
    const v = view(c);
    expect(near(v.target, [-42.5, 25, 127.5], 0.01)).toBe(true);
    expect(r.result).toMatchObject({ siteSizeM: { eastWest: 765, northSouth: 435, height: 50 } });
    expect(dist(v.position, v.target)).toBeGreaterThan(500);
  });

  it('orbit turns around the target by yaw and pitch, keeping the distance', async () => {
    const c = ctx();
    await runRendererTool(
      'fly_to',
      { target: { kind: 'place', name: 'tank 2' }, view: 'south' },
      c,
    );
    const a = view(c);
    await runRendererTool('orbit', { yawDeg: 90 }, c);
    const b = view(c);
    expect(near(b.target, a.target)).toBe(true);
    expect(dist(b.position, b.target)).toBeCloseTo(dist(a.position, a.target), 5);
    // from the south (looking north, heading 0) to the west (looking east, heading 90)
    expect(heading(a)).toBeCloseTo(0, 3);
    expect(heading(b)).toBeCloseTo(90, 3);
    expect(b.position[0]).toBeLessThan(b.target[0]);
    await runRendererTool('orbit', { pitchDeg: 30 }, c);
    const p = view(c);
    expect(p.position[1] - p.target[1]).toBeGreaterThan(b.position[1] - b.target[1]);
  });

  it('zoom by a factor and to a distance', async () => {
    const c = ctx();
    await runRendererTool('fly_to', { target: { kind: 'place', name: 'tank 2' } }, c);
    const d0 = dist(view(c).position, view(c).target);
    await runRendererTool('zoom', { factor: 2 }, c);
    expect(dist(view(c).position, view(c).target)).toBeCloseTo(d0 / 2, 5);
    const r = await runRendererTool('zoom', { distanceM: 400 }, c);
    expect(dist(view(c).position, view(c).target)).toBeCloseTo(400, 5);
    expect(r.summary).toContain('zoom out');
  });

  it('look_at keeps the camera where it is and aims it', async () => {
    const c = ctx();
    const before = view(c);
    const r = await runRendererTool('look_at', { target: { kind: 'place', name: 'jetty' } }, c);
    const v = view(c);
    expect(near(v.position, before.position)).toBe(true);
    expect(near(v.target, [-407.5, 5, 317.5], 0.01)).toBe(true);
    r.undo?.();
    expect(near(view(c).target, before.target)).toBe(true);
  });

  it('switches a Map-only stage to 3D for 3D-only moves', async () => {
    const show3d = vi.fn();
    const c = ctx({ app: { stageView: () => ({ show3d: false, showMap: true }), show3d } });
    await runRendererTool('orbit', { yawDeg: 45 }, c);
    expect(show3d).toHaveBeenCalledTimes(1);
  });
});

describe('find_places', () => {
  it('returns ids, kinds, positions in every frame and sizes', async () => {
    const c = ctx();
    const r = await runRendererTool('find_places', { query: 'tank 3' }, c);
    const places = (r.result as { places: Record<string, unknown>[] }).places;
    expect(places[0]).toMatchObject({
      id: 'asset:20-T-0003',
      kind: 'asset',
      name: '20-T-0003',
      detail: '20 · LNG tanks',
      sizeM: [80, 50, 80],
      position: {
        local: [300, 25, -50],
        en: [SITE_ORIGIN[0] + 300, SITE_ORIGIN[1] + 50],
        elevationM: 125,
      },
    });
    const pos = places[0]?.position as { latLon: [number, number] };
    const [lon, lat] = toWgs84([SITE_ORIGIN[0] + 300, SITE_ORIGIN[1] + 50, 0], 32639);
    expect(pos.latLon[0]).toBeCloseTo(lat, 5);
    expect(pos.latLon[1]).toBeCloseTo(lon, 5);
  });

  it('finds issues with their photos, photos, panoramas and clips by kind', async () => {
    const c = ctx();
    const issue = await runRendererTool('find_places', { query: 'issue F05' }, c);
    expect(issue.result).toMatchObject({ places: [{ id: 'issue:F05', kind: 'issue' }] });
    const clips = await runRendererTool('find_places', { kinds: ['clip'] }, c);
    expect(clips.result).toMatchObject({
      places: [{ id: 'clip:clip-0658', kind: 'clip', position: { local: [300, 100, 0] } }],
    });
    const media = await runRendererTool('find_places', { kinds: ['photo', 'pano'] }, c);
    expect((media.result as { total: number }).total).toBe(2);
  });

  it('sorts by distance from a place and keeps a radius', async () => {
    const c = ctx();
    const r = await runRendererTool(
      'find_places',
      { kinds: ['asset'], near: { kind: 'place', name: 'tank 3' }, radiusM: 100 },
      c,
    );
    const places = (r.result as { places: { id: string; distanceM: number }[] }).places;
    expect(places.map((p) => p.id)).toEqual([
      'asset:20-T-0003',
      'asset:20-P-0003A',
      'asset:20-T-0002',
    ]);
    expect(places[1]?.distanceM).toBeCloseTo(Math.hypot(23, 60), 0);
  });

  it('says when nothing matches', async () => {
    const r = await runRendererTool('find_places', { query: 'cooling tower' }, ctx());
    expect(r.result).toMatchObject({
      shown: 0,
      hint: expect.stringContaining('Nothing') as string,
    });
  });
});

describe('availability and context', () => {
  it('offers the camera tools in every window the agent can be bound to', () => {
    for (const w of ['scene3d', 'map', 'pointcloud', 'video', 'photo', 'issues'] as const) {
      const names = toolsForWindow(w).map((s) => s.meta.name);
      for (const t of [
        'find_places',
        'fly_to',
        'set_view',
        'orbit',
        'zoom',
        'look_at',
        'frame_all',
      ])
        expect(names, `${t} in ${w}`).toContain(t);
    }
  });

  it('summarises the site: CRS, origin, extent, areas with example tags, camera and view', () => {
    const c = ctx();
    const s = spatialContext(c, 'scene3d').site as Record<string, unknown>;
    expect(s).toMatchObject({
      crs: 'EPSG:32639 (UTM 39N, WGS84)',
      origin: { en: [SITE_ORIGIN[0], SITE_ORIGIN[1]], elevationM: 100 },
      extent: { sizeM: { eastWest: 765, northSouth: 435, height: 50 } },
      named: {
        assets: 6,
        groups: [
          { name: '20 · LNG tanks', count: 4, eg: ['20-T-0001', '20-T-0002', '20-T-0003'] },
          { name: '10 · Jetty & berths', count: 2 },
        ],
        photos: 1,
        panoramas: 1,
        clips: 1,
        issuesWithLocation: 1,
      },
      siteTime: '13:22:00 (UTC+3)',
    });
    expect((s.origin as { latLon: number[] }).latLon[0]).toBeCloseTo(28.7, 0);
    expect(s.camera).toMatchObject({ facing: 'NW' });
    expect(spatialContext(c, 'report')).toEqual({});
  });

  it('stays small on a plant with hundreds of tags', () => {
    const ws = siteWorkspace();
    const m = siteManifest();
    const mesh = m.layers[0];
    if (mesh?.kind !== 'mesh') throw new Error('mesh');
    mesh.tags = Array.from({ length: 450 }, (_, i) => ({
      node: `N${String(i)}`,
      tag: `${String(10 + (i % 9) * 10)}-X-${String(i).padStart(4, '0')}`,
      area: `${String(10 + (i % 9) * 10)} · Area ${String(i % 9)}`,
    }));
    ws.getState().replaceManifest(m);
    const c: RendererToolContext = {
      ...ctx(),
      workspace: ws,
    };
    const json = JSON.stringify(spatialContext(c, 'scene3d'));
    expect(json.length).toBeLessThan(3000);
    expect(json).toContain('"assets":450');
  });

  it('starts the clock at the flight', () => {
    expect(siteWorkspace().getState().nowMs).toBe(SITE_T0);
  });
});
