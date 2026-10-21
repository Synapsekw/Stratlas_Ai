/**
 * Heat map colours (M11 G4): the site's difference stops (default -1, -0.1, 0.1, 1 in site units),
 * smooth or stepped, inverted, and the deadband the stops imply. Stored in `survey/settings.json`
 * (`heatmap`), so every comparison and the whole-site job colour the same way. The deadband shapes
 * the heat map always; it changes volumes only where an item ticks Use deadband in calculations.
 */
import { formatQuantity, fromSI, toSI, unitLabel } from '@aio/geo';
import type { HeatmapStop, HeatmapStyle } from '@aio/schema';
import { DEFAULT_STOPS, deadbandFromStops, heatRamp, sortStops, stopsProblem } from '@aio/survey';
import { Icon, useT } from '@aio/ui';
import { useState } from 'react';
import { useCompare } from './compareStore';
import type { HeatGrid } from './engineProtocol';
import { activeHeat, heatHistogram } from './heatScene';
import { saveSiteSettings, useMeasure } from './measureStore';

/**
 * The heat map legend: a colour bar with the cut and fill ends in the display unit, and (when a
 * grid is shown) a small histogram of how much of the area changed by each amount.
 */
export function HeatLegend({
  style,
  grid,
}: {
  style: Pick<HeatmapStyle, 'stops' | 'stepped' | 'inverted'>;
  grid?: HeatGrid | null;
}) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const ramp = heatRamp(style);
  const s = ramp.legend;
  const lo = s[0]?.value ?? -1;
  const hi = s.at(-1)?.value ?? 1;
  const pos = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  const parts = s.map((x) => `${x.color} ${pos(x.value).toFixed(1)}%`);
  const bg = style.stepped
    ? `linear-gradient(to right, ${s
        .map((x, k) => {
          const next = s[k + 1];
          return `${x.color} ${pos(x.value).toFixed(1)}% ${next ? pos(next.value).toFixed(1) : '100'}%`;
        })
        .join(', ')})`
    : `linear-gradient(to right, ${parts.join(', ')})`;
  const d = (v: number) => formatQuantity(v, 'distance', settings.units, settings.precision);
  const bins = grid ? heatHistogram(grid, style.stops) : null;
  const peak = bins ? Math.max(1, ...bins) : 1;
  return (
    <div
      className="sv-legend"
      // one image: its parts are presentational, so the histogram is named here
      aria-label={bins ? `${t('heat.legend')}. ${t('heat.histogram')}` : t('heat.legend')}
      role="img"
      data-testid="survey-heat-legend"
    >
      {bins && (
        <div data-testid="survey-heat-histogram" className="sv-legend-hist">
          {bins.map((n, k) => (
            <span
              key={k}
              style={{ height: `${String(Math.max(n > 0 ? 6 : 0, (n / peak) * 100))}%` }}
            />
          ))}
        </div>
      )}
      <div className="sv-legend-bar" style={{ background: bg }} />
      <div className="sv-row small faint mono">
        <span>
          {d(lo)} {t('heat.cut')}
        </span>
        <span className="sv-grow" />
        <span>
          {d(hi)} {t('heat.fill')}
        </span>
      </div>
    </div>
  );
}

/** The legend with its Edit colours action; the stops editor opens from that action. */
export function HeatmapStopsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const readOnly = useMeasure((s) => s.readOnly);
  const settings = useMeasure((s) => s.settings);
  const computed = useCompare((c) => c.computed);
  const heat = useCompare((c) => c.heat);
  const grid = useMeasure((m) => activeHeat({ computed, heat }, m));
  if (!open)
    return (
      <div className="sv-row sv-wrap">
        <HeatLegend style={settings.heatmap} grid={grid} />
        <button
          type="button"
          className="btn sm"
          data-testid="survey-heat-colours"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('heat.editColours')}
        </button>
      </div>
    );
  return (
    <HeatmapStops
      readOnly={readOnly}
      onClose={() => {
        setOpen(false);
      }}
    />
  );
}

export function HeatmapStops({ readOnly, onClose }: { readOnly: boolean; onClose: () => void }) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const unit = settings.units.distance;
  const [draft, setDraft] = useState<HeatmapStyle>(() => ({
    ...settings.heatmap,
    stops: sortStops(settings.heatmap.stops),
  }));
  const [texts, setTexts] = useState<string[]>(() =>
    sortStops(settings.heatmap.stops).map((s) => String(round(fromSI(s.value, 'distance', unit)))),
  );
  const [error, setError] = useState<string | null>(null);
  const problem = stopsProblem(draft.stops);
  const setStops = (stops: HeatmapStop[], nextTexts: string[]) => {
    setDraft({ ...draft, stops });
    setTexts(nextTexts);
  };
  const db = deadbandFromStops(draft.stops);
  return (
    <fieldset className="sv-sub" data-testid="survey-heat-stops" disabled={readOnly}>
      <legend>{t('heat.colours')}</legend>
      <HeatLegend style={draft} />
      <table className="sv-verts">
        <caption className="sr-only">Stops</caption>
        <thead>
          <tr>
            <th scope="col">Change ({unitLabel(unit)})</th>
            <th scope="col">Colour</th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.stops.map((s, k) => (
            <tr key={k}>
              <td>
                <input
                  className="sv-input mono"
                  type="number"
                  step="0.01"
                  aria-label={`Stop ${String(k + 1)} value`}
                  data-testid="survey-stop-value"
                  value={texts[k] ?? ''}
                  onChange={(e) => {
                    const nextTexts = [...texts];
                    nextTexts[k] = e.target.value;
                    const v = Number(e.target.value);
                    const stops = draft.stops.map((x, i) =>
                      i === k && e.target.value !== '' && Number.isFinite(v)
                        ? { ...x, value: toSI(v, 'distance', unit) }
                        : x,
                    );
                    setStops(stops, nextTexts);
                  }}
                />
              </td>
              <td>
                <input
                  type="color"
                  aria-label={`Stop ${String(k + 1)} colour`}
                  value={s.color}
                  onChange={(e) => {
                    setDraft({
                      ...draft,
                      stops: draft.stops.map((x, i) =>
                        i === k ? { ...x, color: e.target.value } : x,
                      ),
                    });
                  }}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-label={`Remove stop ${String(k + 1)}`}
                  disabled={draft.stops.length <= 2}
                  onClick={() => {
                    setStops(
                      draft.stops.filter((_, i) => i !== k),
                      texts.filter((_, i) => i !== k),
                    );
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sv-row sv-wrap">
        <button
          type="button"
          className="btn sm"
          disabled={draft.stops.length >= 16}
          onClick={() => {
            const last = draft.stops.at(-1);
            const v = (last?.value ?? 0) + 1;
            setStops(
              [...draft.stops, { value: v, color: last?.color ?? '#2166ac' }],
              [...texts, String(round(fromSI(v, 'distance', unit)))],
            );
          }}
        >
          <Icon name="plus" size={12} /> Add a stop
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            const stops = DEFAULT_STOPS.map((x) => ({ ...x }));
            setStops(
              stops,
              stops.map((x) => String(round(fromSI(x.value, 'distance', unit)))),
            );
          }}
        >
          Default stops
        </button>
      </div>
      <div className="sv-row sv-wrap">
        <label className="sv-check">
          <input
            type="checkbox"
            checked={draft.stepped}
            data-testid="survey-heat-stepped"
            onChange={(e) => {
              setDraft({ ...draft, stepped: e.target.checked });
            }}
          />
          Stepped colours
        </label>
        <label className="sv-check">
          <input
            type="checkbox"
            checked={draft.inverted === true}
            data-testid="survey-heat-inverted"
            onChange={(e) => {
              setDraft({ ...draft, inverted: e.target.checked });
            }}
          />
          Invert colours
        </label>
      </div>
      <p className="small faint" data-testid="survey-heat-deadband">
        {db > 0
          ? `Deadband from the stops: ${formatQuantity(db, 'distance', settings.units, settings.precision)}. Changes inside it are left clear; they count in the volumes unless a comparison ticks Use deadband in calculations.`
          : 'The stops do not straddle zero: no deadband.'}
      </p>
      {(problem ?? error) && (
        <p className="notice danger small" role="alert">
          {problem ?? error}
        </p>
      )}
      <div className="sv-row">
        <span className="sv-grow" />
        <button type="button" className="btn sm ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={problem !== null}
          data-testid="survey-heat-save"
          onClick={() => {
            void saveSiteSettings({
              ...settings,
              heatmap: { ...draft, stops: sortStops(draft.stops) },
            }).then((err) => {
              if (err) setError(`The colours were not saved: ${err}`);
              else onClose();
            });
          }}
        >
          Save colours
        </button>
      </div>
    </fieldset>
  );
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
