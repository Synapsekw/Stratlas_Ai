/**
 * Engine dev harness. Opens the Al-Zour plant (with its ortho) or the HCl tank in SceneView,
 * as a native project would: mesh layer transforms bring each model frame into the local frame
 * (Y up, X east, Z south). Query: ?p=alzour|hcl&view=top|north|iso&perf=1
 */
import type { Layer, ProjectManifest, Vec3 } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  SceneView,
  configureEngine,
  getActiveStage,
  onActiveScene,
  registerEngineAdapters,
  type ViewPreset,
} from '../src/index';

configureEngine({
  resolveUrl: (_id, ref) => ('path' in ref ? `/${ref.path}` : ''),
  devTools: true,
});
registerEngineAdapters();

// Al-Zour plant grid to UTM 39N grid north: plant north is 17.9991 deg east of grid north.
const C = Math.cos((17.9991 * Math.PI) / 180);
const S = Math.sin((17.9991 * Math.PI) / 180);
const PLANT_TO_LOCAL = [C, 0, S, 0, 0, 1, 0, 0, -S, 0, C, 0, 0, 0, 0, 1];
const rot = (x: number, y: number, z: number): Vec3 => [C * x - S * z, y, S * x + C * z];
// HCl tank frame (X north, Y up, Z east) to the local frame.
const TANK_TO_LOCAL = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];

function manifest(id: string, name: string, origin: Vec3, layers: Layer[]): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id,
    name,
    crs: { epsg: 32639 },
    origin,
    captures: [],
    layers,
    severityModels: [],
    classCatalogues: [],
  };
}

const PROJECTS: Record<string, ProjectManifest> = {
  alzour: manifest(
    'alzour',
    'Al-Zour LNG terminal',
    [245_713.5, 3_179_541.98, 100],
    [
      {
        kind: 'raster',
        id: 'ortho',
        name: 'Drone ortho',
        visible: true,
        src: { path: 'alzour/ortho.jpg' },
        role: 'ortho',
        format: 'image',
        corners: {
          tl: rot(-1030.75, 0.3, -212.79),
          tr: rot(1044.35, 0.3, -886.99),
          bl: rot(-627.25, 0.3, 1029.13),
        },
      },
      {
        kind: 'mesh',
        id: 'plant',
        name: 'Plant model',
        visible: true,
        src: { path: 'alzour/plant.glb' },
        transform: PLANT_TO_LOCAL,
        tags: [
          { node: '20-T-0001', tag: '20-T-0001', area: 'LNG tanks' },
          { node: '20-T-0002', tag: '20-T-0002', area: 'LNG tanks' },
          { node: '20-T-0003', tag: '20-T-0003', area: 'LNG tanks' },
          { node: '20-T-0004', tag: '20-T-0004', area: 'LNG tanks' },
          { node: '60-A-0001', tag: '60-A-0001', area: 'Flare' },
          { node: '10-Z-0001A', tag: '10-Z-0001A', area: 'Jetty' },
        ],
      },
    ],
  ),
  hcl: manifest(
    'hcl',
    'HCl tank 710-D-130335',
    [0, 0, 0],
    [
      {
        kind: 'mesh',
        id: 'tank',
        name: 'Tank model',
        visible: true,
        src: { path: 'hcl/tank.glb' },
        transform: TANK_TO_LOCAL,
        tags: [
          { node: 'M1_Blind', tag: 'M1', area: 'Manhole' },
          { node: 'N1_Flange', tag: 'N1', area: 'Nozzle' },
          { node: 'N6_Blind', tag: 'N6', area: 'Nozzle' },
        ],
      },
    ],
  ),
};

const params = new URLSearchParams(location.search);
const pid = params.get('p') ?? 'alzour';
const m = PROJECTS[pid] ?? PROJECTS.alzour;
if (m) workspace.getState().openProject({ id: m.id, root: '/', manifest: m });

declare global {
  interface Window {
    __stage?: ReturnType<typeof getActiveStage>;
    __workspace?: typeof workspace;
  }
}
window.__workspace = workspace;
onActiveScene(() => {
  window.__stage = getActiveStage();
});

const btn = {
  padding: '4px 10px',
  background: '#222a31',
  color: '#e8ecf0',
  border: '1px solid #39434d',
};

function App() {
  const [sidebar, setSidebar] = useState(true);
  const [tool, setTool] = useState('select');
  useEffect(() => {
    const view = params.get('view') as ViewPreset | null;
    if (!view) return;
    const t = setInterval(() => {
      const s = getActiveStage();
      if (s?.scene.children.some((c) => c.name.startsWith('layer:'))) {
        s.setViewPreset(view);
        clearInterval(t);
      }
    }, 200);
    return () => {
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    if (params.get('perf') === '1') getActiveStage()?.setPerfOverlay(true);
  }, []);
  const preset = (p: ViewPreset | 'home') => () => getActiveStage()?.setViewPreset(p);
  const useTool = (t: 'select' | 'measure' | 'section') => () => {
    getActiveStage()?.setTool(t);
    setTool(t);
  };
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <aside
        style={{
          width: sidebar ? 252 : 52,
          transition: 'width .2s',
          background: '#1b2026',
          flex: 'none',
        }}
      />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, padding: 6 }}>
          <button
            style={btn}
            onClick={() => {
              setSidebar((v) => !v);
            }}
          >
            Sidebar
          </button>
          <button style={btn} onClick={preset('home')}>
            Home
          </button>
          <button style={btn} onClick={preset('top')}>
            Top
          </button>
          <button style={btn} onClick={preset('north')}>
            North
          </button>
          <button style={btn} onClick={preset('iso')}>
            Iso
          </button>
          <button style={btn} onClick={useTool('select')}>
            Select
          </button>
          <button style={btn} onClick={useTool('measure')}>
            Measure
          </button>
          <button style={btn} onClick={useTool('section')}>
            Section
          </button>
          <span style={{ alignSelf: 'center', opacity: 0.6 }}>tool: {tool}</span>
        </div>
        <SceneView className="stage" />
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
