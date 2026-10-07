import { useMemo } from 'react';
import type { Layer } from '@aio/schema';
import { useT } from '@aio/ui';
import { dateTags, useWorkspace, type CaptureIndex } from '@aio/workspace';
import { useTimeline } from './timeline';

type Hidden = Readonly<Record<string, true>>;
type PhotoLayer = Extract<Layer, { kind: 'photos' }>;

/** The survey dates with at least one visible layer of `kinds`, oldest first. */
export function datesOnScreen(
  index: CaptureIndex,
  hidden: Hidden,
  layers: readonly Pick<Layer, 'id' | 'name' | 'kind'>[],
  kinds: readonly Layer['kind'][],
): { capture: string; layers: string[] }[] {
  const out: { capture: string; layers: string[] }[] = [];
  for (const c of index.captures) {
    const ids = (index.layers[c.id] ?? []).filter((id) => {
      const kind = layers.find((l) => l.id === id)?.kind;
      return !hidden[id] && kind !== undefined && kinds.includes(kind);
    });
    if (ids.length > 0) out.push({ capture: c.id, layers: ids });
  }
  return out;
}

/** The photo set the photo pane shows: the focused date's, else any visible set, else any. */
export function pickPhotoSet(
  sets: readonly PhotoLayer[],
  hidden: Hidden,
  index: CaptureIndex | null,
  focus: string | null,
): PhotoLayer | undefined {
  const usable = sets.filter((s) => s.items.length > 0);
  return (
    usable.find((s) => !hidden[s.id] && index?.of[s.id] === focus) ??
    usable.find((s) => !hidden[s.id]) ??
    usable[0]
  );
}

/** Corner chip listing the survey dates currently on screen in a 3D view or map. */
export function DatesOnScreen(props: { kinds: readonly Layer['kind'][] }) {
  const t = useT();
  const index = useTimeline((s) => s.index);
  const hidden = useWorkspace((s) => s.hidden);
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  if (!index || !layers) return null;
  const on = datesOnScreen(index, hidden, layers, props.kinds);
  if (on.length < 2) return null;
  return (
    <div className="dates-on" data-testid="dates-on-screen" aria-label={t('stage.datesOn')}>
      {on.map((d) => (
        <span
          key={d.capture}
          className="dates-on-item"
          title={d.layers.map((id) => layers.find((l) => l.id === id)?.name ?? id).join(', ')}
        >
          <span
            className="dtag"
            style={{ background: tags[d.capture]?.colour }}
            aria-hidden="true"
          />
          {tags[d.capture]?.short}
        </span>
      ))}
    </div>
  );
}

/** Date tag for one layer (pane headers); nothing for Every date layers. */
export function DateBadge(props: { layerId: string }) {
  const index = useTimeline((s) => s.index);
  const tags = useMemo(() => (index ? dateTags(index.captures) : {}), [index]);
  const capture = index?.of[props.layerId];
  const tag = capture ? tags[capture] : undefined;
  if (!tag) return null;
  return (
    <span className="date-badge" data-testid="date-badge" title={tag.long}>
      <span className="dtag" style={{ background: tag.colour }} aria-hidden="true" />
      {tag.short}
    </span>
  );
}
