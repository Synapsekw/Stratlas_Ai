import {
  evidenceNeed,
  PROVIDER_LABELS,
  SendDialog,
  type EvidencePreviewContent,
  type EvidencePreviewImage,
  type ModelRoute,
} from '@aio/ai';
import { useEffect, useRef, useState } from 'react';

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

const GROUPS: readonly { need: Need; title: string; once: string; none: string }[] = [
  {
    need: 'photos',
    title: 'Photos',
    once: 'Send photos this once',
    none: 'Photos of the asset, as taken.',
  },
  {
    need: 'scans',
    title: 'Scan views',
    once: 'Send scan views this once',
    none: 'Renders and slices of the point cloud.',
  },
];

const KIND_LABELS: Record<EvidencePreviewImage['kind'], string> = {
  photo: 'Photo',
  crop: 'Photo crop',
  side: 'Side view',
  top: 'Top view',
  slice: 'Slice',
  generated: 'Generated view',
};

/** 117 KB, 1.4 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${String(Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function imagesText(count: number, bytes: number): string {
  return `${String(count)} ${count === 1 ? 'image' : 'images'}, ${formatBytes(bytes)}`;
}

function costText(usd: number | undefined, local: boolean): string {
  if (local) return 'No cost: the model runs on this workstation.';
  if (usd === undefined) return 'Price not known for this model';
  if (usd < 0.01) return 'Under US$0.01';
  return `About US$${usd.toFixed(2)}`;
}

/**
 * The engineering model's send preview: exactly the images and text the AI step sends, grouped by
 * the consent each needs (photos, scan views), with the cost estimate. Nothing is sent until the
 * person chooses Send once; "Allow for this project" stores the consent in the project and the
 * main process checks it again for every request.
 */
export function EvidencePreview(p: EvidencePreviewProps) {
  const local = p.route.provider === 'local';
  const provider = PROVIDER_LABELS[p.route.provider];
  const [once, setOnce] = useState({ photos: false, scans: false });
  const [costConfirmed, setCostConfirmed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const byNeed = (need: Need) => p.content.images.filter((im) => evidenceNeed(im.kind) === need);
  const total = p.content.images.reduce((n, im) => n + im.bytes, 0);
  const consented = GROUPS.every(
    (g) => local || byNeed(g.need).length === 0 || p.flags[g.need] || once[g.need],
  );
  const priced = local || p.estimateUsd !== undefined || costConfirmed;
  const ready = consented && priced;
  const left = p.content.leftOut;

  return (
    <SendDialog
      standalone
      className="ag-ev"
      titleId="eng-ev-h"
      title={local ? 'Run on the local model?' : `Send evidence to ${provider}?`}
      onCancel={p.onCancel}
      actions={
        <>
          <button ref={cancelRef} type="button" className="ag-btn" onClick={p.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="ag-btn primary"
            disabled={!ready}
            onClick={() => {
              p.onSendOnce({
                once: { photos: !local && once.photos, scans: !local && once.scans },
                costConfirmed: !local && p.estimateUsd === undefined && costConfirmed,
              });
            }}
          >
            {local ? 'Run' : 'Send once'}
          </button>
        </>
      }
    >
      <p className="ag-sub">
        {local
          ? 'Nothing leaves this workstation. This is what the local model reads for the engineering step:'
          : 'This is exactly what leaves this workstation for the engineering step:'}
      </p>
      <dl className="ag-sent">
        <dt>Provider and model</dt>
        <dd className="ag-mono">
          {provider}, {p.route.model}
        </dd>
        <dt>Images</dt>
        <dd>{imagesText(p.content.images.length, total)} in all</dd>
        <dt>Estimated cost</dt>
        <dd className={p.estimateUsd === undefined && !local ? 'ag-ev-cost unknown' : 'ag-ev-cost'}>
          {costText(p.estimateUsd, local)}
        </dd>
        <dt>Request text</dt>
        <dd>
          <pre>{p.content.text}</pre>
        </dd>
      </dl>

      {GROUPS.map((g) => {
        const images = byNeed(g.need);
        if (images.length === 0) return null;
        const allowed = p.flags[g.need];
        return (
          <section
            key={g.need}
            className="ag-ev-group"
            data-need={g.need}
            aria-labelledby={`eng-ev-${g.need}`}
          >
            <div className="ag-ev-head">
              <b id={`eng-ev-${g.need}`}>{g.title}</b>
              <span className="ag-faint">
                {imagesText(
                  images.length,
                  images.reduce((n, im) => n + im.bytes, 0),
                )}
              </span>
              {!local &&
                (allowed ? (
                  <span className="ag-ev-ok">Allowed for this project</span>
                ) : (
                  <button
                    type="button"
                    className="ag-btn sm"
                    onClick={() => {
                      p.onAllowProject(g.need);
                    }}
                  >
                    Allow for this project
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
                      <span>{KIND_LABELS[im.kind]}</span>
                      <span>
                        {String(im.width)} x {String(im.height)}, {formatBytes(im.bytes)}
                      </span>
                      {im.resized && <span>made smaller</span>}
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ul>
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
                {g.once}
              </label>
            )}
          </section>
        );
      })}

      {left.length > 0 && (
        <p className="ag-faint">
          Not sent: {String(left.length)} {left.length === 1 ? 'image' : 'images'} over this
          model&apos;s limit ({left.join(', ')}).
        </p>
      )}
      {!local && p.estimateUsd === undefined && (
        <label className="ag-check">
          <input
            type="checkbox"
            checked={costConfirmed}
            onChange={(e) => {
              setCostConfirmed(e.target.checked);
            }}
          />
          Send without a cost estimate
        </label>
      )}
    </SendDialog>
  );
}
