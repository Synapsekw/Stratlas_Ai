import { matchShortcut, t, useT } from '@aio/ui';
import type { DateTag } from '@aio/workspace';
import type { KeyboardEvent, ReactNode } from 'react';
import { slotRadiusM } from './spotRules';
import type { Spot, SpotHistory, SpotItem, SpotMatch } from './spotTypes';
import { cycleMatch, stepDate, type SpotAt } from './spotViewerStore';
import './spot.css';

/** The arrow keys of the strip (and of the viewer): a new place, or null for other keys. */
export function stripKey(
  e: Parameters<typeof matchShortcut>[1],
  h: SpotHistory,
  at: SpotAt | null,
): SpotAt | null {
  switch (matchShortcut('spot', e)) {
    case 'spot.prevDate':
      return stepDate(h, at, -1);
    case 'spot.nextDate':
      return stepDate(h, at, 1);
    case 'spot.prevMatch':
      return cycleMatch(h, at, -1);
    case 'spot.nextMatch':
      return cycleMatch(h, at, 1);
    default:
      return null;
  }
}

export function emptyText(spot: Spot, origin: SpotItem['kind']): string {
  return spot.aerial ? t('spot.slot.notSeen') : t('spot.slot.none', { m: slotRadiusM(origin) });
}

/**
 * One slot per survey date, oldest on the left: its colour, the best match's thumbnail and kind,
 * "+n" for more; an empty date is a hatched slot that says why. A listbox: arrows step dates
 * (skipping gaps) and images of a date; a click jumps. It shows; the caller decides what a pick does.
 */
export function SpotStrip(p: {
  history: SpotHistory;
  at: SpotAt | null;
  tags: Readonly<Record<string, DateTag>>;
  origin: SpotItem['kind'];
  thumb: (m: SpotMatch) => ReactNode;
  onPick: (at: SpotAt) => void;
  compact?: boolean;
}) {
  const tr = useT();
  const empty = emptyText(p.history.spot, p.origin);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const next = stripKey(e, p.history, p.at);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    p.onPick(next);
  };
  return (
    <div
      className={`spot-strip${p.compact ? ' compact' : ''}`}
      role="listbox"
      aria-orientation="horizontal"
      aria-label={tr('spot.strip')}
      tabIndex={0}
      data-testid="spot-strip"
      onKeyDown={onKey}
    >
      {p.history.dates.map((d) => {
        const tag = p.tags[d.capture];
        const best = d.matches[0];
        const on = p.at?.capture === d.capture;
        const shown = on && p.at ? (d.matches[p.at.i] ?? best) : best;
        const skipped = d.skipped > 0 ? tr('spot.slot.skipped', { count: d.skipped }) : '';
        const date = tag?.long ?? d.capture;
        return (
          <div
            key={d.capture}
            role="option"
            aria-selected={on}
            aria-disabled={!best}
            aria-label={
              shown
                ? tr('spot.slot.label', { date, kind: tr(`spot.kind.${shown.kind}`) })
                : tr('spot.slot.emptyLabel', { date, reason: empty })
            }
            title={[date, skipped].filter(Boolean).join('\n')}
            className={`spot-slot${on ? ' on' : ''}${best ? '' : ' empty'}`}
            style={{ ['--date' as string]: tag?.colour }}
            data-testid={`spot-slot-${d.capture}`}
            data-capture={d.capture}
            data-empty={best ? 'false' : 'true'}
            data-count={d.matches.length}
            onClick={() => {
              if (best) p.onPick({ capture: d.capture, i: on && p.at ? p.at.i : 0 });
            }}
          >
            <span className="spot-slot-date">{tag?.short ?? d.capture}</span>
            {shown ? (
              <>
                <span className="spot-slot-thumb">{p.thumb(shown)}</span>
                <span className="spot-slot-kind">{tr(`spot.kind.${shown.kind}`)}</span>
                {d.matches.length > 1 && (
                  <span className="spot-slot-more">
                    {tr('spot.slot.more', { count: d.matches.length - 1 })}
                  </span>
                )}
              </>
            ) : (
              <span className="spot-slot-none">{empty}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
