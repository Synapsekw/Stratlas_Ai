/**
 * The one-line yes before a cloud run (founder decision: a cloud run asks first): how many images
 * go to which provider and about what it costs, Send, Cancel and "Don't ask again for this
 * project". What is sent (the first images, the instructions and the request text exactly as
 * sent) is one click away, as the Detect dialog showed it.
 */
import { modelLabel, SEND_MAX_PX } from '@aio/ai';
import type { Layer } from '@aio/schema';
import { useT } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useEffect, useState, type ReactElement } from 'react';
import type { DetectItem } from '../../detections/convert';
import { frameLayerSrc } from '../../detections/frameMedia';
import { frameThumb } from '../../detections/prepare';
import { MediaThumb } from '../../thumbs/Thumb';
import { PREVIEW_IMAGES, type CloudConfirm as ConfirmInfo } from './backend';
import { skipCloudConfirm } from './prefs';
import './askAi.css';

/** "$0.43"; a cost under a cent reads as a cent. */
function usd(costUsd: number): string {
  return `$${Math.max(0.01, costUsd).toFixed(2)}`;
}

function FramePreview({ url, t }: { url: string; t: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    frameThumb(url, t).then(
      (s) => {
        if (live) setSrc(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, t]);
  return <div className="m-thumb">{src && <img src={src} alt="" />}</div>;
}

function videoUrl(projectId: string, layers: readonly Layer[], layerId: string): string | null {
  const src = frameLayerSrc(layers, layerId);
  try {
    return src ? assetUrl(projectId, src) : null;
  } catch {
    return null;
  }
}

function PreviewImage({
  projectId,
  layers,
  item,
}: {
  projectId: string;
  layers: readonly Layer[];
  item: DetectItem;
}) {
  if (item.kind === 'frame') {
    const url = videoUrl(projectId, layers, item.layer);
    return url ? <FramePreview url={url} t={item.t} /> : <div className="m-thumb" />;
  }
  const layer = layers.find((l) => l.id === item.layer);
  const photo = layer?.kind === 'photos' ? layer.items.find((p) => p.id === item.photo) : undefined;
  return <MediaThumb projectId={projectId} asset={photo?.src} icon="photo" />;
}

export function CloudConfirm({
  projectId,
  layers,
  confirm,
  onSend,
  onCancel,
}: {
  projectId: string;
  layers: readonly Layer[];
  /** `cloudConfirm()` for the run that Send starts. */
  confirm: ConfirmInfo;
  onSend: () => void;
  onCancel: () => void;
}): ReactElement {
  const t = useT();
  const [dontAsk, setDontAsk] = useState(false);
  const [open, setOpen] = useState(false);
  const count = confirm.photos + confirm.frames;
  const cost =
    confirm.estimate.costUsd === undefined
      ? t('det.ai.costUnknown')
      : usd(confirm.estimate.costUsd);
  return (
    <div className="ask-confirm" data-testid="cloud-confirm" role="group">
      <div className="ask-confirm-row">
        <span className="ask-confirm-line" data-testid="cloud-confirm-line">
          {t(confirm.photos === 0 ? 'askAi.cloud.confirmFrames' : 'askAi.cloud.confirm', {
            count,
            provider: confirm.providerLabel,
            cost,
          })}
        </span>
        <button
          type="button"
          className="btn link sm"
          aria-expanded={open}
          data-testid="cloud-confirm-preview-open"
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {t('askAi.cloud.preview')}
        </button>
        <span className="grow" />
        <label className="ann-check ask-confirm-skip">
          <input
            type="checkbox"
            data-testid="cloud-confirm-dont-ask"
            checked={dontAsk}
            onChange={(e) => {
              setDontAsk(e.target.checked);
            }}
          />
          {t('askAi.cloud.dontAsk')}
        </label>
        <button
          type="button"
          className="btn sm"
          data-testid="cloud-confirm-cancel"
          onClick={onCancel}
        >
          {t('askAi.cloud.cancel')}
        </button>
        <button
          type="button"
          className="btn sm primary"
          data-testid="cloud-confirm-send"
          onClick={() => {
            if (dontAsk) skipCloudConfirm(projectId);
            onSend();
          }}
        >
          {t('askAi.cloud.send')}
        </button>
      </div>
      {open && (
        <div className="ask-confirm-preview" data-testid="cloud-confirm-preview">
          <p>
            {t('det.ai.previewLead', { provider: confirm.providerLabel, size: SEND_MAX_PX })}{' '}
            <span className="mono">{modelLabel(confirm.model)}</span>
          </p>
          <div className="ask-prev-grid">
            {confirm.preview.map((it) => (
              <figure key={`${it.layer}:${it.kind === 'photo' ? it.photo : String(it.t)}`}>
                <PreviewImage projectId={projectId} layers={layers} item={it} />
                <figcaption className="mono">
                  {it.kind === 'photo' ? it.photo : `${it.t.toFixed(1)} s`}
                </figcaption>
              </figure>
            ))}
          </div>
          {count > PREVIEW_IMAGES && (
            <p className="ann-faint">{t('det.ai.more', { count: count - PREVIEW_IMAGES })}</p>
          )}
          <h3 className="caps">{t('det.ai.text')}</h3>
          <pre className="ask-pre">{confirm.instructions}</pre>
          <pre className="ask-pre">{confirm.userText}</pre>
        </div>
      )}
    </div>
  );
}
