/**
 * The one Show control (volumetrics redesign, board 1): in the right panel's Layers & display tab,
 * its "Surface and piles" section (UI revision W10/W13: it left the stage, so nothing stands at the
 * stage's top left at open), a caption "Show", the surface (Photo | Elevation | Cut & fill) and the
 * pile overlays (Outlines | Labels, each on its own). It replaces the surface colours that the
 * Volumes bench and the notch's Volumes row used to carry. On the Materials pane it reads "Colour
 * piles by" Material | Change | None in place of the surface, with the overlays under it. The
 * overlays and the colouring apply while the project has piles (`active`: the section is there to
 * bring them back), and a project change puts them back.
 *
 * The surface writes the stockpile kit's `surface` in a kit project; its Elevation colours are
 * draped in 3D only, so picked from the Map it brings the 3D view (`showKitElevation`). Elsewhere
 * (a survey project's
 * piles) Photo and Elevation swap each shown survey date's ortho for its surface raster and back,
 * and Cut & fill turns the survey comparison's heat map on (Photo and Elevation turn it off): the
 * focused pile's, else the whole site's between the compare pair with its legend (stageCutFill.tsx).
 *
 * Which pane is up lives in one store (`volumesPane`, survey/volumes/volumesPane.ts): `pane` here
 * follows it and `setPane` writes it, so the Volumes tab's segments, this control, the sidebar and
 * `openMaterialsPane` always agree. The pile drawing reads the Outlines, Labels and colour choices
 * from `stageShow`.
 */
import type { Layer } from '@aio/schema';
import { t, Tip, toast, useT, type MessageKey } from '@aio/ui';
import { useVolumetric, volumetric, type SurfaceMode } from '@aio/volumetric';
import { canCompare, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useId } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { shell } from '../shell';
import { compareStore, setHeat, useCompare } from '../survey/compareStore';
import { volumesPane, type VolumesPane } from '../survey/volumes/volumesPane';
import { useCaptureIndex } from './compare';
import { stagePrefs } from './stagePrefs';
import { useHasVolumeMeasurements, useKitVolumes } from './workbench/view';
import './stageShow.css';

/** How piles are coloured on the Materials pane. */
export type ColourBy = 'material' | 'change' | 'none';
export type { VolumesPane };

export interface StageShowState {
  /** The pile outlines are drawn. */
  outlines: boolean;
  /** The pile labels are drawn. */
  labels: boolean;
  colourBy: ColourBy;
  /** The Volumes tab's pane in front: a read of `volumesPane`, kept in step with it. */
  pane: VolumesPane;
  /** The surface of a project without the kit (the kit keeps its own in `volumetric`). */
  surface: SurfaceMode;
  /**
   * The control is reachable (the project has piles, so Layers & display holds it): only then do
   * Outlines, Labels and "Colour piles by" apply to the pile drawing, so nothing stays hidden or
   * recoloured without a control to bring it back.
   */
  active: boolean;
  setActive(on: boolean): void;
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
  surface: 'photo',
} as const;

export const stageShow = createStore<StageShowState>()((set, get) => ({
  ...INITIAL,
  pane: volumesPane.getState().pane,
  active: false,
  setActive: (active) => {
    if (get().active !== active) set({ active });
  },
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
    // written to the one store; `pane` here follows it (below)
    volumesPane.getState().setPane(pane);
  },
  setSurface: (surface) => {
    set({ surface });
  },
  reset: () => {
    set({ ...INITIAL });
    volumesPane.getState().setPane('inventory');
  },
}));

// `pane` follows the one store, whoever writes it (the segments, openMaterialsPane, setPane)
volumesPane.subscribe((s) => {
  if (stageShow.getState().pane !== s.pane) stageShow.setState({ pane: s.pane });
});

// another project (or none) starts from the default surface, overlays and colouring
workspace.subscribe((s, p) => {
  if ((s.project?.id ?? null) !== (p.project?.id ?? null)) stageShow.setState({ ...INITIAL });
});

export function useStageShow<T>(selector: (s: StageShowState) => T): T {
  return useStore(stageShow, selector);
}

/**
 * The Show control is reachable: the project has piles (the stockpile kit's or volume
 * measurements), so Layers & display shows its section. Published as `stageShow.active` for the
 * pile drawing (the stage calls this once).
 */
export function useStageShowActive(): boolean {
  const kit = useKitVolumes();
  const piles = useHasVolumeMeasurements();
  const shown = kit || piles;
  useEffect(() => {
    stageShow.getState().setActive(shown);
  }, [shown]);
  useEffect(
    () => () => {
      stageShow.getState().setActive(false);
    },
    [],
  );
  return shown;
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

/** A 3D view is on the stage: the 3D mode, or a split with a 3D side (the default split has one). */
function threeDShown(): boolean {
  const mode = shell.getState().stageMode;
  if (mode !== 'split') return mode === '3d';
  const id = workspace.getState().project?.id;
  const split = id ? stagePrefs.getState().byProject[id]?.split : undefined;
  return split ? split.left === '3d' || split.right === '3d' : true;
}

/**
 * The kit drapes its elevation colours on the 3D terrain only, so the press always has a result
 * to see: from Map the stage goes to 3D (the toolbar's own view-mode action) with a notice that
 * says why; a split without a 3D side stays as the person set it up and the notice says where the
 * colours show.
 */
function showKitElevation(): void {
  if (threeDShown()) return;
  const sh = shell.getState();
  if (sh.stageMode === 'map') sh.setStageMode('3d');
  toast(t('show.elevation.in3d'), { id: 'show-elevation-3d', testId: 'show-elevation-3d' });
}

/** The surface choice: the kit's own, or the survey project's rasters and heat map. */
function useSurface(): {
  value: SurfaceMode;
  disabled: (s: SurfaceMode) => boolean;
  /** Why a surface is off, where the control alone does not say (null: on, or plain enough). */
  reason: (s: SurfaceMode) => MessageKey | null;
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
      reason: () => null,
      pick: (s) => {
        const v = volumetric.getState();
        if (v.swipe) v.setSwipe(false);
        v.setSurface(s);
        if (s === 'elev') showKitElevation();
      },
    };
  const hasDsm = layers.some((l) => isRaster(l, 'dsm'));
  const dated = index !== null && canCompare(index);
  return {
    // Cut & fill reads as on only while the heat map is
    value: own === 'change' && !heatOn ? 'photo' : own,
    disabled: (s) => (s === 'elev' && !hasDsm) || (s === 'change' && !dated),
    reason: (s) => (s === 'elev' && !hasDsm ? 'show.elevation.none' : null),
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
  reason,
  onPick,
}: {
  /** The row's own name (none: it is named by the control around it). */
  label?: string;
  options: readonly { value: V; label: string }[];
  value: V;
  disabled?: (v: V) => boolean;
  /** Why an option that is off is off, where the row alone does not say (null: nothing to add). */
  reason?: (v: V) => string | null;
  onPick: (v: V) => void;
}) {
  const id = useId();
  /** The off options that say why, each with the id of its description. */
  const why = options.flatMap((o) => {
    const text = disabled?.(o.value) === true ? (reason?.(o.value) ?? null) : null;
    return text === null ? [] : [{ value: o.value, text, id: `${id}-${o.value}` }];
  });
  return (
    <>
      <div className="seg stage-show-seg" role={label ? 'group' : undefined} aria-label={label}>
        {options.map((o) => {
          const off = why.find((w) => w.value === o.value);
          if (off)
            return (
              // greyed with its reason in a tip (no native title), and still focusable to read it
              <Tip key={o.value} content={off.text}>
                <button
                  type="button"
                  aria-pressed={value === o.value}
                  aria-disabled="true"
                  aria-describedby={off.id}
                >
                  {o.label}
                </button>
              </Tip>
            );
          return (
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
          );
        })}
      </div>
      {why.map((w) => (
        <span key={w.value} id={w.id} className="sr-only">
          {w.text}
        </span>
      ))}
    </>
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
      reason={(v) => {
        const key = s.reason(v);
        return key ? t(key) : null;
      }}
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

/** "Colour piles by", on the Materials pane: its caption over Material | Change | None. */
function ColourBy() {
  const t = useT();
  const colourBy = useStageShow((s) => s.colourBy);
  const caption = t('materials.colourBy');
  return (
    <>
      <span className="stage-show-cap" aria-hidden="true">
        {caption}
      </span>
      <Seg
        label={caption}
        options={COLOUR_BY.map((o) => ({ value: o.value, label: t(o.label) }))}
        value={colourBy}
        onPick={(by) => {
          stageShow.getState().setColourBy(by);
        }}
      />
    </>
  );
}

/**
 * The Show control: the surface and the pile overlays, and on the Materials pane "Colour piles by"
 * between them (the whole section stays reachable from Layers & display on every pane).
 */
export function StageShow() {
  const t = useT();
  const pane = useStageShow((s) => s.pane);
  return (
    <div
      className="stage-show"
      role="group"
      aria-label={t('show.caption')}
      data-testid="stage-show"
    >
      <span className="stage-show-cap" aria-hidden="true">
        {t('show.caption')}
      </span>
      <Surfaces />
      {pane === 'materials' && <ColourBy />}
      {/* Outlines and Labels stay reachable on every pane, so a pile is never left hidden */}
      <Overlays />
    </div>
  );
}
