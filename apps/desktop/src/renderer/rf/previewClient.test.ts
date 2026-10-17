import {
  computePreview,
  msiToTwoCut,
  parseMsi,
  pathLossGrid,
  resolvePreviewRequest,
  servePreview,
  type PreviewMessage,
  type PreviewPort,
  type PreviewReply,
} from '@aio/rf';
import { RfCatalogueEntry, type RfCatalogueEntry as Entry } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  ANTENNA_ENTRY,
  RADIO_ENTRY,
  antennasFile,
  lteSettings,
  sectorsFile,
  unit,
} from './__fixtures__/rfData';
import { connectPreview, type PreviewClientPort } from './previewClient';
import { patternKey, previewPlan } from './previewInput';
import { deriveRows } from './rfModel';

/**
 * The preview Worker's round trip without a Worker (as the survey engine's tests do): the client
 * on one end of an in-memory channel, `servePreview` (what `preview.worker.ts` runs) on the other.
 * Messages are delivered later, in order, like `postMessage`.
 */
function channel() {
  const posted: PreviewMessage[] = [];
  const worker: PreviewPort = {
    onmessage: null,
    postMessage(message: PreviewReply) {
      queueMicrotask(() => client.onmessage?.({ data: message }));
    },
  };
  const client: PreviewClientPort & { terminated: number } = {
    onmessage: null,
    onerror: null,
    terminated: 0,
    postMessage(message) {
      posted.push(message);
      queueMicrotask(() => worker.onmessage?.({ data: message }));
    },
    terminate() {
      this.terminated++;
    },
  };
  servePreview(worker);
  return { client, posted };
}

function setup(entries: Entry[] = [ANTENNA_ENTRY, RADIO_ENTRY]) {
  const antennas = antennasFile([unit('ant-a', 0), unit('ant-b', 120), unit('ant-c', 240)]);
  const sectors = sectorsFile(
    [
      { id: 'sec-a', antennaIds: ['ant-a'] },
      { id: 'sec-b', antennaIds: ['ant-b'] },
      { id: 'sec-c', antennaIds: ['ant-c'] },
    ],
    [lteSettings('ant-a'), lteSettings('ant-b'), lteSettings('ant-c', { etiltDeg: 6 })],
  );
  sectors.study = { ...sectors.study, radiusM: 300, gridResolutionM: 20 };
  const rows = deriveRows({
    antennas,
    sectors,
    catalogue: entries,
    includeUnreviewed: false,
    dsmGroundAt: null,
  });
  return { antennas, sectors, rows, catalogue: entries };
}

describe('the preview plan', () => {
  it('has one source per resolved carrier, on the job study grid, with the job margins', () => {
    const plan = previewPlan(setup(), new Map());
    if (!plan) throw new Error('no plan');
    expect(plan.request.sectors.map((s) => s.id)).toEqual(['sec-a', 'sec-b', 'sec-c']);
    const [a] = plan.request.sectors[0]?.sources ?? [];
    // B3 on the high port, the job's defaults: radio max 43 dBm, 100 RB, gain 17 dBi
    expect(a).toMatchObject({
      heightM: 31.5,
      azimuthGridDeg: 0,
      convergenceDeg: 0.5,
      mechanicalDowntiltDeg: 4,
      portPowerDbm: 43,
      subcarriers: 1200,
      antennaGainDbi: 17,
      pattern: { kind: 'parametric', eTiltDeg: 4, hBeamwidthDeg: 65, vBeamwidthDeg: 7, amDb: 30 },
    });
    expect(plan.request.sectors[2]?.sources[0]?.pattern).toMatchObject({ eTiltDeg: 6 });
    // all three units stand at one point: the grid centres on it, 15 pixels each side
    expect(plan.grid).toMatchObject({ width: 31, height: 31, resolutionM: 20 });
    // outdoor 0 dB + body 3 dB + 1.28 x 8 dB fade (the study defaults)
    expect(plan.request.marginDb).toBeCloseTo(0 + 3 + 1.2816 * 8, 2);
    // one path-loss grid serves the three (same place, height and frequency)
    expect(plan.pathLoss).toHaveLength(1);
    expect(plan.patternFiles).toEqual([]);
  });

  it('uses the measured pattern of the port once it is read, the generic one until then', () => {
    const withMsi = RfCatalogueEntry.parse({
      ...ANTENNA_ENTRY,
      ports:
        ANTENNA_ENTRY.kind === 'antenna'
          ? ANTENNA_ENTRY.ports.map((p) =>
              p.id === 'high'
                ? { ...p, patterns: [{ frequencyMhz: 1850, etiltDeg: 4, file: 'patterns/p1.msi' }] }
                : p,
            )
          : [],
    });
    const s = setup([withMsi, RADIO_ENTRY]);
    const first = previewPlan(s, new Map());
    expect(first?.patternFiles).toEqual([{ path: 'rf/patterns/p1.msi', capDb: 30 }]);
    expect(first?.request.sectors[0]?.sources[0]?.pattern.kind).toBe('parametric');
    const line = (a: number, v: number) => `${String(a)} ${String(v)}`;
    const msi = [
      'NAME P1',
      'FREQUENCY 1850',
      'GAIN 15 dBd',
      'TILT ELECTRICAL 4',
      'HORIZONTAL 360',
      ...Array.from({ length: 360 }, (_, a) => line(a, Math.min(25, a > 180 ? 360 - a : a) / 4)),
      'VERTICAL 360',
      ...Array.from({ length: 360 }, (_, a) =>
        line(a, Math.min(20, Math.abs(a > 180 ? a - 360 : a) / 2)),
      ),
    ].join('\n');
    const two = msiToTwoCut(parseMsi(msi), 30);
    const key = patternKey({ path: 'rf/patterns/p1.msi', capDb: 30 });
    const again = previewPlan(s, new Map([[key, two]]));
    expect(again?.request.sectors[0]?.sources[0]?.pattern).toBe(two);
  });

  it('is null when nothing takes part', () => {
    const s = setup();
    expect(
      previewPlan(
        { ...s, rows: s.rows.map((r) => ({ ...r, excluded: 'no-carrier' as const })) },
        new Map(),
      ),
    ).toBeNull();
    expect(previewPlan({ ...s, antennas: null }, new Map())).toBeNull();
  });
});

describe('the preview Worker round trip', () => {
  it('works the path loss out in the Worker and answers what computePreview answers', async () => {
    const plan = previewPlan(setup(), new Map());
    if (!plan) throw new Error('no plan');
    const { client: port, posted } = channel();
    const client = connectPreview(port);
    client.pathLoss(plan.grid, plan.radiusM, plan.pathLoss);
    // asked once per key, however often a setting changes
    client.pathLoss(plan.grid, plan.radiusM, plan.pathLoss);
    expect(posted.filter((m) => m.type === 'path-loss:compute')).toHaveLength(1);
    const r = await client.preview(plan.request);

    const cache = new Map(
      plan.pathLoss.map((j) => [j.key, pathLossGrid(plan.grid, j.antenna, j.setup, plan.radiusM)]),
    );
    const direct = computePreview(resolvePreviewRequest(plan.request, cache));
    expect(r.output.sectorIds).toEqual(['sec-a', 'sec-b', 'sec-c']);
    expect(Array.from(r.output.rsrpDbm)).toEqual(Array.from(direct.rsrpDbm));
    expect(Array.from(r.output.bestServer)).toEqual(Array.from(direct.bestServer));
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    // three sectors facing three ways: each one is the best somewhere
    expect(new Set(r.output.bestServer).size).toBeGreaterThanOrEqual(3);
  });

  it('drops the grids a new plan no longer uses, so the Worker does not keep every old one', async () => {
    const s = setup();
    const first = previewPlan(s, new Map());
    if (!first) throw new Error('no plan');
    const { client: port, posted } = channel();
    const client = connectPreview(port);
    client.pathLoss(first.grid, first.radiusM, first.pathLoss);
    await client.preview(first.request);
    // a typed height: a new path-loss key for every antenna
    const rows = s.rows.map((r) => ({ ...r, height: { ...r.height, heightM: 25 } }));
    const second = previewPlan({ ...s, rows }, new Map());
    if (!second) throw new Error('no plan');
    const oldKey = first.pathLoss[0]?.key ?? '';
    expect(second.pathLoss.map((j) => j.key)).not.toContain(oldKey);
    client.pathLoss(second.grid, second.radiusM, second.pathLoss);
    expect(posted.filter((m) => m.type === 'path-loss:drop')).toEqual([
      { type: 'path-loss:drop', key: oldKey },
    ]);
    // the new plan still previews; the dropped grid is gone from the Worker
    await expect(client.preview(second.request)).resolves.toBeDefined();
    await expect(client.preview(first.request)).rejects.toThrow(/path-loss/);
  });

  it('answers a refused request with its reason, and fails what is out when it is closed', async () => {
    const plan = previewPlan(setup(), new Map());
    if (!plan) throw new Error('no plan');
    const { client: port } = channel();
    const client = connectPreview(port);
    // no path loss asked for: the Worker names the missing grid
    await expect(client.preview(plan.request)).rejects.toThrow(/path-loss/);
    const pending = client.preview(plan.request);
    client.dispose();
    await expect(pending).rejects.toThrow(/closed/);
    expect(port.terminated).toBe(1);
    await expect(client.preview(plan.request)).rejects.toThrow(/closed/);
  });

  it('fails what is out when the Worker dies, and asks for the grids again afterwards', async () => {
    const plan = previewPlan(setup(), new Map());
    if (!plan) throw new Error('no plan');
    const posted: PreviewMessage[] = [];
    const port: PreviewClientPort = {
      onmessage: null,
      onerror: null,
      postMessage(m) {
        posted.push(m);
      },
    };
    const client = connectPreview(port);
    client.pathLoss(plan.grid, plan.radiusM, plan.pathLoss);
    const out = client.preview(plan.request);
    port.onerror?.({ message: 'out of memory' });
    await expect(out).rejects.toThrow(/out of memory/);
    client.pathLoss(plan.grid, plan.radiusM, plan.pathLoss);
    expect(posted.filter((m) => m.type === 'path-loss:compute')).toHaveLength(2);
  });
});
