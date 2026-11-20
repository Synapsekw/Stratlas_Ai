// The site overview, the first page of part B of the volumetric report (the founder-approved
// layout of 20 Nov 2026): the stock on the latest date with its change, the share-of-stock bar
// (the 8 largest piles above zero, the rest as Others), then the site photo, the elevation map and
// the 3D site view of the latest date, each with the pile numbers and a caption. A yard taller
// than wide sets the photo and the elevation side by side with the 3D view across the page under
// them; a wider yard sets the photo across the page. Laid out by counts, never measured. A
// component of `piles.tsx`, not a page module of its own.
import type { VolumetricModel } from '@aio/project/export';
import { t } from '@aio/ui';
import type { ReactElement } from 'react';
import type { ReportViews } from '../types/template';
import { dateText, Markers, num, signed, signedPct, SitePicture } from './chrome';

type CaptureRef = NonNullable<VolumetricModel['latest']>;

const way = (v: number | null): string =>
  v === null || v === 0 ? 'is-flat' : v < 0 ? 'is-down' : 'is-up';

const pct = (v: number) => `${(Math.round(v * 100000) / 1000).toFixed(3)}%`;

function Header({ model }: { model: VolumetricModel }): ReactElement {
  const k = model.kpis;
  const sub = [
    model.project.site,
    model.latest ? t('vreport.band.surveyed', { date: dateText(model.latest.date) }) : null,
  ].filter((s): s is string => s !== null && s.trim() !== '');
  return (
    <header className="vr-ov-head">
      <div className="vr-ov-heading">
        <h1>{t('vreport.overview.title')}</h1>
        {sub.length > 0 ? (
          <p className="vr-ov-site">
            {sub.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </p>
        ) : null}
      </div>
      <div className="vr-ov-figures">
        <span className="vr-ov-total">{`${num(k.stockM3)} m³`}</span>
        <span className="vr-ov-sub">
          {k.tonnes !== null ? <span className="vr-ov-tonnes">{`${num(k.tonnes)} t`}</span> : null}
          {k.changeM3 !== null && model.compared ? (
            <span className={`vr-ov-change ${way(k.changeM3)}`}>
              <span>{signed(k.changeM3, ' m³')}</span>
              {k.changePct !== null ? <span>{signedPct(k.changePct)}</span> : null}
            </span>
          ) : null}
        </span>
      </div>
    </header>
  );
}

/** Segments under this share carry no label inside the bar; the key under the bar names them. */
const LABEL_SHARE = 0.12;

/**
 * The share of the stock above zero: the bar, and under it a key naming every segment with its
 * share, so a narrow segment is never a cut-off label.
 */
export function ShareBar({ model }: { model: VolumetricModel }): ReactElement | null {
  if (model.share.length === 0) return null;
  const segments = model.share.map((s, i) => {
    const others = s.id === null;
    return {
      key: s.id ?? 'others',
      cls: others ? 'is-others' : `vr-share-${String(i)}${i < 4 ? ' is-dark' : ''}`,
      label: others ? t('vreport.piles.others') : (s.label ?? ''),
      share: s.share,
    };
  });
  return (
    <section className="vr-share">
      <h2>{t('vreport.piles.share')}</h2>
      <div className="vr-share-bar">
        {segments.map((s) => (
          <span
            key={s.key}
            className={`vr-share-seg ${s.cls}`}
            data-seg={s.key}
            style={{ width: pct(s.share) }}
          >
            {s.share >= LABEL_SHARE ? `${Math.round(s.share * 100).toFixed(0)} %` : ''}
          </span>
        ))}
      </div>
      <ul className="vr-share-key">
        {segments.map((s) => (
          <li key={s.key}>
            <i className={`vr-share-dot ${s.cls}`} aria-hidden="true" />
            <span className="vr-share-name">{s.label}</span>
            <span className="vr-share-pct">{`${(s.share * 100).toFixed(1)} %`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The 3D site picture's shape: as wide as the frame's longer side, 3 to 2 (the capture's). */
const ASPECT_3D = 1.5;

/** The 3D site view with the pile numbers where the camera saw them (`frame.markers3d`). */
function Site3d({
  model,
  views,
  capture,
  box,
}: {
  model: VolumetricModel;
  views: ReportViews;
  capture: CaptureRef;
  box: readonly [number, number];
}): ReactElement {
  const size = { width: `${String(box[0])}mm`, height: `${String(box[1])}mm` };
  const src = views.picture('3d', capture.id);
  const frame = views.frame ?? model.frame;
  if (!src || !frame)
    return (
      <div className="vr-ov-3d vr-picture is-empty" style={size}>
        <span className="vr-photo-none">{t('vreport.pictures.placeholder')}</span>
      </div>
    );
  const w = Math.max(frame.widthPx, frame.heightPx);
  const h = Math.round(w / ASPECT_3D);
  // the picture covers its box, centred: the empty ground and sky around the yard are cut away
  const k = Math.max(box[0] / w, box[1] / h);
  // what the box shows of the picture, mm from the picture's top left
  const left = (w * k - box[0]) / 2;
  const top = (h * k - box[1]) / 2;
  const seen = (x: number, y: number) =>
    x >= left && y >= top && x <= left + box[0] && y <= top + box[1];
  const at = frame.markers3d[capture.id] ?? {};
  const marks = model.piles.flatMap((p) => {
    const m = at[p.id];
    return m && seen(m[0] * k, m[1] * k)
      ? [{ id: p.id, tag: p.tag, x: m[0] * k, y: m[1] * k }]
      : [];
  });
  return (
    <div className="vr-ov-3d vr-picture" style={size}>
      <div
        className="vr-picture-inner"
        style={{ width: `${(w * k).toFixed(2)}mm`, height: `${(h * k).toFixed(2)}mm` }}
      >
        <img src={src} alt="" />
        <Markers marks={marks} width={w * k} height={h * k} />
      </div>
    </div>
  );
}

/**
 * The overview's picture boxes, mm (width, height). With the header, the share bar and the
 * captions they add up to the page's body: see piles.css.
 */
const WIDE = { photo: [182, 110], elevation: [89.5, 78], view: [89.5, 78] } as const;
const TALL = { photo: [89.5, 112], elevation: [89.5, 112], view: [182, 78] } as const;

/** The site overview: header, share bar and the three site pictures of the latest date. */
export function Overview({
  model,
  views,
  reserveMm = 0,
}: {
  model: VolumetricModel;
  views: ReportViews;
  /** Height the page needs under the pictures (the closing block on a last page), mm. */
  reserveMm?: number;
}): ReactElement {
  const latest = model.latest;
  const frame = views.frame ?? model.frame;
  const date = latest ? dateText(latest.date) : '';
  const tall = frame !== null && frame.heightPx > frame.widthPx * 1.1;
  const base = tall ? TALL : WIDE;
  // the room a closing block needs comes off the two rows of pictures, half each
  const cut = Math.min(reserveMm / 2, 24);
  const boxes = {
    photo: [base.photo[0], base.photo[1] - cut],
    elevation: [base.elevation[0], base.elevation[1] - cut],
    view: [base.view[0], base.view[1] - cut],
  } as const;
  const photo = (
    <figure className="vr-ov-fig" data-view="photo">
      <SitePicture
        className="vr-ov-photo"
        src={latest ? views.picture('photo', latest.id) : null}
        frame={frame}
        piles={model.piles}
        boxW={boxes.photo[0]}
        boxH={boxes.photo[1]}
      />
      <figcaption>{t('vreport.overview.photo', { date })}</figcaption>
    </figure>
  );
  const elevation = (
    <figure className="vr-ov-fig" data-view="elevation">
      <SitePicture
        className="vr-ov-elev"
        src={latest ? views.picture('elevation', latest.id) : null}
        frame={frame}
        piles={model.piles}
        boxW={boxes.elevation[0]}
        boxH={boxes.elevation[1]}
      />
      <figcaption>{t('vreport.overview.elevation', { date })}</figcaption>
    </figure>
  );
  const view = (
    <figure className="vr-ov-fig" data-view="3d">
      {latest ? (
        <Site3d model={model} views={views} capture={latest} box={boxes.view} />
      ) : (
        <div
          className="vr-ov-3d vr-picture is-empty"
          style={{ width: `${String(boxes.view[0])}mm`, height: `${String(boxes.view[1])}mm` }}
        >
          <span className="vr-photo-none">{t('vreport.pictures.placeholder')}</span>
        </div>
      )}
      <figcaption>{t('vreport.overview.3d', { date })}</figcaption>
    </figure>
  );
  return (
    <div className={`vr-ov${tall ? ' is-tall' : ' is-wide'}`}>
      <Header model={model} />
      <ShareBar model={model} />
      {tall ? (
        <>
          <div className="vr-ov-pair">
            {photo}
            {elevation}
          </div>
          {view}
        </>
      ) : (
        <>
          {photo}
          <div className="vr-ov-pair">
            {elevation}
            {view}
          </div>
        </>
      )}
    </div>
  );
}
