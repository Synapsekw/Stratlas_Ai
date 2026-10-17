import { PROVIDER_LABELS, SendDialog } from '@aio/ai';
import type { IpcResponse } from '@aio/schema';
import { Button, t } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useState, type ReactElement } from 'react';

export interface AntennaSendPreviewProps {
  preview: Extract<IpcResponse<'ai:antennaLabelPreview'>, { ok: true }>;
  projectId: string;
  onSend(photos: boolean): void;
  onCancel(): void;
}

/** The provider's display name, else the id as it came. */
const providerName = (id: string): string =>
  id in PROVIDER_LABELS ? PROVIDER_LABELS[id as keyof typeof PROVIDER_LABELS] : id;

function costText(preview: AntennaSendPreviewProps['preview']): string {
  if (!preview.cloud) return t('eng.ev.costLocal');
  const usd = preview.estimate.costUsd;
  if (usd === undefined) return t('eng.ev.costUnknown');
  if (usd < 0.01) return t('eng.ev.costUnder');
  return t('eng.ev.costAbout', { usd: usd.toFixed(2) });
}

/**
 * What an AI labelling request would send: the unit crops, the provider and the estimate. A
 * cloud request needs the photo consent: the project's, or a tick here for this request only.
 */
export function AntennaSendPreview(props: AntennaSendPreviewProps): ReactElement {
  const { preview, projectId } = props;
  const [once, setOnce] = useState(false);
  const needConsent = preview.cloud && !preview.photosAllowed;
  const count = preview.crops.length;
  const provider = providerName(preview.provider);
  return (
    <SendDialog
      standalone
      className="surface-dlg"
      titleId="antenna-send-title"
      title={t('telecom.antennas.ai.title')}
      onCancel={() => {
        props.onCancel();
      }}
      actions={
        <>
          <Button
            onClick={() => {
              props.onCancel();
            }}
          >
            {t('telecom.antennas.ai.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="antenna-send"
            {...(needConsent && !once ? { disabledReason: t('telecom.antennas.ai.photos') } : {})}
            onClick={() => {
              props.onSend(preview.photosAllowed || once);
            }}
          >
            {t('telecom.antennas.ai.send')}
          </Button>
        </>
      }
    >
      <p>{t('telecom.antennas.ai.body', { count, provider })}</p>
      <p className="mono">
        {preview.model}, {costText(preview)}
      </p>
      <ul style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-3)', padding: 0 }}>
        {preview.crops.map((c) => (
          <li key={c.unitId} style={{ listStyle: 'none' }}>
            <img
              src={assetUrl(projectId, { path: c.path })}
              alt={c.unitId}
              width={72}
              height={72}
            />
          </li>
        ))}
      </ul>
      {needConsent && (
        <label style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={once}
            onChange={(e) => {
              setOnce(e.target.checked);
            }}
          />
          {t('telecom.antennas.ai.photos')}
        </label>
      )}
    </SendDialog>
  );
}
