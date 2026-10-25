/**
 * The Volumes tab's Inventory pane (volumetrics redesign, spec section 6, board 1): the piles on
 * the date in focus in one dense table grouped by material. A group's row carries its colour, its
 * name, its density on that date and its subtotals; its piles follow, largest first, four shown
 * then "+ 2 more", which opens the rest. The piles the inventory leaves out (stale, no survey data,
 * not computed yet, could not compute) are named under "Not counted" with why, never added as
 * zero; "Site total" closes it. A row opens the pile in the pile panel.
 *
 * Also what the whole tab needs before any pane: the piles' figures per survey date, worked out
 * when shown (`useSeriesRun`), the figures on the date in focus (`useInventoryModel`) and the
 * state with no pile yet (`VolumesEmpty`).
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { formatNumber, localeOf } from '@aio/geo';
import type { SurveyMeasurement } from '@aio/schema';
import { effectiveUnits, KIT_MATERIAL_NAME, surfacesStamp, type NotCounted } from '@aio/survey';
import { Button, EmptyState, formatDate, useT, type MessageKey } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { processing } from '../../processing/store';
import { useShell } from '../../shell';
import { useTimelapsePlaying } from '../../workspace/dates/timelapse';
import { useTimeline } from '../../workspace/timeline';
import { notCountedReason } from '../BulkTotals';
import { BASES, baseIdOf } from '../card/baseNames';
import { computeSeries, useCompare } from '../compareStore';
import { captureInFocus } from '../measureRows';
import { startTool, useMeasure } from '../measureStore';
import { massParts, volumeParts } from '../pile/PileHeader';
import { minusSigned } from '../pile/pileView';
import { setSeriesFailed, useInventory } from '../useInventory';
import { GROUP_SHOWN, inventoryModel, type InventoryGroup, type InventoryModel } from './inventory';
import { captureDateOf } from './materialsDraft';
import './volumes.css';

/** The stockpile job file the pile detection runs from (written by the new project wizard). */
export const PILE_JOB = 'volumetric/job.json';

/** What a pile's dates were last worked out for: its edits and its comparisons. */
const stampOf = (m: SurveyMeasurement) =>
  `${m.updatedAt ?? m.createdAt}|${JSON.stringify(m.items)}|${String(m.points.length)}`;

/**
 * Each pile's volume per survey date, worked out while the Volumes tab shows (carried piles keep
 * the kit's): only the piles changed since their last run are run again, every pile once the
 * dates or the prepared surfaces change (a run made before Prepare surfaces is redone). A
 * read-only project works its dates out too, held in memory and never written.
 */
export function useSeriesRun(piles: readonly SurveyMeasurement[]): void {
  const lookOnly = useAnnotateReadOnly();
  const status = useCompare((s) => s.status);
  const captures = useCompare((s) => s.captures);
  const surfaces = useCompare((s) => s.surfaces);
  const ran = useRef(new Map<string, string>());
  const ranFor = useRef('');
  const runFor = `${status}|${String(lookOnly)}|${captures.map((c) => c.id).join(',')}|${surfacesStamp(surfaces)}`;
  useEffect(() => {
    if (ranFor.current !== runFor) {
      ran.current.clear();
      ranFor.current = runFor;
    }
    if (status !== 'ready' || lookOnly || captures.length === 0) return;
    const todo = piles.filter((m) => m.items.length > 0 && ran.current.get(m.id) !== stampOf(m));
    if (todo.length === 0) return;
    const run = { gone: false };
    void (async () => {
      for (const m of todo) {
        if (run.gone) return;
        const stamp = stampOf(m);
        try {
          await computeSeries(m.id);
          setSeriesFailed(m.id, null);
        } catch (e) {
          // the totals name the pile as not counted, with why
          console.warn(`The volume over time of ${m.id} could not be worked out`, e);
          setSeriesFailed(m.id, e instanceof Error ? e.message : String(e));
        }
        ran.current.set(m.id, stamp);
      }
    })();
    return () => {
      run.gone = true;
    };
  }, [status, lookOnly, captures.length, piles, runFor]);
}

/** The figures on the date in focus (the notch's, else the latest survey date). */
export function useInventoryModel(piles: readonly SurveyMeasurement[]): InventoryModel | null {
  const rows = useInventory(piles);
  const materials = useMeasure((s) => s.settings.materials);
  // a converted kit pile with no site material weighs by the kit's site-wide density
  const kit = useMeasure((s) => s.kitDensity);
  const captures = useCompare((s) => s.captures);
  const focus = useTimeline((s) => s.focus);
  const inFocus = captureInFocus(focus, { captures });
  return useMemo(
    () => inventoryModel(piles, rows, inFocus, materials, captureDateOf(captures), kit),
    [piles, rows, inFocus, materials, captures, kit],
  );
}

/**
 * The piles in the table's order (the pile panel steps through them): the groups' piles, then
 * the ones not counted.
 */
export function inventoryOrder(
  model: InventoryModel | null,
  piles: readonly SurveyMeasurement[],
): string[] {
  const shown = model ? model.groups.flatMap((g) => g.piles.map((p) => p.id)) : [];
  const seen = new Set(shown);
  return [...shown, ...piles.filter((m) => !seen.has(m.id)).map((m) => m.id)];
}

/** No pile yet: say so, and offer Draw volume and Detect piles. */
export function VolumesEmpty(): ReactElement {
  const t = useT();
  const fileReadOnly = useMeasure((s) => s.readOnly);
  const read = useMeasure((s) => s.status === 'ready');
  const lookOnly = useAnnotateReadOnly();
  const readOnly = lookOnly || fileReadOnly;
  const root = useWorkspace((s) => s.project?.root ?? null);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const pkg = useShell((s) => s.pkg !== null);
  // Detect piles runs from the stockpile job file: offered only when the project has one, looked
  // for once the measurements are read
  const [hasJob, setHasJob] = useState<boolean | null>(null);
  useEffect(() => {
    if (projectId === null || !read) return;
    let gone = false;
    void fetch(assetUrl(projectId, { path: PILE_JOB }))
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        if (!gone) setHasJob(ok);
      });
    return () => {
      gone = true;
    };
  }, [projectId, read]);
  const detectWhy = readOnly
    ? t('actions.reason.readOnly')
    : pkg
      ? t('actions.reason.package')
      : root === null || hasJob === false
        ? t('vol.view.noJob')
        : undefined;
  return (
    <EmptyState
      icon="pile"
      title={t('empty.volumes.title')}
      body={t('vol.view.emptyHint')}
      action={
        <>
          <Button
            variant="primary"
            icon="polygon"
            disabledReason={readOnly ? t('actions.reason.readOnly') : undefined}
            data-testid="volumes-draw"
            onClick={() => {
              startTool('volume');
            }}
          >
            {t('mcard.drawVolume')}
          </Button>
          <Button
            icon="pile"
            disabled={hasJob === null}
            disabledReason={detectWhy}
            data-testid="volumes-detect"
            onClick={() => {
              if (root !== null)
                processing.getState().openDialog({
                  pipeline: 'volumetric.build',
                  project: root,
                  values: { job: PILE_JOB },
                });
            }}
          >
            {t('mcard.detectPiles')}
          </Button>
        </>
      }
    />
  );
}

/** Density decimals as the boards write it ("1.60"). */
const DENSITY_DECIMALS = 2;

/** A group's key: its material, or "No material". */
const keyOf = (g: InventoryGroup) => g.material?.id ?? '';

/**
 * The base the counted piles are measured on, as the caption names it: one name when they share
 * it, else each name once ("Triangulated toe, Lowest point").
 */
function baseCaption(
  piles: readonly SurveyMeasurement[],
  counted: ReadonlySet<string>,
  t: (k: MessageKey) => string,
): string {
  const names = new Set<string>();
  for (const m of piles) {
    const from = m.items[0]?.from;
    if (!counted.has(m.id) || !from) continue;
    const id = baseIdOf(from);
    const base = BASES.find((b) => b.id === id);
    if (base) names.add(t(base.name));
  }
  return names.size > 0 ? [...names].join(', ') : t('base.smart');
}

export interface InventoryPaneProps {
  /** The figures on the date in focus; null without a survey date. */
  model: InventoryModel | null;
  /** Every pile (the ones the figures leave out are named under "Not counted"). */
  piles: readonly SurveyMeasurement[];
  /** Open a pile in the pile panel. */
  onPile: (id: string) => void;
}

export function InventoryPane({ model, piles, onPile }: InventoryPaneProps): ReactElement {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const units = effectiveUnits(settings.units);
  const locale = settings.locale ?? localeOf(units.distance);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // playing through the dates: the figures are the last survey passed's (the note says so)
  const playing = useTimelapsePlaying();

  const vol = (m3: number) => volumeParts(m3, units, settings.precision.volume, locale).num;
  const mass = (tn: number | null) => (tn === null ? '-' : massParts(tn, units, locale).num);
  const delta = (m3: number | null) =>
    m3 === null ? '' : minusSigned(vol(m3), Math.abs(m3) < 1e-9 ? 0 : m3);
  const sign = (m3: number | null) =>
    m3 === null || Math.abs(m3) < 1e-9 ? undefined : m3 < 0 ? 'loss' : 'gain';
  const dens = (d: number | null) =>
    d === null ? '' : `${formatNumber(d, DENSITY_DECIMALS, locale)} ${t('pile.densityUnit')}`;
  const unit = volumeParts(0, units, 0, locale).unit;

  // the piles the figures leave out, each with why (every pile without a survey date)
  const counted = new Set(model?.groups.flatMap((g) => g.piles.map((p) => p.id)) ?? []);
  const reasons = new Map((model?.notCounted ?? []).map((n) => [n.id, n]));
  const left = piles.filter((m) => !counted.has(m.id));
  const why = (id: string) => {
    const n: NotCounted | undefined = reasons.get(id);
    return n ? notCountedReason(n) : t('vol.status.none');
  };
  const partial = new Set(model?.partial ?? []);

  const row = (id: string, label: ReactNode, cells: ReactNode, hidden = false) => {
    const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPile(id);
      }
    };
    return (
      <tr
        key={id}
        className="vi-pile"
        tabIndex={0}
        hidden={hidden}
        data-testid="volumes-pile"
        data-id={id}
        onClick={() => {
          onPile(id);
        }}
        onKeyDown={onKey}
      >
        <th scope="row" className="vi-name">
          {label}
        </th>
        {cells}
      </tr>
    );
  };

  return (
    <section className="vi" data-testid="volumes-inventory">
      <div className="vi-cap">
        <span>{t('volumes.groupedBy', { base: baseCaption(piles, counted, t) })}</span>
        {model?.previous && (
          <span>{t('volumes.deltaVs', { date: formatDate(model.previous.date) })}</span>
        )}
      </div>
      <table className="vi-table" data-testid="volumes-inventory-table">
        <caption className="sr-only">{t('volumes.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('volumes.col.pile')}</th>
            <th scope="col">{t('volumes.col.volume', { unit })}</th>
            <th scope="col">{t('volumes.col.tonnes')}</th>
            <th scope="col">{t('volumes.col.delta', { unit })}</th>
          </tr>
        </thead>
        <tbody>
          {model?.groups.map((g) => {
            const key = keyOf(g);
            const more = g.piles.length - GROUP_SHOWN;
            const expanded = open.has(key);
            return (
              <Fragment key={`g:${key}`}>
                <tr className="vi-group" data-testid="volumes-group" data-material={key}>
                  <th scope="rowgroup" className="vi-name">
                    <span className="vi-sq" style={{ background: g.colour }} aria-hidden="true" />
                    {g.material?.id === 'kit' && g.material.name === KIT_MATERIAL_NAME
                      ? t('volumes.kitSiteDensity')
                      : (g.material?.name ?? t('volumes.noMaterial'))}
                    {g.densityTPerM3 !== null && (
                      <span className="vi-dens">{dens(g.densityTPerM3)}</span>
                    )}
                  </th>
                  <td>{vol(g.volumeM3)}</td>
                  <td>{mass(g.tonnes)}</td>
                  <td data-sign={sign(g.deltaM3)}>{delta(g.deltaM3)}</td>
                </tr>
                {g.piles.map((p, i) =>
                  row(
                    p.id,
                    partial.has(p.id) ? (
                      <>
                        <span className="vi-partial">{p.label}</span>
                        <span className="sr-only">. {t('vol.status.partial')}</span>
                      </>
                    ) : (
                      p.label
                    ),
                    <>
                      <td>{vol(p.volumeM3)}</td>
                      <td>{mass(p.tonnes)}</td>
                      <td data-sign={sign(p.deltaM3)}>{delta(p.deltaM3)}</td>
                    </>,
                    !expanded && i >= GROUP_SHOWN,
                  ),
                )}
                {more > 0 && !expanded && (
                  <tr className="vi-more">
                    <td colSpan={4}>
                      <button
                        type="button"
                        className="vi-more-btn"
                        data-testid="volumes-more"
                        onClick={() => {
                          setOpen(new Set([...open, key]));
                        }}
                      >
                        {t('volumes.more', { count: more })}
                      </button>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {left.length > 0 && (
            <>
              <tr className="vi-group vi-left">
                <th scope="rowgroup" className="vi-name" colSpan={4}>
                  {t('vol.view.notCounted')}
                </th>
              </tr>
              {left.map((m) =>
                row(
                  m.id,
                  m.label,
                  <td colSpan={3} className="vi-why">
                    {why(m.id)}
                  </td>,
                ),
              )}
            </>
          )}
          {model && model.piles > 0 && (
            <tr className="vi-total" data-testid="volumes-site-total">
              <th scope="row" className="vi-name">
                {t('volumes.siteTotal')}
              </th>
              <td>{vol(model.volumeM3)}</td>
              <td>{model.tonnes === null ? '-' : mass(model.tonnes)}</td>
              <td data-sign={sign(model.change?.m3 ?? null)}>{delta(model.change?.m3 ?? null)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {playing && (
        <p className="vi-note" role="note" data-testid="volumes-playback-note">
          {t('timelapse.playbackNote')}
        </p>
      )}
    </section>
  );
}
