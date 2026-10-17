/** What the Display workbench and the L key share: the callout label modes and layers by kind. */
import type { LabelMode } from '@aio/engine';
import type { Layer } from '@aio/schema';
import type { IconName } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';

export const LABEL_MODES: { mode: LabelMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'Selection and hover only' },
  { mode: 'key', label: 'Key', hint: 'One per component group' },
  { mode: 'all', label: 'All', hint: 'Every tagged component' },
];

export function nextLabelMode(m: LabelMode): LabelMode {
  const i = LABEL_MODES.findIndex((x) => x.mode === m);
  return LABEL_MODES[(i + 1) % LABEL_MODES.length]?.mode ?? 'key';
}

export const KINDS: { kinds: Layer['kind'][]; label: string; icon: IconName }[] = [
  { kinds: ['mesh'], label: 'Models', icon: 'scene' },
  { kinds: ['pointcloud'], label: 'Point clouds', icon: 'cloud' },
  { kinds: ['photos'], label: 'Photo cameras', icon: 'photo' },
  { kinds: ['raster', 'basemap'], label: 'Maps and rasters', icon: 'raster' },
  { kinds: ['video'], label: 'Video clips', icon: 'video' },
];

/** The project's layers of these kinds, and one switch for all of them (the Layers eyes). */
export function useKindLayers(kinds: readonly Layer['kind'][]) {
  const joined = useWorkspace((s) =>
    (s.project?.manifest.layers ?? [])
      .filter((l) => kinds.includes(l.kind))
      .map((l) => l.id)
      .join('|'),
  );
  const ids = joined ? joined.split('|') : [];
  const visible = useWorkspace((s) => ids.some((id) => !s.hidden[id]));
  return {
    ids,
    visible,
    toggle: () => {
      for (const id of ids) workspace.getState().setLayerVisible(id, !visible);
    },
  };
}
