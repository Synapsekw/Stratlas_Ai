import { rasterOrder, type PyramidIndex } from '@aio/globe';
import {
  defaultLegend,
  legendGradient,
  legendTicks,
  parseChangeLegend,
  type ChangeLegend,
} from '@aio/maps';
import type { GlobeRaster, GlobeSite } from '@aio/schema';
import { t } from '@aio/ui';
import { useEffect, useId } from 'react';
import { loadPyramid, pyramidKey, shownOf, useSiteOutputs } from './siteOutputsStore';

/** A heat map of height (surface change) rather than of imagery: its legend says so, else its name. */
function isSurfaceChange(raster: GlobeRaster, index: PyramidIndex | null | undefined): boolean {
  const legend = index ? parseChangeLegend(index) : null;
  if (legend) return legend.kind === 'metres';
  return /surface|height/i.test(raster.name);
}

/** The legend a heat map draws with: the one in its index, else the default of its kind. */
function legendOf(raster: GlobeRaster, index: PyramidIndex): ChangeLegend {
  return (
    parseChangeLegend(index) ?? defaultLegend(isSurfaceChange(raster, index) ? 'metres' : 'score')
  );
}

/** The words of a raster's switch. */
function labelOf(
  raster: GlobeRaster,
  dates: ReadonlyMap<string, string>,
  index: PyramidIndex | null | undefined,
): string {
  const date = raster.capture === undefined ? undefined : dates.get(raster.capture);
  if (raster.change)
    return isSurfaceChange(raster, index)
      ? t('globe.outputs.surfaceChange')
      : t('globe.outputs.imageryChange');
  if (raster.role === 'ortho')
    return date === undefined
      ? t('globe.outputs.orthoUndated')
      : t('globe.outputs.ortho', { date });
  if (raster.role === 'dsm') return t('globe.outputs.dsm', { date: date ?? '' }).trim();
  return raster.name;
}

/** A heat map's colour bar with its ends (and its middle), as the map's change legend has it. */
function Legend({ legend, layerId }: { legend: ChangeLegend; layerId: string }) {
  return (
    <div className="globe-legend" data-testid="globe-legend" data-layer={layerId}>
      <span className="globe-legend-title">{legend.label}</span>
      <div className="bar" aria-hidden="true" style={{ background: legendGradient(legend) }} />
      <div className="ticks">
        {legendTicks(legend).map((tick) => (
          <span key={tick.value}>{tick.text}</span>
        ))}
      </div>
    </div>
  );
}

function OutputRow({
  site,
  raster,
  label,
  index,
  on,
}: {
  site: GlobeSite;
  raster: GlobeRaster;
  label: string;
  index: PyramidIndex | null | undefined;
  on: boolean;
}) {
  const id = useId();
  const unreadable = index === null;
  const checked = on && !unreadable;
  return (
    <li
      className="globe-output"
      data-layer={raster.layerId}
      data-disabled={unreadable || undefined}
    >
      <div className="globe-output-row">
        <label id={`${id}-label`} htmlFor={`${id}-switch`}>
          {label}
        </label>
        <button
          id={`${id}-switch`}
          type="button"
          className="switch"
          role="switch"
          aria-checked={checked}
          aria-labelledby={`${id}-label`}
          aria-describedby={unreadable ? `${id}-note` : undefined}
          disabled={unreadable}
          onClick={() => {
            useSiteOutputs.getState().toggle(site, raster.layerId);
          }}
        />
      </div>
      {unreadable && (
        <p id={`${id}-note`} className="globe-output-note">
          {t('globe.outputs.unreadable')}
        </p>
      )}
      {checked && raster.change && index && (
        <Legend legend={legendOf(raster, index)} layerId={raster.layerId} />
      )}
    </li>
  );
}

/**
 * "On the Globe", a section of a site card: a switch per processed raster of the site (orthos
 * by survey date, then shaded surfaces, then plans, then change heat maps), and the legend of
 * each heat map that is on. Not there for a site that cannot be placed or has no rasters.
 */
export function SiteOutputs({ site }: { site: GlobeSite }) {
  const headingId = useId();
  const shown = useSiteOutputs((s) => s.shown);
  const indexes = useSiteOutputs((s) => s.indexes);
  const rasters = site.frame ? (site.rasters ?? []) : [];
  const srcKey = rasters.map((r) => r.src).join('\n');
  useEffect(() => {
    for (const src of srcKey ? srcKey.split('\n') : []) void loadPyramid(site.projectId, src);
  }, [site.projectId, srcKey]);
  if (rasters.length === 0) return null;
  const on = new Set(shownOf(shown, site));
  const dates = new Map(site.captures.map((c) => [c.id, c.date]));
  const rows = rasterOrder(rasters, site.captures).map((raster) => {
    const index = indexes[pyramidKey(site.projectId, raster.src)];
    return { raster, index, label: labelOf(raster, dates, index) };
  });
  // a label that repeats (two orthos of one date) is told apart by the layer's own name
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  return (
    <section className="globe-outputs" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('globe.outputs.title')}</h3>
      <ul>
        {rows.map(({ raster, label, index }) => (
          <OutputRow
            key={raster.layerId}
            site={site}
            raster={raster}
            label={
              (counts.get(label) ?? 0) > 1
                ? t('globe.outputs.withName', { label, name: raster.name })
                : label
            }
            index={index}
            on={on.has(raster.layerId)}
          />
        ))}
      </ul>
    </section>
  );
}
