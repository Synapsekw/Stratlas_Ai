import {
  evidenceNeed,
  PROVIDER_LABELS,
  SendDialog,
  type EvidencePreviewContent,
  type EvidencePreviewImage,
  type ModelRoute,
} from '@aio/ai';
import { useT, type MessageKey } from '@aio/ui';
import { useState } from 'react';

type Need = 'photos' | 'scans';

export interface EvidencePreviewProps {
  /**
   * What the request sends, made in main by the same function that builds the request
   * (`buildEngineerPayload`, then `payloadPreview`): the images after the per-request cut and the
   * downscale, with their metadata stripped, and the request text.
   */
  content: EvidencePreviewContent;
  route: ModelRoute;
  /** Estimated cost in US dollars; undefined when the model has no price. */
  estimateUsd: number | undefined;
  budgetUsd?: number | undefined;
  /** The project's consents as main read them from the manifest. */
  flags: { photos: boolean; scans: boolean };
  /** "Allow for this project": the parent asks main to set `aiCloudPhotos` or `aiCloudScans`. */
  onAllowProject: (kind: Need) => void;
  /**
   * Send this request. `once` is the one-time consent per kind (main checks it against the
   * manifest for every request); `costConfirmed` is set when the price is unknown.
   */
  onSendOnce: (o: { once: { photos: boolean; scans: boolean }; costConfirmed: boolean }) => void;
  onCancel: () => void;
}

const GROUPS: readonly { need: Need; title: MessageKey; once: MessageKey }[] = [
  { need: 'photos', title: 'eng.ev.photos', once: 'eng.ev.photosOnce' },
  { need: 'scans', title: 'eng.ev.scans', once: 'eng.ev.scansOnce' },
];

const KIND_LABELS: Record<EvidencePreviewImage['kind'], MessageKey> = {
  photo: 'eng.ev.kind.photo',
  crop: 'eng.ev.kind.crop',
  side: 'eng.ev.kind.side',
  top: 'eng.ev.kind.top',
  slice: 'eng.ev.kind.slice',
  generated: 'eng.ev.kind.generated',
};

type T = ReturnType<typeof useT>;

/** 117 KB, 1.4 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${String(Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function imagesText(t: T, count: number, bytes: number): string {
  return t('eng.ev.imageCount', { count, size: formatBytes(bytes) });
}

function costText(t: T, usd: number | undefined, local: boolean): string {
  if (local) return t('eng.ev.costLocal');
  if (usd === undefined) return t('eng.ev.costUnknown');
  if (usd < 0.01) return t('eng.ev.costUnder');
  return t('eng.ev.costAbout', { usd: usd.toFixed(2) });
}

/**
 * The engineering model's send preview: exactly the images and text the AI step sends, grouped by
 * the consent each needs (photos, scan views), with the cost estimate. Nothing is sent until the
 * person chooses Send once; "Allow for this project" stores the consent in the project and the
 * main process checks it again for every request.
 */
export function EvidencePreview(p: EvidencePreviewProps) {
  const t = useT();
  const local = p.route.provider === 'local';
  const provider = PROVIDER_LABELS[p.route.provider];
  const [once, setOnce] = useState({ photos: false, scans: false });
  const byNeed = (need: Need) => p.content.images.filter((im) => evidenceNeed(im.kind) === need);
  const needs = (need: Need) =>
    byNeed(need).length > 0 || (need === 'scans' && Boolean(p.content.measurements));
  const total = p.content.images.reduce((n, im) => n + im.bytes, 0);
  const consented = GROUPS.every((g) => local || !needs(g.need) || p.flags[g.need] || once[g.need]);
  const priced = local || p.estimateUsd !== undefined;
  const ready = consented && priced;
  const left = p.content.leftOut;
  const missing = GROUPS.filter(
    (g) => !local && needs(g.need) && !p.flags[g.need] && !once[g.need],
  ).map((g) => g.need);
  const kinds: MessageKey =
    missing.length > 1
      ? 'eng.ev.whyKinds.both'
      : missing[0] === 'scans'
        ? 'eng.ev.whyKinds.scans'
        : 'eng.ev.whyKinds.photos';
  const why = !consented
    ? t('eng.ev.whyConsent', { kinds: t(kinds) })
    : !priced
      ? t('eng.ev.whyCost')
      : null;

  return (
    <SendDialog
      standalone
      className="ag-ev"
      titleId="eng-ev-h"
      title={local ? t('eng.ev.titleLocal') : t('eng.ev.title', { provider })}
      onCancel={p.onCancel}
      actions={
        <>
          <button type="button" className="ag-btn" onClick={p.onCancel}>
            {t('eng.ev.cancel')}
          </button>
          <button
            type="button"
            className="ag-btn primary"
            disabled={!ready}
            aria-describedby={why ? 'eng-ev-why' : undefined}
            onClick={() => {
              p.onSendOnce({
                once: { photos: !local && once.photos, scans: !local && once.scans },
                costConfirmed: false,
              });
            }}
          >
            {local ? t('eng.ev.run') : t('eng.ev.sendOnce')}
          </button>
        </>
      }
    >
      <p className="ag-sub">{local ? t('eng.ev.subLocal') : t('eng.ev.sub')}</p>
      {p.budgetUsd !== undefined && (
        <p className="notice">{t('eng.ev.runBudget', { usd: p.budgetUsd.toFixed(2) })}</p>
      )}
      <dl className="ag-sent">
        <dt>{t('eng.ev.provider')}</dt>
        <dd className="ag-mono">
          {provider}, {p.route.model}
        </dd>
        <dt>{t('eng.ev.images')}</dt>
        <dd>{t('eng.ev.imagesAll', { images: imagesText(t, p.content.images.length, total) })}</dd>
        <dt>{t('eng.ev.size')}</dt>
        <dd>{t('eng.ev.sizeWithText', { size: formatBytes(p.content.bytes) })}</dd>
        <dt>{t('eng.ev.cost')}</dt>
        <dd className={p.estimateUsd === undefined && !local ? 'ag-ev-cost unknown' : 'ag-ev-cost'}>
          {costText(t, p.estimateUsd, local)}
        </dd>
        <dt>{t('eng.ev.text')}</dt>
        <dd>
          <pre>{p.content.text}</pre>
        </dd>
      </dl>

      {GROUPS.map((g) => {
        const images = byNeed(g.need);
        if (!needs(g.need)) return null;
        const allowed = p.flags[g.need];
        return (
          <section
            key={g.need}
            className="ag-ev-group"
            data-need={g.need}
            aria-labelledby={`eng-ev-${g.need}`}
          >
            <div className="ag-ev-head">
              <b id={`eng-ev-${g.need}`}>{t(g.title)}</b>
              <span className="ag-faint">
                {imagesText(
                  t,
                  images.length,
                  images.reduce((n, im) => n + im.bytes, 0),
                )}
              </span>
              {!local &&
                (allowed ? (
                  <span className="ag-ev-ok">{t('eng.ev.allowed')}</span>
                ) : (
                  <button
                    type="button"
                    className="ag-btn sm"
                    onClick={() => {
                      p.onAllowProject(g.need);
                    }}
                  >
                    {t('eng.ev.allow')}
                  </button>
                ))}
            </div>
            <ul className="ag-ev-thumbs">
              {images.map((im) => (
                <li key={im.id}>
                  <figure data-image={im.id}>
                    <img src={im.thumb} alt={im.label} width={96} height={96} />
                    <figcaption>
                      <b>{im.id}</b>
                      <span>{t(KIND_LABELS[im.kind])}</span>
                      <span>
                        {t('eng.ev.imageSize', {
                          width: String(im.width),
                          height: String(im.height),
                          size: formatBytes(im.bytes),
                        })}
                      </span>
                      {im.resized && <span>{t('eng.ev.resized')}</span>}
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ul>
            {g.need === 'scans' && p.content.measurements && (
              <details>
                <summary>{t('eng.ev.measurements')}</summary>
                <pre>{p.content.measurements}</pre>
              </details>
            )}
            {!local && !allowed && (
              <label className="ag-check">
                <input
                  type="checkbox"
                  checked={once[g.need]}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setOnce((o) => ({ ...o, [g.need]: checked }));
                  }}
                />
                {t(g.once)}
              </label>
            )}
          </section>
        );
      })}

      {left.length > 0 && (
        <p className="ag-faint">
          {t('eng.ev.leftOut', { count: left.length, ids: left.join(', ') })}
        </p>
      )}
      {why && (
        <p id="eng-ev-why" className="ag-sub">
          {why}
        </p>
      )}
    </SendDialog>
  );
}
