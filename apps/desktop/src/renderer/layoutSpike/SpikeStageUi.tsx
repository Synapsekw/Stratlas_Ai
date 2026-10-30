/**
 * What the spike lays over the stage (D3, D5): the island as a click-only mode switcher in the
 * top-centre slot, the outlines of the five fixed overlay slots (on request), and the popped-out
 * video window. Today's island is hidden under the spike (spike.css), not changed.
 */
import { Icon, t, useT } from '@aio/ui';
import { useEffect, useRef, type RefObject } from 'react';
import { shell, useShell } from '../shell';
import {
  entryOf,
  favouritesAndRecent,
  measureFavourites,
  useFavourites,
  type CatalogueTool,
} from '../survey/measureCatalogue';
import { measureStore, startTool, stopTool, useMeasure } from '../survey/measureStore';
import { useEngineStage } from '../workspace/StageTools';
import { toggleMeasure, toggleSection } from '../workspace/tools/measure';
import { islandModes, MODE_HOME, type IslandMode, type ProjectData } from './model';
import { SpikeFloatingVideo, useTileClip } from './SpikeBottomStrip';
import { spike, useSpike } from './spikeStore';

const MODE_ICON = {
  view: 'eye',
  measure: 'ruler',
  annotate: 'anno',
  volumes: 'pile',
  compare: 'split',
  video: 'video',
  road: 'road',
} as const;

/** The Measure mode's slim row: the favourites, then the recent tools, five at most. */
function MeasureRow() {
  const stage = useEngineStage();
  const fav = useFavourites((s) => s);
  const live = useMeasure((s) => s.tool?.tool ?? null);
  const tools = favouritesAndRecent(fav).slice(0, 5);
  const start = (tool: CatalogueTool) => {
    measureFavourites.getState().used(tool);
    if (tool === 'section-plane') {
      if (stage) toggleSection(stage);
      return;
    }
    if (measureStore.getState().tool?.tool === tool) {
      stopTool();
      return;
    }
    if (tool === 'distance') toggleMeasure(stage);
    else {
      if (stage && stage.tool !== 'select') stage.setTool('select');
      startTool(tool);
    }
  };
  return (
    <>
      {tools.map((tool) => (
        <button
          key={tool}
          type="button"
          className="spk-isl-tool"
          aria-pressed={live === tool}
          onClick={() => {
            start(tool);
          }}
        >
          {entryOf(tool)?.label ?? tool}
        </button>
      ))}
    </>
  );
}

function SpikeIsland({ data }: { data: ProjectData }) {
  useT();
  const open = useSpike((s) => s.islandOpen);
  const mode = useSpike((s) => s.islandMode);
  const stageMode = useShell((s) => s.stageMode);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) spike.getState().setIsland(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') spike.getState().setIsland(false);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const pick = (m: IslandMode) => {
    spike.getState().setIsland(true, m);
    spike.getState().show(MODE_HOME[m]);
  };
  return (
    <div
      ref={root}
      className="spk-island"
      data-open={open ? '' : undefined}
      data-testid="spike-island"
      role="group"
      aria-label={t('layoutSpike.island')}
    >
      <div className="spk-isl-row">
        <div className="seg spk-isl-view" role="group" aria-label={t('layoutSpike.group.view')}>
          {(['3d', 'map', 'split'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={stageMode === m}
              onClick={() => {
                shell.getState().setStageMode(m);
              }}
            >
              {t(`layoutSpike.view.${m}`)}
            </button>
          ))}
        </div>
        {open ? (
          islandModes(data).map((m) => (
            <button
              key={m}
              type="button"
              className="spk-isl-mode"
              aria-pressed={mode === m}
              data-testid={`spike-mode-${m}`}
              onClick={() => {
                pick(m);
              }}
            >
              <Icon name={MODE_ICON[m]} size={14} />
              <span>{t(`layoutSpike.mode.${m}`)}</span>
            </button>
          ))
        ) : (
          <button
            type="button"
            className="spk-isl-mode spk-isl-current"
            aria-expanded={false}
            data-testid="spike-island-open"
            onClick={() => {
              spike.getState().setIsland(true);
            }}
          >
            <Icon name={MODE_ICON[mode]} size={14} />
            <span>{t(`layoutSpike.mode.${mode}`)}</span>
            <Icon name="chev-d" size={12} />
          </button>
        )}
      </div>
      {open && (
        <div
          className="spk-isl-row spk-isl-tools"
          aria-label={t('layoutSpike.islandTools', { mode: t(`layoutSpike.mode.${mode}`) })}
          role="group"
        >
          {mode === 'measure' && <MeasureRow />}
          <button
            type="button"
            className="spk-isl-tool spk-isl-all"
            onClick={() => {
              spike.getState().show(MODE_HOME[mode]);
            }}
          >
            {t('layoutSpike.allIn')}
          </button>
        </div>
      )}
    </div>
  );
}

const SLOTS = [
  { id: 'tc', label: 'layoutSpike.slot.island' },
  { id: 'tr', label: 'layoutSpike.slot.topRight' },
  { id: 'bl', label: 'layoutSpike.slot.bottomLeft' },
  { id: 'br', label: 'layoutSpike.slot.bottomRight' },
  { id: 'fl', label: 'layoutSpike.slot.floating' },
] as const;

export function SpikeStageUi({
  data,
  stageRef,
}: {
  data: ProjectData;
  stageRef: RefObject<HTMLElement | null>;
}) {
  const slots = useSpike((s) => s.slots);
  const video = useSpike((s) => s.video);
  const clip = useTileClip();
  return (
    <div className="spk-stage-ui" data-testid="spike-stage-ui">
      {slots &&
        SLOTS.map((s) => (
          <div key={s.id} className="spk-slot" data-slot={s.id} aria-hidden="true">
            <span>{t(s.label)}</span>
          </div>
        ))}
      <SpikeIsland data={data} />
      {clip && video === 'floating' && <SpikeFloatingVideo clip={clip} stageRef={stageRef} />}
    </div>
  );
}
