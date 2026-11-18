/**
 * The cut and fill heat map's legend on the stage: the store-free drawing in heatLegendView.tsx
 * plus the site's length unit as the default. The report page imports the view directly.
 */
import { effectiveUnits, sideOptions } from '@aio/survey';
import { useT } from '@aio/ui';
import { useMemo, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { useShell } from '../shell';
import { useSplitShowsMap } from '../spaces/splitMap';
import { baseName } from './card/baseNames';
import { useCompare } from './compareStore';
import {
  HeatLegendView,
  LEGEND_RANGE_M,
  type HeatLegendViewProps,
  type OwnHeat,
} from './heatLegendView';
import { activeHeat } from './heatScene';
import { measureStore, useMeasure } from './measureStore';
import { pileLookState } from './pile/pileLookState';

export { LEGEND_RANGE_M };

export interface HeatLegendProps extends Omit<HeatLegendViewProps, 'unit' | 'own'> {
  /** The length unit heights are written in; default the site's. */
  unit?: HeatLegendViewProps['unit'];
}

/**
 * Whether a view on the stage draws the focused measurement's own heat map (`own`: it has one)
 * and not the whole site's, as survey/heatScene.ts decides it: the Map draws it while its heat
 * map is on; the 3D view too, except while the pile shows as its lifted box (`boxed`), when the
 * site keeps its heat map there.
 */
export function ownHeatDrawn(x: {
  own: boolean;
  /** The stage's mode: '3d', 'map' or 'split' (any other shows neither view). */
  mode: string;
  /** The Split has a Map pane. */
  splitMap: boolean;
  show2d: boolean;
  show3d: boolean;
  boxed: boolean;
}): boolean {
  if (!x.own) return false;
  const onMap = x.show2d && (x.mode === 'map' || (x.mode === 'split' && x.splitMap));
  const inScene = x.show3d && !x.boxed && (x.mode === '3d' || x.mode === 'split');
  return onMap || inScene;
}

/** The focused pile's own heat map while a view draws it: the pile and its comparison's sides. */
function useOwnHeat(): OwnHeat | null {
  const t = useT();
  const mode = useShell((s) => s.stageMode);
  const splitMap = useSplitShowsMap();
  const boxShown = useStore(pileLookState, (s) => s.shown);
  const heat = useCompare((s) => s.heat);
  const computed = useCompare((s) => s.computed);
  const surfaces = useCompare((s) => s.surfaces);
  const captures = useCompare((s) => s.captures);
  const designs = useCompare((s) => s.designs);
  const focus = useMeasure((s) => s.focus);
  const file = useMeasure((s) => s.file);
  return useMemo(() => {
    const m = file.measurements.find((x) => x.id === focus);
    if (!m) return null;
    // the grid the views pick for the focused measurement (no site heat map given: its own only)
    const grid = activeHeat({ computed, heat }, measureStore.getState());
    const item = grid ? m.items.find((it) => it.id === grid.item) : undefined;
    const drawn = ownHeatDrawn({
      own: item !== undefined,
      mode,
      splitMap,
      show2d: heat.show2d,
      show3d: heat.show3d,
      boxed: boxShown === m.id,
    });
    if (!item || !drawn) return null;
    const capture = m.scope.kind === 'survey' ? m.scope.capture : undefined;
    const options = sideOptions({
      surfaces,
      captures,
      designs,
      ...(capture !== undefined ? { capture } : {}),
    });
    return {
      id: m.id,
      name: m.label,
      from: baseName(item.from, options, t),
      to: baseName(item.to, options, t),
    };
  }, [file, focus, computed, heat, mode, splitMap, boxShown, surfaces, captures, designs, t]);
}

/**
 * The legend of what the stage draws: the compare pair's cut and fill (`from`, `to`), or, while
 * a view draws the focused pile's own heat map instead, that pile and its own two sides. The
 * pile's heat map leaves no band out, so no "ignored" reads then.
 */
export function HeatLegend({ unit, thresholdM, ...rest }: HeatLegendProps): ReactElement {
  const siteUnit = useMeasure((s) => effectiveUnits(s.settings.units).distance);
  const own = useOwnHeat();
  return (
    <HeatLegendView {...rest} own={own} thresholdM={own ? 0 : thresholdM} unit={unit ?? siteUnit} />
  );
}

/** The stage's bottom-right hint while Cut & fill shows. */
export function CutFillHint({ className }: { className?: string }): ReactElement {
  const t = useT();
  return (
    <div className={['cf-hint', className].filter(Boolean).join(' ')}>{t('cutfill.clickPile')}</div>
  );
}
