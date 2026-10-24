/**
 * The stage hint (volumetrics redesign, spec sections 3 and 4): one short line at the foot of the
 * stage saying what the pointer and Esc do now. One message at a time, the first that holds:
 *
 * 1. a point pinned on a linked line: "Esc clears the pin · double-click to fly there";
 * 2. the chart hovered: "Following the chart" with its legend;
 * 3. the pointer on a linked line in 3D or on the map: "Pointer on the line · snapped to 64.0 m";
 * 4. a pile open in the Volumes tab: its profile line's handles (on the Profile) and Esc;
 * 5. else nothing.
 *
 * It only reads: a click on it reaches the view under it.
 */
import { useT } from '@aio/ui';
import type { ReactElement } from 'react';
import { tagFormat } from '../survey/hoverScene';
import { useLinkedHover, type HoverLine, type HoverPoint } from '../survey/linkedHover';
import { useMeasure } from '../survey/measureStore';
import { stagePile } from '../survey/pile/pileAxisScene';
import { usePileView } from '../survey/pile/pileView';
import { useWorkbench } from './workbench/workbenchStore';

export interface StageHintText {
  kind: 'pinned' | 'following' | 'snapped' | 'pile';
  title: string;
  sub?: string;
}

type T = ReturnType<typeof useT>;

/** A line's survey labels, newest first. */
const newestFirst = (line: HoverLine): string[] => line.series.map((s) => s.label).reverse();

/** The message for the state, in the order above; null when none holds. */
export function stageHintOf(
  t: T,
  s: {
    pin: HoverPoint | null;
    hover: HoverPoint | null;
    lines: ReadonlyMap<string, HoverLine>;
    pile: { profile: boolean } | null;
  },
): StageHintText | null {
  if (s.pin && s.lines.has(s.pin.key)) return { kind: 'pinned', title: t('hover.pinnedHint') };
  const line = s.hover ? s.lines.get(s.hover.key) : undefined;
  if (s.hover && line) {
    const labels = newestFirst(line);
    if (s.hover.source === 'chart') {
      const [date, earlier] = labels;
      return {
        kind: 'following',
        title: t('hover.following'),
        ...(date !== undefined && earlier !== undefined
          ? { sub: t('hover.legend', { date, earlier }) }
          : {}),
      };
    }
    return {
      kind: 'snapped',
      title: t('hover.snapped', { chainage: tagFormat().chainage(s.hover.chainageM) }),
      ...(labels.length > 0 ? { sub: t('hover.follows', { dates: labels.join(' · ') }) } : {}),
    };
  }
  if (s.pile)
    return s.pile.profile
      ? { kind: 'pile', title: t('pile.lineHint'), sub: t('pile.escHint') }
      : { kind: 'pile', title: t('pile.escHint') };
  return null;
}

/** The stage hint for the state now, or null. */
export function useStageHint(): StageHintText | null {
  const t = useT();
  const pin = useLinkedHover((s) => s.pin);
  const hover = useLinkedHover((s) => s.hover);
  const lines = useLinkedHover((s) => s.lines);
  // what the open pile depends on: read again when any of it changes
  useMeasure((s) => s.focus);
  useMeasure((s) => s.file);
  useWorkbench((s) => s.front);
  usePileView((s) => s.tab);
  const open = stagePile();
  return stageHintOf(t, { pin, hover, lines, pile: open ? { profile: open.profile } : null });
}

/** The hint as a bottom-corner float (the stage places it in its corner slot). */
export function StageHint(): ReactElement | null {
  const hint = useStageHint();
  if (!hint) return null;
  return (
    <div
      className="vol-legend overlay-box stage-hint"
      role="status"
      data-testid="stage-hint"
      data-kind={hint.kind}
      style={{ pointerEvents: 'none' }}
    >
      <span>{hint.title}</span>
      {hint.sub && <span className="faint">{hint.sub}</span>}
    </div>
  );
}
