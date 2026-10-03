/* global __PACKS__, __FIXTURES__, window, document, ResizeObserver */
// Map harness: the real map controller over the installed packs and a synthetic Al-Zour project
// built from the (git-ignored) design fixtures, converted from the plant grid into the local frame.
import { workspace } from '@aio/workspace';
import { Quaternion, Vector3 } from 'three';
import { createMapController } from '../src/controller';

const PACKS = __PACKS__;
const FIX = `${__FIXTURES__}alzour/`;

// Tank 20-T-0001: plant (1301.1, 555.4) = UTM 39N (245747.13, 3179641.87). Plant north is
// 17.9991 deg east of UTM north. The local origin sits on the tank at plant grade (EL 100).
const ORIGIN = [245747.13, 3179641.87, 100];
const ROT = (17.9991 * Math.PI) / 180;
const qPlant = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -ROT);

/** plant.glb model frame (x = E - 1300, y = EL - 100, z = -(N - 450)) to local. */
function modelToLocal([x, y, z]) {
  const dE = x + 1300 - 1301.1;
  const dN = 450 - z - 555.4;
  const e = dE * Math.cos(ROT) + dN * Math.sin(ROT);
  const n = -dE * Math.sin(ROT) + dN * Math.cos(ROT);
  return [e, y, -n];
}
const plantEnToLocal = ([pe, pn]) => modelToLocal([pe - 1300, 0.3, -(pn - 450)]);

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('aio://project/demo/')) return realFetch(input, init);
  const path = url.slice('aio://project/demo/'.length);
  if (path.startsWith('rasters/')) return realFetch(FIX + path.slice(8), init);
  if (path.startsWith('flights/')) {
    const src = await (await realFetch(FIX + path.slice(8))).json();
    const samples = src.samples.map((s) => {
      const q = qPlant.clone().multiply(new Quaternion(...s.q));
      return { t: s.t * 1000, pos: modelToLocal(s.pos), q: [q.x, q.y, q.z, q.w] };
    });
    return new Response(JSON.stringify({ schema: 'aio.flight/1', samples }));
  }
  return new Response('Not found', { status: 404 });
};

async function main() {
  const packs = [];
  for (const id of ['world', 'gcc', 'kuwait']) {
    const res = await realFetch(`${PACKS}${id}.json`);
    if (res.ok) packs.push(await res.json());
  }
  const ortho = await (await realFetch(`${FIX}ortho.json`)).json();
  const pe = ortho.placement_plant_EN;
  const start = Date.parse('2023-02-21T13:32:33Z');
  const lens = { model: 'pinhole', hfovDeg: 83, aspect: 1.896 };
  const clip = (id, file, offset) => ({
    kind: 'video',
    id,
    name: id,
    visible: true,
    src: { path: `video/${id}.mp4` },
    flight: { src: { path: `flights/${file}` }, startUtcMs: start + offset },
    lens,
    offsetMs: 0,
  });
  const manifest = {
    schema: 'aio.project/1',
    id: 'demo',
    name: 'Al-Zour harness',
    crs: { epsg: 32639 },
    origin: ORIGIN,
    captures: [],
    layers: [
      {
        kind: 'raster',
        id: 'ortho',
        name: 'Ortho',
        visible: true,
        role: 'ortho',
        format: 'image',
        src: { path: 'rasters/ortho.jpg' },
        corners: {
          tl: plantEnToLocal(pe.top_left),
          tr: plantEnToLocal(pe.top_right),
          bl: plantEnToLocal(pe.bottom_left),
        },
      },
      clip('dji0665', 'clip_dji0665_overview_path.json', 0),
      clip('dji0789', 'clip_dji0789_tanks_path.json', 60_000),
    ],
    severityModels: [],
    classCatalogues: [],
  };
  const now = new Date().toISOString();
  const issue = (id, code, severity, sighting) => ({
    id,
    code,
    classId: 'c',
    severityModelId: 'm',
    severity,
    status: 'draft',
    title: code,
    note: '',
    author: 'harness',
    createdAt: now,
    updatedAt: now,
    source: 'human',
    sightings: [sighting],
  });
  workspace.getState().openProject({ id: 'demo', root: '', manifest }, [
    issue('i1', 'F01', 5, {
      on: 'mesh',
      layer: 'm',
      geom: { type: 'spoint', p: [0, 50, 0], n: [0, 1, 0] },
    }),
    issue('i2', 'F02', 3, {
      on: 'pointcloud',
      layer: 'c',
      geom: { type: 'point3', p: modelToLocal([290.7, 0, -105.4]) },
    }),
  ]);

  const ctl = createMapController(document.getElementById('map'), {
    packs,
    store: workspace,
    showFlights: true,
    packBase: PACKS,
  });
  new ResizeObserver(() => ctl.resize()).observe(document.getElementById('map'));

  // Loop the active clip's 11 s so the drone and footprint move.
  setInterval(() => {
    const s = workspace.getState();
    const layer = s.project?.manifest.layers.find((l) => l.id === s.activeClip);
    if (!layer) return;
    const t0 = layer.flight.startUtcMs;
    s.setTime(t0 + ((s.nowMs - t0 + 100) % 11_000));
  }, 100);
  const info = document.getElementById('info');
  workspace.subscribe((s) => {
    info.textContent = `packs: ${packs.map((p) => p.id).join(', ')} | clip ${s.activeClip} | selection ${
      s.selection ? `${s.selection.kind}:${s.selection.id}` : 'none'
    }`;
  });
  window.__ws = workspace;
  window.__map = ctl.map;
}

void main();
