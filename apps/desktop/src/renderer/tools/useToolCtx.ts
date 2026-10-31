/**
 * The tool registry's context, read from the stores (`useToolCtx`), and the pure step under it
 * (`toolCtxOf`): what the project holds and the view in use, never its type or purpose.
 */
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import type { ProjectManifest } from '@aio/schema';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useShell } from '../shell';
import { useMeasure } from '../survey/measureStore';
import { useActiveSpace } from '../spaces/activeSpace';
import type { CompareDates } from '../workspace/CompareControls';
import { streetMapTool } from '../workspace/siteBasemap';
import { useEngineStage } from '../workspace/StageTools';
import { useDockClip } from '../workspace/video/videoDockStore';
import { useStreetMap3d } from '../workspace/streetMap3d';
import { layerData, usePanelData } from '../workspace/workbench/panelData';
import type { PanelData } from '../workspace/workbench/tabsModel';
import type { ToolCtx } from './registry';

/**
 * The stage's comparison of dates, as the island (which has the split) publishes it, so the Tools
 * tab and the palette reach Compare dates without a split of their own.
 */
export const stageCompare = createStore<{ compare: CompareDates | null }>(() => ({
  compare: null,
}));

/** The island publishes its comparison while it is mounted (one stage, one island). */
export function usePublishCompare(compare: CompareDates): void {
  const latest = useRef(compare);
  useLayoutEffect(() => {
    latest.current = compare;
  });
  const { available, twin, label } = compare;
  useEffect(() => {
    stageCompare.setState({
      compare: {
        available,
        twin,
        label,
        open: (captures) => {
          latest.current.open(captures);
        },
      },
    });
  }, [available, twin, label]);
  useEffect(
    () => () => {
      stageCompare.setState({ compare: null });
    },
    [],
  );
}

/** What the context is built from, besides the stage and the comparison. */
export interface ToolCtxInput extends Omit<ToolCtx, 'data' | 'stage' | 'compare'> {
  /** The project's layers: the data kinds it holds. Only the layers are read. */
  manifest: Pick<ProjectManifest, 'layers'> & Partial<ProjectManifest>;
  /** The data the stores know beside the layers. */
  dated: boolean;
  volumes: boolean;
  road: boolean;
}

/** The context from what the project holds (pure): the manifest's layers, never its type. */
export function toolCtxOf(
  input: ToolCtxInput,
  extra: Pick<ToolCtx, 'stage' | 'compare'> = { stage: null, compare: null },
): ToolCtx {
  const { manifest, dated, volumes, road, ...rest } = input;
  const data: PanelData = {
    ...layerData(new Set(manifest.layers.map((l) => l.kind))),
    dated,
    volumes,
    road,
  };
  return { ...rest, data, ...extra };
}

/**
 * The open project's tool context. `compare` is the caller's comparison of dates (the island's),
 * else the one the island published;
 * `tools` the panes the tools work on, where the caller knows better than the stage view (a split
 * may show neither the 3D view nor the map).
 */
export function useToolCtx(
  opts: {
    compare?: CompareDates | null;
    tools?: ToolCtx['tools'];
    /** The stage the caller has (the island's), else the active one. */
    stage?: ToolCtx['stage'];
  } = {},
): ToolCtx {
  const published = useStore(stageCompare, (s) => s.compare);
  const compare = opts.compare ?? published;
  const tools = opts.tools;
  const data = usePanelData();
  const mode = useShell((s) => s.stageMode);
  const pkg = useShell((s) => s.pkg !== null);
  const readOnly = useMeasure((s) => s.readOnly) || pkg;
  const measuresReady = useMeasure((s) => s.status === 'ready');
  const active = useEngineStage();
  const stage = opts.stage === undefined ? active : opts.stage;
  const selection = useWorkspace((s) => s.selection !== null);
  const { mapAvailable } = useActiveSpace();
  // the clip the video dock shows: the active one, else the project's first video (W9)
  const clip = useDockClip() !== null;
  const kit = useVolumetric((s) => s.status === 'ready');
  const kitDates = useVolumetric((s) => s.file?.captures.length ?? 0);
  const street = streetMapTool(useStreetMap3d());
  const streetMap: ToolCtx['streetMap'] = street
    ? street.disabled
      ? { reason: street.label }
      : true
    : null;
  const streetKey = streetMap === null ? '' : streetMap === true ? 'on' : streetMap.reason;
  return useMemo(
    () => ({
      data,
      mode,
      // the tools work on the map alone only when the map is all the stage shows
      tools: tools ?? mode,
      stage3d: stage !== null && mode !== 'map',
      mapAvailable,
      pkg,
      readOnly,
      selection,
      clip,
      kit,
      kitDates,
      streetMap,
      measuresReady,
      compare,
      stage,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `streetKey` stands for `streetMap`
    [
      data,
      mode,
      tools,
      stage,
      mapAvailable,
      pkg,
      readOnly,
      selection,
      clip,
      kit,
      kitDates,
      streetKey,
      measuresReady,
      compare,
    ],
  );
}
