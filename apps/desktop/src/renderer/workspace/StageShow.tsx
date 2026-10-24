/**
 * The one Show control (volumetrics redesign, board 1): top-left of the stage while the Volumes tab
 * is open, a caption "Show", the surface (Photo | Elevation | Cut & fill) and the pile overlays
 * (Outlines | Labels, each on its own). It replaces the surface colours that the Volumes bench and
 * the notch's Volumes row used to carry. On the Materials pane it reads "Colour piles by" Material
 * | Change | None instead.
 *
 * The surface writes the stockpile kit's `surface` in a kit project. Elsewhere (a survey project's
 * piles) Photo and Elevation swap each shown survey date's ortho for its surface raster and back,
 * and Cut & fill turns the survey comparison's heat map on (Photo and Elevation turn it off).
 *
 * The Volumes bench says which pane is up (`stageShow.setPane`); the pile drawing reads the
 * Outlines, Labels and colour choices from `stageShow`.
 */
import type { Layer } from '@aio/schema';
import { useT, type MessageKey } from '@aio/ui';
import { useVolumetric, volumetric, type SurfaceMode } from '@aio/volumetric';
import { canCompare, useWorkspace, workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { compareStore, setHeat, useCompare } from '../survey/compareStore';
import { useShell } from '../shell';
import { useCaptureIndex } from './compare';
import { useKitVolumes, useWorkbenchView } from './workbench/view';
import './stageShow.css';

/** How piles are coloured on the Materials pane. */
export type ColourBy = 'material' | 'change' | 'none';
/** The Volumes tab's panes (its segment). */
export type VolumesPane = 'inventory' | 'cutFill' | 'materials';

export interface StageShowState {
  /** The pile outlines are drawn. */
  outlines: boolean;
  /** The pile labels are drawn. */
  labels: boolean;
  colourBy: ColourBy;
  /** The Volumes tab's pane in front. */
  pane: VolumesPane;
  /** The surface of a project without the kit (the kit keeps its own in `volumetric`). */
  surface: SurfaceMode;
  setOutlines(on: boolean): void;
  setLabels(on: boolean): void;
  setColourBy(by: ColourBy): void;
  setPane(pane: VolumesPane): void;
  setSurface(surface: SurfaceMode): void;
  reset(): void;
}

const INITIAL = {
  outlines: true,
  labels: true,
  colourBy: 'material',
  pane: 'inventory',
  surface: 'photo',
} as const;

export const stageShow = createStore<StageShowState>()((set) => ({
  ...INITIAL,
  setOutlines: (outlines) => {
    set({ outlines });
  },
  setLabels: (labels) => {
    set({ labels });
  },
  setColourBy: (colourBy) => {
    set({ colourBy });
  },
  setPane: (pane) => {
    set({ pane });
  },
  setSurface: (surface) => {
    set({ surface });
  },
  reset: () => {
    set({ ...INITIAL });
  },
}));

export function useStageShow<T>(selector: (s: StageShowState) => T): T {
  return useStore(stageShow, selector);
}

/**
 * The corner box the control keeps to, so it never covers the view (the 1100 x 700 check): the
 * caption and two segmented rows.
 */
export const SHOW_BOX = { width: 260, height: 80 } as const;

/** The Show control is up: the Volumes tab is in front of an open right panel. */
export function useStageShowShown(): boolean {
  const { front } = useWorkbenchView();
  const collapsed = useShell((s) => s.rightCollapsed);
  return front.id === 'volumes' && !collapsed;
}

type RasterRole = 'ortho' | 'dsm';
const isRaster = (l: Layer, role: RasterRole): boolean => l.kind === 'raster' && l.role === role;

/**
 * The layers to show and hide to swap each survey date's shown rasters for the other kind: to
 * Elevation, a date whose ortho shows gets its surface raster (`dsm`) instead; to Photo, the other
 * way. `of` is the capture of each dated layer (undated rasters pair with each other); a date
 * without the other kind keeps what it shows.
 */
export function rasterSwap(
  layers: readonly Layer[],
  of: Readonly<Record<string, string>>,
  hidden: Readonly<Record<string, true>>,
  to: 'photo' | 'elev',
): { show: string[]; hide: string[] } {
  const from: RasterRole = to === 'elev' ? 'ortho' : 'dsm';
  const into: RasterRole = to === 'elev' ? 'dsm' : 'ortho';
  const dateOf = (l: Layer) => of[l.id] ?? '';
  const shownDates = new Set(layers.filter((l) => isRaster(l, from) && !hidden[l.id]).map(dateOf));
  const show: string[] = [];
  const hide: string[] = [];
  for (const date of shownDates) {
    const targets = layers.filter((l) => isRaster(l, into) && dateOf(l) === date);
    if (targets.length === 0) continue;
    show.push(...targets.filter((l) => hidden[l.id]).map((l) => l.id));
    hide.push(
      ...layers
        .filter((l) => isRaster(l, from) && dateOf(l) === date && !hidden[l.id])
        .map((l) => l.id),
    );
  }
  return { show, hide };
}

const SURFACES: readonly { value: SurfaceMode; label: MessageKey }[] = [
  { value: 'photo', label: 'show.photo' },
  { value: 'elev', label: 'show.elevation' },
  { value: 'change', label: 'show.cutFill' },
];
const COLOUR_BY: readonly { value: ColourBy; label: MessageKey }[] = [
  { value: 'material', label: 'materials.colourBy.material' },
  { value: 'change', label: 'materials.colourBy.change' },
  { value: 'none', label: 'materials.colourBy.none' },
];

const NO_LAYERS: readonly Layer[] = [];

/** The surface choice: the kit's own, or the survey project's rasters and heat map. */
function useSurface(): {
  value: SurfaceMode;
  disabled: (s: SurfaceMode) => boolean;
  pick: (s: SurfaceMode) => void;
} {
  const kit = useKitVolumes();
  const kitSurface = useVolumetric((s) => s.surface);
  const kitDates = useVolumetric((s) => s.file?.captures.length ?? 0);
  const own = useStageShow((s) => s.surface);
  const heatOn = useCompare((s) => s.heat.show3d || s.heat.show2d);
  const layers = useWorkspace((s) => s.project?.manifest.layers ?? NO_LAYERS);
  const index = useCaptureIndex();
  if (kit)
    return {
      value: kitSurface,
      disabled: (s) => s === 'change' && kitDates < 2,
      pick: (s) => {
        const v = volumetric.getState();
        if (v.swipe) v.setSwipe(false);
        v.setSurface(s);
      },
    };
  const hasDsm = layers.some((l) => isRaster(l, 'dsm'));
  const dated = index !== null && canCompare(index);
  return {
    // Cut & fill reads as on only while the heat map is
    value: own === 'change' && !heatOn ? 'photo' : own,
    disabled: (s) => (s === 'elev' && !hasDsm) || (s === 'change' && !dated),
    pick: (s) => {
      const ws = workspace.getState();
      if (s !== 'change') {
        const { show, hide } = rasterSwap(layers, index?.of ?? {}, ws.hidden, s);
        ws.applyVisibility(show, hide);
      }
      const heat = compareStore.getState().heat;
      const on = s === 'change';
      if (heat.show3d !== on || heat.show2d !== on) setHeat({ show3d: on, show2d: on });
      stageShow.getState().setSurface(s);
    },
  };
}

/** One segmented row: a pressed button per option. */
function Seg<V extends string>({
  label,
  options,
  value,
  disabled,
  onPick,
}: {
  /** The row's own name (none: it is named by the control around it). */
  label?: string;
  options: readonly { value: V; label: string }[];
  value: V;
  disabled?: (v: V) => boolean;
  onPick: (v: V) => void;
}) {
  return (
    <div className="seg stage-show-seg" role={label ? 'group' : undefined} aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={disabled?.(o.value) === true}
          onClick={() => {
            onPick(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Surfaces() {
  const t = useT();
  const s = useSurface();
  return (
    <Seg
      options={SURFACES.map((o) => ({ value: o.value, label: t(o.label) }))}
      value={s.value}
      disabled={s.disabled}
      onPick={s.pick}
    />
  );
}

function Overlays() {
  const t = useT();
  const outlines = useStageShow((s) => s.outlines);
  const labels = useStageShow((s) => s.labels);
  const st = stageShow.getState();
  return (
    <div className="seg stage-show-seg">
      <button
        type="button"
        aria-pressed={outlines}
        onClick={() => {
          st.setOutlines(!outlines);
        }}
      >
        <span className="stage-show-sq" aria-hidden="true" />
        {t('show.outlines')}
      </button>
      <button
        type="button"
        aria-pressed={labels}
        onClick={() => {
          st.setLabels(!labels);
        }}
      >
        {t('show.labels')}
      </button>
    </div>
  );
}

/** The Show control: on the Materials pane, "Colour piles by". */
export function StageShow() {
  const t = useT();
  const pane = useStageShow((s) => s.pane);
  const colourBy = useStageShow((s) => s.colourBy);
  const box = { maxInlineSize: SHOW_BOX.width, maxBlockSize: SHOW_BOX.height };
  if (pane === 'materials') {
    const caption = t('materials.colourBy');
    return (
      <div
        className="stage-show"
        style={box}
        role="group"
        aria-label={caption}
        data-testid="stage-show"
      >
        <span className="stage-show-cap" aria-hidden="true">
          {caption}
        </span>
        <Seg
          options={COLOUR_BY.map((o) => ({ value: o.value, label: t(o.label) }))}
          value={colourBy}
          onPick={(by) => {
            stageShow.getState().setColourBy(by);
          }}
        />
      </div>
    );
  }
  return (
    <div
      className="stage-show"
      style={box}
      role="group"
      aria-label={t('show.caption')}
      data-testid="stage-show"
    >
      <span className="stage-show-cap" aria-hidden="true">
        {t('show.caption')}
      </span>
      <Surfaces />
      <Overlays />
    </div>
  );
}
