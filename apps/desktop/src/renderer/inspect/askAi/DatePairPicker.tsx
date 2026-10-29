/**
 * The other survey date a Compare dates request looks at, from spot history: every other date
 * whose best match of this photo's spot is a photo, with its date and how far away it was taken.
 * Image 1 is the older date, Image 2 the newer; the drafts land on Image 2's photo. When there is
 * nothing to pick, it says why (no position, no survey date, no other date).
 */
import { useT, type MessageKey } from '@aio/ui';
import type { ReactElement } from 'react';
import type { DetectItem } from '../../detections/convert';
import type { SpotOpen } from '../../workspace/spot/spotTypes';
import { useSpotHistory } from '../../workspace/spot/useSpotHistory';

type PhotoItem = DetectItem & { kind: 'photo' };

export interface DatePair {
  before: PhotoItem;
  after: PhotoItem;
  labels: [string, string];
}

/** One date on offer: its capture, label, distance and photo. */
export interface DateOption {
  capture: string;
  label: string;
  distanceM: number;
  item: PhotoItem;
}

export function DatePairPicker({
  open,
  onPick,
  picked = null,
}: {
  open: SpotOpen | null;
  onPick: (pair: DatePair, capture: string) => void;
  /** The capture picked now, highlighted. */
  picked?: string | null;
}): ReactElement {
  const t = useT();
  const { index, tags, result, origin } = useSpotHistory(open, open !== null);
  const label = (capture: string) => tags[capture]?.long ?? capture;

  const say = (key: MessageKey, id: string) => (
    <p className="askp-note faint" data-testid={`ask-dates-${id}`}>
      {t(key)}
    </p>
  );
  if (open?.item.kind !== 'photo') return say('askPanel.dates.noPhoto', 'nophoto');
  const self: PhotoItem = { kind: 'photo', layer: open.item.layer, photo: open.item.photo };
  if (index && index.captures.length < 2) return say('askPanel.dates.noOther', 'none');
  if (!index || !result) return say('askPanel.dates.reading', 'reading');
  if ('error' in result) return say('askPanel.dates.noPosition', 'noposition');
  if (origin === undefined) return say('askPanel.dates.noDate', 'nodate');

  const order = index.captures.map((c) => c.id);
  const options: DateOption[] = result.history.dates.flatMap((d): DateOption[] => {
    const best = d.matches[0];
    if (d.capture === origin || best?.item.kind !== 'photo') return [];
    return [
      {
        capture: d.capture,
        label: label(d.capture),
        distanceM: best.distanceM,
        item: { kind: 'photo', layer: best.item.layer, photo: best.item.photo },
      },
    ];
  });
  if (options.length === 0) return say('askPanel.dates.noOther', 'none');

  const pick = (o: DateOption) => {
    const older = order.indexOf(o.capture) < order.indexOf(origin);
    const pair: DatePair = older
      ? { before: o.item, after: self, labels: [o.label, label(origin)] }
      : { before: self, after: o.item, labels: [label(origin), o.label] };
    onPick(pair, o.capture);
  };
  return (
    <div className="askp-dates" role="radiogroup" aria-label={t('askPanel.dates')}>
      {picked === null && (
        <p className="askp-note faint" data-testid="ask-dates-pick">
          {t('askPanel.dates.pick')}
        </p>
      )}
      {options.map((o) => (
        <button
          key={o.capture}
          type="button"
          role="radio"
          aria-checked={picked === o.capture}
          className="askp-date"
          data-testid={`ask-date-${o.capture}`}
          onClick={() => {
            pick(o);
          }}
        >
          <span className="askp-date-label">{o.label}</span>
          <span className="mono faint">
            {t('askPanel.dates.distance', { m: Math.round(o.distanceM) })}
          </span>
        </button>
      ))}
    </div>
  );
}
