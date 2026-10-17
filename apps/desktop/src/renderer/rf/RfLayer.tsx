/**
 * The Coverage layer (spec D16, D23, D23a): mounted once with the app, beside the other layer
 * hosts (`App.tsx`), it loads the RF store for the open project, follows the selected run and the
 * live preview (`coverageStore.ts`), gives the store the DSM ground (`dsmGround.ts`), and draws
 * the shown view on whichever map and 3D view are on screen through the active-view registry
 * (`useMap`, `useScene`), as the pinned media do. The stage files are not touched (ruling R5).
 */
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef } from 'react';
import { shiftEN } from '@aio/schema';
import { appBoundsDeps } from '../shell/appBounds';
import { useMap, useScene } from '../builder/activeViews';
import { imageUrl } from './coverageCanvas';
import { coverageImage } from './coverageImage';
import { coverageShift } from './coverageGrids';
import {
  groundZOf,
  mapPlacement,
  previewBoresights,
  runBoresights,
  scenePlacement,
} from './coverageDraw';
import { attachCoverageMap, type CoverageMapView } from './coverageMap';
import { attachCoverageScene, type CoverageSceneView } from './coverageScene';
import { followCoverage, refreshPreview, shownGrids, useCoverage } from './coverageStore';
import { dsmGroundProvider } from './dsmGround';
import { startPreviewWorker, type PreviewClient } from './previewClient';
import { loadRfLayer, useRfLayer } from './coverageDisplay';
import { loadRf, rfStore, selectRun, setDsmGroundProvider, useRf } from './rfStore';

/** A project file's bytes through the app's project protocol; null when it is missing. */
async function projectBytes(projectId: string, path: string): Promise<Uint8Array | null> {
  const r = await fetch(assetUrl(projectId, { path }));
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

/** Load the RF store for the open project (the RF tab does too) and pick its newest run once. */
function useRfProject(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const picked = useRef<string | null>(null);
  useEffect(() => {
    loadRfLayer(projectId);
    if (projectId && rfStore.getState().projectId !== projectId) void loadRf(projectId);
  }, [projectId]);
  useEffect(
    () =>
      rfStore.subscribe((s) => {
        // the newest finished run is shown when a project opens with runs and none is chosen
        if (s.status !== 'ready' || !s.projectId || picked.current === s.projectId) return;
        picked.current = s.projectId;
        const newest = s.runs.find((r) => r.status === 'done');
        if (s.selectedRunId === null && newest) void selectRun(newest.runId);
      }),
    [],
  );
}

/** The DSM ground near a tower base, read where the 3D view draws the project's DSMs. */
function useDsmGround(): void {
  const scene = useScene();
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const projectId = useRf((s) => s.projectId);
  const antennas = useRf((s) => s.antennas);
  const needed = antennas !== null && antennas.run.groundZ === undefined;
  useEffect(() => {
    if (!needed || !scene || !manifest) return;
    const dsm = manifest.layers
      .filter((l) => l.kind === 'raster' && l.role === 'dsm')
      .map((l) => l.id);
    if (dsm.length === 0) return;
    // the shell's ray straight down onto one layer (Drop to ground's DSM ground)
    const deps = appBoundsDeps();
    const provider = dsmGroundProvider(dsm, manifest.origin, (x, z, layer) =>
      deps.rayDown(x, z, layer),
    );
    // the inventory is stored unshifted; its tower is drawn moved by its date's line-up shift
    const shift = coverageShift(antennas, manifest);
    setDsmGroundProvider((east, north) => {
      const [e, n] = shiftEN([east, north] as [number, number], shift);
      return provider(e, n);
    });
    refreshPreview();
    return () => {
      setDsmGroundProvider(null);
    };
  }, [needed, scene, manifest, projectId, antennas]);
}

export function RfLayer(): null {
  useRfProject();
  useDsmGround();

  // the run and preview controller, with the preview Worker started when first needed; a new
  // project starts both again, so no path-loss grid of the last project stays in memory
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  useEffect(() => {
    let client: PreviewClient | null = null;
    const stop = followCoverage({
      bytes: projectBytes,
      client: () => (client ??= startPreviewWorker()),
    });
    return () => {
      stop();
      client?.dispose();
    };
  }, [projectId]);

  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const dirty = useRf((s) => s.dirty);
  const view = useRf((s) => s.view);
  const antennas = useRf((s) => s.antennas);
  const runs = useRf((s) => s.runs);
  const selectedRunId = useRf((s) => s.selectedRunId);
  const rows = useRf((s) => s.rows);
  const grids = useCoverage((c) => shownGrids(c, { dirty }));
  const previewSources = useCoverage((c) => c.previewSources);
  const visible = useRfLayer((s) => s.visible);
  const opacity = useRfLayer((s) => s.opacity);
  const hatch = useRfLayer((s) => s.hatch);
  const showFrom = useRfLayer((s) => s.showFrom);

  const run =
    grids?.source === 'run' ? (runs.find((r) => r.runId === selectedRunId) ?? null) : null;
  const shift = useMemo(() => coverageShift(antennas, manifest), [antennas, manifest]);
  const image = useMemo(
    () => (grids ? coverageImage(grids, { view, hatch, showFrom }) : null),
    [grids, view, hatch, showFrom],
  );
  const imageKey = grids ? `${grids.key}|${view}|${String(hatch)}|${showFrom}` : '';
  const bores = useMemo(
    () =>
      grids?.source === 'run' && run
        ? runBoresights(run)
        : grids
          ? previewBoresights(previewSources, antennas, grids.sectorIds)
          : [],
    [grids, run, previewSources, antennas],
  );

  // ---- the map
  const map = useMap();
  const mapView = useRef<CoverageMapView | null>(null);
  useEffect(() => {
    if (!map) return;
    const v = attachCoverageMap(map);
    mapView.current = v;
    return () => {
      mapView.current = null;
      v.dispose();
    };
  }, [map]);
  const url = useMemo(() => (image ? imageUrl(image) : null), [image]);
  const placed = useMemo(
    () => (grids && manifest ? mapPlacement(grids, manifest, shift, bores) : null),
    [grids, manifest, shift, bores],
  );
  useEffect(() => {
    mapView.current?.draw({
      image: url && placed ? { key: imageKey, url, corners: placed.corners } : null,
      arrows: placed?.arrows ?? [],
      visible,
      opacity,
    });
  }, [map, url, imageKey, placed, visible, opacity]);

  // ---- the 3D view
  const scene = useScene();
  const sceneView = useRef<CoverageSceneView | null>(null);
  useEffect(() => {
    if (!scene) return;
    const v = attachCoverageScene(scene);
    sceneView.current = v;
    return () => {
      sceneView.current = null;
      v.dispose();
    };
  }, [scene]);
  const ground = useMemo(() => groundZOf(run, rows, antennas), [run, rows, antennas]);
  useEffect(() => {
    const v = sceneView.current;
    if (!v) return;
    if (!grids || !image || !manifest) {
      v.draw({ sheet: null, arrows: [], visible, opacity });
      return;
    }
    const origin = manifest.origin;
    const p = scenePlacement(grids, origin, shift, bores);
    v.draw({
      sheet: {
        image,
        key: imageKey,
        centre: p.centre,
        sizeM: p.sizeM,
        groundY: (ground ?? origin[2]) - origin[2],
      },
      arrows: p.arrows,
      visible,
      opacity,
    });
  }, [scene, grids, image, imageKey, manifest, shift, bores, ground, visible, opacity]);

  // TODO(stage-3 T21): mount <CoverageLegend> here as one `assignSlots()` item wanting `bl` or
  // `br`, shown while `grids` is not null and the layer is visible:
  //   <CoverageLegend view={view} study={sectors.study} sectors={sectors.sectors} source={...} />
  return null;
}
