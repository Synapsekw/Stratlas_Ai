/**
 * The stage's single-key shortcuts. Each tool's action lives with its group (`tools/*.tsx`), so a
 * tool can change without editing this handler. T (the island's tools) is the island's own key.
 */
import { annotateUi, pinDisplay } from '@aio/annotate';
import type { EngineStage } from '@aio/engine';
import { matchShortcut } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useEffect } from 'react';
import { isTyping } from '../keys';
import { shell } from '../shell';
import { togglePaths } from './flightPaths';
import { flightPathModel, updateFlightPaths } from './pathModel';
import { toggleTelemetry } from './telemetryPref';
import { nextLabelMode } from './tools/display';
import { toggleMeasure, toggleSection } from './tools/measure';
import { insideView } from './useCutaway';

/** Answer the stage keys while mounted (the video annotator's own keys win inside its window). */
export function useStageKeys(engine: EngineStage | null): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target) || annotateUi.getState().pending) return;
      if (e.target instanceof HTMLElement && e.target.closest('.vwin')) return;
      const sh = shell.getState();
      const ws = workspace.getState();
      const k = matchShortcut('scene', e);
      const three = sh.stageMode !== 'map' ? engine : null;
      if (k === 'scene.mode3d') sh.setStageMode('3d');
      else if (k === 'scene.modeMap') sh.setStageMode('map');
      else if (k === 'scene.modeSplit') sh.setStageMode('split');
      else if (k === 'scene.home') ws.flyTo({ kind: 'home' });
      else if (k === 'scene.site') ws.flyTo({ kind: 'site' });
      else if (k === 'scene.flySelection' && ws.selection)
        ws.flyTo({ kind: 'selection', selection: ws.selection });
      else if (k === 'scene.measure' && three) toggleMeasure(three);
      else if (k === 'scene.section' && three) toggleSection(three);
      else if (k === 'scene.labels' && three) sh.setLabelMode(nextLabelMode(sh.labelMode));
      else if (k === 'scene.annotate') sh.setAnnotating(!sh.annotating);
      else if (k === 'scene.video' && ws.activeClip) sh.setVideoHidden(!sh.videoHidden);
      else if (k === 'scene.flightPaths' && three && flightPathModel())
        updateFlightPaths(togglePaths);
      else if (k === 'scene.telemetry' && three && flightPathModel()) toggleTelemetry();
      else if (k === 'scene.pins') pinDisplay.getState().togglePins();
      else if (k === 'scene.inside' && three && ws.activeClip) insideView(three);
      else if (k === 'scene.escape' && three && three.tool !== 'select') three.setTool('select');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [engine]);
}
