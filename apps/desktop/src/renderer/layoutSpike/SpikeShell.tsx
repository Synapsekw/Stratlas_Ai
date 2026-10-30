/**
 * The Wave 2 layout spike (UI revision W4, gate G1), behind `quadrion.flags.layoutV2` and
 * Ctrl+Alt+L: the 52 px rail on every screen, and on the Scene the title bar, the Layers column,
 * the stage with the island and its fixed slots, the bottom strip with the docked video tile, and
 * the right panel's four fixed tabs, all at the D1 band sizes. Today's panels are reused by
 * import; nothing of today's shell changes while the flag is off. Deleted in W12.
 */
import { inventoryPiles } from '@aio/survey';
import { t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useIsRoad } from '../road/useRoadMap';
import { NoProject } from '../screens/NoProject';
import { shell, useShell } from '../shell';
import { Datasets } from '../shell/Sidebar';
import { useMeasure } from '../survey/measureStore';
import { Stage } from '../workspace/Stage';
import {
  applyPreset,
  BANDS,
  bandOf,
  clampRight,
  PRESETS,
  projectData,
  purposeOf,
  RAIL_PX,
  STRIP_FOLDED_PX,
  TITLE_PX,
  type ProjectData,
} from './model';
import { SpikeBottomStrip } from './SpikeBottomStrip';
import { SpikeRail } from './SpikeRail';
import { SpikeRightPanel } from './SpikeRightPanel';
import { SpikeStageUi } from './SpikeStageUi';
import { SpikeTitleBar } from './SpikeTitleBar';
import { spike, useSpike } from './spikeStore';
import './spike.css';

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => {
      setW(window.innerWidth);
    };
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
    };
  }, []);
  return w;
}

function useProjectData(): ProjectData | null {
  const project = useWorkspace((s) => s.project);
  const piles = useMeasure((s) => inventoryPiles(s.file.measurements).length > 0);
  const road = useIsRoad();
  return useMemo(
    () => (project ? projectData(project.manifest, { piles, road }) : null),
    [project, piles, road],
  );
}

/**
 * The stage's own video window steps aside while the spike shows the clip in its tile or its
 * pop-out (one player, one place). Anything that asks to show the stage's video again (the V key,
 * the old island tile) brings the spike's tile back instead.
 */
function useStageVideoAside() {
  useEffect(() => {
    const was = shell.getState().videoHidden;
    shell.getState().setVideoHidden(true);
    const off = shell.subscribe((s, prev) => {
      if (!s.videoHidden && prev.videoHidden) {
        if (spike.getState().video === 'closed') spike.getState().setVideo('docked');
        shell.getState().setVideoHidden(true);
      }
    });
    return () => {
      off();
      shell.getState().setVideoHidden(was);
    };
  }, []);
}

/** The stage's width as a share of the window, measured from the DOM. */
function useStageShare(): { ref: React.RefObject<HTMLDivElement | null>; share: number | null } {
  const ref = useRef<HTMLDivElement>(null);
  const [share, setShare] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      setShare(Math.round((el.getBoundingClientRect().width / window.innerWidth) * 100));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    window.addEventListener('resize', read);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', read);
    };
  }, []);
  return { ref, share };
}

function SpikeScene() {
  useT();
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const data = useProjectData();
  const width = useWindowWidth();
  const band = bandOf(width);
  const sizes = BANDS[band];
  const pick = useSpike((s) => s.pick);
  const own = manifest ? purposeOf(manifest) : 'data-fusion';
  const purpose = pick ?? own;
  const preset = PRESETS[purpose];
  const layersHand = useSpike((s) => s.layers);
  const strip = useSpike((s) => s.strip);
  const folded = useSpike((s) => s.stripFolded);
  const dragged = useSpike((s) => s.rightPx[band]);
  const rightPx = clampRight(band, dragged ?? sizes.rightPx);
  const { ref: shareRef, share } = useStageShare();
  useStageVideoAside();

  // the preset's defaults on project open and on another preset (D7: defaults only)
  // (again when the project's data arrives: the road and the piles load after the manifest)
  const sig = data
    ? Object.entries(data)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(',')
    : '';
  const key = projectId && data ? `${projectId}:${purpose}:${sig}` : null;
  useEffect(() => {
    if (!key || !data || spike.getState().applied === key) return;
    const d = applyPreset(preset, data);
    spike.getState().apply(key, d);
    shell.getState().setStageMode(d.stage);
  }, [key, data, preset]);

  const layersDefault = band === 'wide' ? preset.layersOpenWide : false;
  const layersOpen = layersHand ?? layersDefault;
  const overlay = band === 'narrow';

  // Ctrl+L toggles Layers; Escape closes it while it lies over the stage
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyL') {
        e.preventDefault();
        spike.getState().setLayers(!layersOpen);
      } else if (e.key === 'Escape' && overlay && layersOpen) {
        spike.getState().setLayers(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [layersOpen, overlay]);

  if (!projectId || !data) return <NoProject view="Scene" />;
  const style = {
    '--spk-layers': layersOpen && !overlay ? `${String(sizes.layersPx)}px` : '0px',
    '--spk-right': `${String(rightPx)}px`,
    '--spk-strip': `${String(folded ? STRIP_FOLDED_PX : sizes.stripPx)}px`,
    '--spk-title': `${String(TITLE_PX)}px`,
  } as CSSProperties;
  return (
    <section
      className="screen ws spk-ws"
      aria-label="Scene"
      style={style}
      data-band={band}
      data-layers={layersOpen ? (overlay ? 'overlay' : 'open') : 'closed'}
      data-testid="spike-scene"
    >
      <SpikeTitleBar own={own} layersOpen={layersOpen} share={share} />
      {layersOpen && (
        <aside
          className="spk-layers"
          aria-label={t('layoutSpike.layers')}
          data-testid="spike-layers"
          data-overlay={overlay ? '' : undefined}
        >
          <Datasets collapsed={false} />
        </aside>
      )}
      {layersOpen && overlay && (
        <div
          className="spk-layers-scrim"
          aria-hidden="true"
          onPointerDown={() => {
            spike.getState().setLayers(false);
          }}
        />
      )}
      <div ref={shareRef} className="spk-stage-cell">
        <Stage />
        <SpikeStageUi data={data} stageRef={shareRef} />
      </div>
      <SpikeBottomStrip data={data} mode={strip} />
      <SpikeRightPanel preset={preset} data={data} band={band} width={rightPx} />
    </section>
  );
}

/**
 * The spike in place of today's sidebar and main area: the rail beside every screen; the Scene in
 * the new frame, the other screens as they are.
 */
export function SpikeShell({ screen, dock }: { screen: ReactNode; dock: ReactNode }) {
  const current = useShell((s) => s.screen);
  return (
    <>
      <SpikeRail />
      <main
        className="main spk-main"
        style={{ '--spk-rail': `${String(RAIL_PX)}px` } as CSSProperties}
      >
        {current === 'scene' ? (
          <SpikeScene />
        ) : (
          <>
            {screen}
            {dock}
          </>
        )}
      </main>
    </>
  );
}
