/**
 * The pile panel's Profile (spec section 3, board 2): the pile's surface on each shown survey date
 * along its long axis (or the line moved and turned in the scene, kept per pile in `pileView`).
 * Chips per date with their surface state, "Shade cut & fill vs [earlier date]", the line's length,
 * the shared `ProfileChart` linked to the scene as `pile:<id>` (spec section 4), then the cut and
 * fill over the whole pile between the two dates (the volume engine's, never estimated) and the
 * largest drop along the line, and Open larger, Export PNG and Add to report.
 *
 * A date still preparing names itself in the placeholder ("Building the height surface for …");
 * the ready dates draw at once and the others join when their surface is ready.
 */
import { formatNumber, formatQuantity, localeOf, unitLabel } from '@aio/geo';
import {
  DEFAULT_ANGLES,
  type HeightTiles,
  type SitePoint,
  type SurveyMeasurement,
} from '@aio/schema';
import { effectiveUnits, pileAxis, sampleProfile, type ChartSeries } from '@aio/survey';
import { Button, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { autoExaggeration } from '../../charts/exaggeration';
import { chartPng, savePng } from '../../charts/exportChart';
import { ProfileChart } from '../../charts/ProfileChart';
import { SurfaceChips, type ChipOption } from '../../charts/SurfaceChips';
import { addToReport } from '../../report/templateStore';
import { emptyReason, surfaceTiles, withSurface } from '../card/pointHistory';
import { useLoaded, useSurveyDates } from '../card/slots';
import { engineClient, ringOf, useCompare } from '../compareStore';
import { fileBase } from '../exportHelpers';
import { drawnPoints } from '../measureDates';
import { useMeasure } from '../measureStore';
import { useFocusCapture } from '../qaHelpers';
import { useQa } from '../qaStore';
import { openSection, setWindow } from '../sectionStore';
import { usePreparingSoon } from '../surfaceStates';
import { useLinkedChart } from '../useLinkedChart';
import { largestDrop, minusSigned, usePileView } from './pileView';
import '../../charts/charts.css';

/** What the person chose on this pile's chips (kept while the panel is open on the pile). */
interface ProfileView {
  /** null: the date in view and the one before. */
  shown: string[] | null;
  off: string[];
  shade: boolean;
}

/** The cut and fill between two dates over the pile's outline, as the engine works it out. */
interface DatesCutFill {
  key: string;
  cutM3: number;
  fillM3: number;
}

const surfacesKey = (opts: readonly { key: string; tiles?: HeightTiles | undefined }[]) =>
  opts.map((o) => `${o.key}:${o.tiles?.fingerprint ?? ''}`).join(',');

export function PileProfile({ m }: { m: SurveyMeasurement }): ReactElement {
  const t = useT();
  const project = useWorkspace((s) => s.project?.id ?? null);
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const settings = useMeasure((s) => s.settings);
  const engineStatus = useCompare((s) => s.status);
  const units = effectiveUnits(settings.units, m.units);
  const locale = settings.locale ?? localeOf(units.distance);
  const angles = settings.angles ?? DEFAULT_ANGLES;
  const d = (x: number) => formatQuantity(x, 'distance', units, settings.precision, locale);
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision, locale);

  // the line: the one kept for the pile, else its long axis
  const pts = useMemo(() => drawnPoints(m, manifest), [m, manifest]);
  const kept = usePileView((s) => s.axis.get(m.id));
  const axis = useMemo(() => kept ?? pileAxis(pts), [kept, pts]);
  const polyline = useMemo(() => [axis.a, axis.b] as const, [axis]);
  const line = useMemo(
    (): SitePoint[] => [
      [axis.a[0], axis.a[1], 0],
      [axis.b[0], axis.b[1], 0],
    ],
    [axis],
  );

  // the surfaces: every survey date with its state, and the designs
  const dated = useSurveyDates();
  const qaSurfaces = useQa((s) => s.surfaces);
  const designs = useMemo(
    () =>
      qaSurfaces
        .filter((x) => x.source.kind === 'design')
        .map((x) => ({ key: `design:${x.id}`, label: x.name, tiles: x }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [qaSurfaces],
  );
  const focus = useFocusCapture();
  const current = dated.find((x) => x.capture === focus)?.capture ?? dated.at(-1)?.capture ?? null;
  const at = dated.findIndex((x) => x.capture === current);
  const [view, setView] = useState<ProfileView>({ shown: null, off: [], shade: true });
  const options: ChipOption[] = [
    ...dated.map((x): ChipOption => ({
      key: x.capture,
      label: x.label,
      kind: x.capture === current ? 'current' : 'earlier',
      group: 'survey',
      date: x.date,
      state: x.state,
    })),
    ...designs.map((x): ChipOption => ({
      key: x.key,
      label: x.label,
      kind: 'design',
      group: 'design',
    })),
  ];
  const known = new Set(options.map((o) => o.key));
  const fallback = [at > 0 ? dated[at - 1]?.capture : undefined, current].filter(
    (x): x is string => !!x,
  );
  const shown = (view.shown ?? fallback).filter((k) => known.has(k));
  const tilesOf = (key: string): HeightTiles | undefined =>
    dated.find((x) => x.capture === key)?.tiles ?? designs.find((x) => x.key === key)?.tiles;
  // a survey date draws once its surface is ready
  const picked = options.filter((o) => shown.includes(o.key) && tilesOf(o.key) !== undefined);

  const len = axis.lengthM;
  const series = useLoaded<ChartSeries[]>(
    project && len > 0 && picked.length > 0
      ? `pile|${project}|${JSON.stringify(line)}|${surfacesKey(picked.map((o) => ({ key: `${o.key}/${o.kind}`, tiles: tilesOf(o.key) })))}`
      : null,
    () => {
      const step = Math.max(0.25, len / 400);
      return Promise.all(
        picked.flatMap((o) => {
          const tiles = tilesOf(o.key);
          if (!tiles) return [];
          return [
            withSurface(
              (h) => sampleProfile(line, h, step),
              tiles,
              surfaceTiles(project ?? '', tiles),
            ).then((p): ChartSeries => ({
              key: o.key,
              label: o.label,
              kind: o.kind,
              ...(o.group === 'survey' ? { capture: o.key } : {}),
              ...(o.date ? { date: o.date } : {}),
              chainage: p.chainage,
              z: p.z,
            })),
          ];
        }),
      );
    },
  );
  const visible = useMemo(() => {
    if (series.status !== 'ready') return [];
    const off = new Set(view.off);
    // oldest first, as the linked hover reads them
    return series.value
      .filter((x) => !off.has(x.key))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  }, [series, view.off]);
  const link = useLinkedChart(`pile:${m.id}`, polyline, visible);

  // shading and the whole-pile figures: the date in view against the latest earlier date shown
  const later = visible.find((x) => x.kind === 'current') ?? null;
  const earlier = visible.filter((x) => x.kind === 'earlier').at(-1) ?? null;
  const shadeVs = view.shade && later && earlier ? earlier.key : null;
  const drop = later && earlier ? largestDrop(later, earlier) : null;

  const pairKey =
    later && earlier && engineStatus === 'ready' && m.points.length >= 3
      ? [m.id, earlier.key, later.key, JSON.stringify(m.points)]
          .concat([earlier.key, later.key].map((k) => tilesOf(k)?.fingerprint ?? ''))
          .join('|')
      : null;
  const [cutFill, setCutFill] = useState<DatesCutFill | null>(null);
  useEffect(() => {
    const from = earlier ? tilesOf(earlier.key) : undefined;
    const to = later ? tilesOf(later.key) : undefined;
    if (pairKey === null || !later?.capture || !earlier?.capture || !from || !to) return;
    let live = true;
    engineClient()
      .run(
        {
          ring: ringOf(m.points),
          items: [
            {
              id: 'dates',
              from: { kind: 'survey', surface: from.id, capture: earlier.capture },
              to: { kind: 'survey', surface: to.id, capture: later.capture },
              useDeadband: false,
            },
          ],
        },
        `pile-dates:${m.id}`,
      )
      .then(
        (r) => {
          const res = r.results[0];
          if (live && res) setCutFill({ key: pairKey, cutM3: res.cutM3, fillM3: res.fillM3 });
        },
        () => {
          // replaced by a newer run, or the engine could not: no figure, never an estimate
        },
      );
    return () => {
      live = false;
    };
    // `pairKey` names every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey]);
  const figures = cutFill?.key === pairKey ? cutFill : null;

  // the placeholder: a shown date still preparing, and the ready ones
  const shownDates = dated.filter((x) => shown.includes(x.capture));
  const preparing = shownDates.filter((x) => x.state.kind === 'preparing');
  const ready = shownDates.filter((x) => x.tiles !== null);
  const building = preparing[0];
  const soon = usePreparingSoon();

  const root = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState<{ text: string; warn: boolean } | null>(null);
  const failed = (e: unknown) => {
    setDone({ text: e instanceof Error ? e.message : String(e), warn: true });
  };
  const savePicture = async () => {
    setDone(null);
    try {
      const svg = root.current?.querySelector<SVGSVGElement>('svg.pc-svg');
      if (!svg) throw new Error(t('chart.exportFailed'));
      await savePng(await chartPng(svg), `${fileBase(m.label)}.png`);
    } catch (e) {
      failed(e);
    }
  };

  const chips = (
    <SurfaceChips
      shown={shown.flatMap((k) => options.filter((o) => o.key === k))}
      off={new Set(view.off)}
      addable={options.filter((o) => !shown.includes(o.key))}
      onToggle={(key) => {
        setView((w) => ({
          ...w,
          shown,
          off: w.off.includes(key) ? w.off.filter((k) => k !== key) : [...w.off, key],
        }));
      }}
      onAdd={(key) => {
        setView((w) => ({ ...w, shown: [...shown, key] }));
      }}
      onRemove={(key) => {
        setView((w) => ({
          ...w,
          shown: shown.filter((k) => k !== key),
          off: w.off.filter((k) => k !== key),
        }));
      }}
      testId="pile-chips"
    />
  );

  const empty = visible.length === 0 || !visible.some((x) => x.z.some((z) => z !== null));
  return (
    <div className="pp-profile" data-testid="pile-profile" ref={root}>
      {chips}
      <div className="pp-row">
        {earlier && later ? (
          <button
            type="button"
            className="pp-shade"
            aria-pressed={view.shade}
            data-testid="pile-shade"
            onClick={() => {
              setView((w) => ({ ...w, shade: !w.shade }));
            }}
          >
            <span className="pp-shade-box" aria-hidden="true" />
            {t('pile.shadeVs')} <b>{earlier.label}</b>
          </button>
        ) : (
          <span />
        )}
        <span className="pp-line" data-testid="pile-line">
          {t('pile.lineAxis', { length: d(axis.lengthM) })}
        </span>
      </div>

      {building && (
        <p className="pp-building small faint" role="status" data-testid="pile-building">
          {t('chart.building', { date: building.label })}
          {ready.length > 0 &&
            ` ${t('chart.buildingRest', {
              ready: ready.map((x) => x.label).join(', '),
              waiting: preparing.map((x) => x.label).join(', '),
            })}`}
        </p>
      )}
      {series.status === 'loading' && !building && (
        <p className="small faint" role="status">
          {t('vol.elev.reading')}
        </p>
      )}
      {!empty ? (
        <ProfileChart
          series={visible}
          shadeVs={shadeVs}
          exaggeration={autoExaggeration(visible)}
          ends={{ a: t('mcard.endA'), b: t('mcard.endB') }}
          units={units}
          precision={settings.precision}
          locale={locale}
          angles={angles}
          height={204}
          testId="pile-profile-chart"
          {...link}
        />
      ) : (
        !building &&
        series.status !== 'loading' && (
          <p className="small faint" data-testid="pile-profile-none">
            {t(
              emptyReason(
                shownDates.length > 0 ? shownDates.map((x) => x.state) : dated.map((x) => x.state),
                soon,
              ),
            )}
          </p>
        )
      )}

      {(figures !== null || drop !== null) && (
        <dl className="pp-facts pp-facts-profile">
          {figures && (
            <>
              <div data-testid="pile-cut">
                <dt className="pp-cap">{t('pile.cutWhole')}</dt>
                <dd data-sign="loss">{v(figures.cutM3)}</dd>
              </div>
              <div data-testid="pile-fill">
                <dt className="pp-cap">{t('pile.fill')}</dt>
                <dd data-sign="gain">{v(figures.fillM3)}</dd>
              </div>
            </>
          )}
          {drop && (
            <div data-testid="pile-drop">
              <dd>
                {t('pile.largestDrop', {
                  value: minusSigned(d(drop.dz), drop.dz),
                  chainage: `${formatNumber(drop.chainageM, 0, locale)} ${unitLabel(units.distance)}`,
                })}
              </dd>
            </div>
          )}
        </dl>
      )}

      <div className="pp-actions">
        <Button
          icon="section"
          data-testid="pile-open-larger"
          onClick={() => {
            openSection([[...axis.a], [...axis.b]], {
              kind: 'measurement',
              id: m.id,
              label: m.label,
              ...(m.scope.kind === 'survey' ? { capture: m.scope.capture } : {}),
            });
            setWindow(true);
          }}
        >
          {t('mcard.openSection')}
        </Button>
        <Button
          icon="download"
          data-testid="pile-profile-png"
          disabled={empty}
          onClick={() => {
            void savePicture();
          }}
        >
          {`${t('chart.export')} ${t('chart.png')}`}
        </Button>
        <Button
          variant="primary"
          icon="report"
          data-testid="pile-profile-report"
          onClick={() => {
            setDone(null);
            addToReport(m.id).then((r) => {
              setDone({ text: t(r === 'added' ? 'report.added' : 'report.already'), warn: false });
            }, failed);
          }}
        >
          {t('chart.addToReport')}
        </Button>
      </div>
      {done && (
        <p
          className={done.warn ? 'notice warn small' : 'small faint'}
          role={done.warn ? 'alert' : 'status'}
        >
          {done.text}
        </p>
      )}
    </div>
  );
}
