import type { AntennaStatus, AntennaUnit, AntennaUserFields, AntennaValue } from '@aio/schema';
import { Button, Tip, t } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useState, type ReactElement, type ReactNode } from 'react';
import { azimuthLines, formatDeg, qualityTip } from './antennaFormat';

export interface AntennaDetailsProps {
  unit: AntennaUnit;
  projectId: string;
  readOnly: boolean;
  aiProvider?: string;
  onSetStatus: (status: AntennaStatus) => void;
  onPatchUser: (fields: AntennaUserFields) => void;
  onOpenPhoto: (layer: string, photoId: string) => void;
}

const metres = (v: number): string => `${v.toFixed(2)} m`;

/** A value with its basis and a quality tip; a missing value reads "Not measured". */
function ValueText({
  v,
  format,
  text,
}: {
  v: AntennaValue | undefined;
  format: (n: number) => string;
  text?: string;
}): ReactElement {
  if (!v) return <span>{t('telecom.antennas.notMeasured')}</span>;
  return (
    <Tip content={qualityTip(v)}>
      <span tabIndex={0}>
        <span className="mono">{text ?? format(v.value)}</span>{' '}
        <small>{t(`telecom.antennas.basis.${v.basis}`)}</small>
      </span>
    </Tip>
  );
}

function Entry({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
      <dt>{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

/** The weight in kg when `text` is a number from 0 to 500, else null. */
function parseWeight(text: string): number | null {
  if (!/^\s*\d+(\.\d+)?\s*$/.test(text)) return null;
  const n = Number(text);
  return n <= 500 ? n : null;
}

/** One unit's values, the fields a person types, its photos and the status buttons. */
export function AntennaDetails(props: AntennaDetailsProps): ReactElement {
  const { unit, readOnly } = props;
  const [model, setModel] = useState(unit.user.model ?? '');
  const [freq, setFreq] = useState(unit.user.frequencies ?? '');
  const [weight, setWeight] = useState(
    unit.user.weightKg === undefined ? '' : String(unit.user.weightKg),
  );
  const [weightBad, setWeightBad] = useState(false);
  // A different unit starts from its own saved values, never the previous unit's text.
  const [seenId, setSeenId] = useState(unit.id);
  if (seenId !== unit.id) {
    setSeenId(unit.id);
    setModel(unit.user.model ?? '');
    setFreq(unit.user.frequencies ?? '');
    setWeight(unit.user.weightKg === undefined ? '' : String(unit.user.weightKg));
    setWeightBad(false);
  }
  const az = azimuthLines(unit);
  const provider = props.aiProvider ?? unit.ai?.provider ?? '';
  const c = unit.box.centre;

  const commitWeight = (): void => {
    if (weight.trim() === '') {
      setWeightBad(false);
      return;
    }
    const n = parseWeight(weight);
    setWeightBad(n === null);
    if (n !== null && n !== unit.user.weightKg) props.onPatchUser({ weightKg: n });
  };

  return (
    <section style={{ display: 'grid', gap: 'var(--sp-5)' }}>
      <h3 style={{ margin: 0, fontSize: 'var(--t-title)' }}>{unit.name}</h3>
      <dl style={{ margin: 0, display: 'grid', gap: 'var(--sp-4)' }}>
        <Entry label={t('telecom.antennas.value.type')}>
          {t(`telecom.antennas.kind.${unit.kind}`)}
          <br />
          <small>{t(`telecom.antennas.kindBasis.${unit.kindBasis}`, { provider })}</small>
        </Entry>
        {az ? (
          <Entry label={t('telecom.antennas.value.azimuth')}>
            <ValueText v={unit.azimuthGridDeg} format={() => az.primary} text={az.primary} />
            {az.secondary ? (
              <>
                <br />
                <small className="mono">{az.secondary}</small>
              </>
            ) : null}
          </Entry>
        ) : null}
        {unit.kind === 'panel' || unit.kind === 'short' ? (
          <>
            <Entry label={t('telecom.antennas.value.downtilt')}>
              <ValueText v={unit.downtiltDeg} format={(n) => formatDeg(n)} />
              <br />
              <small>{t('telecom.antennas.mechanical')}</small>
            </Entry>
            <Entry label={t('telecom.antennas.value.plumb')}>
              <ValueText v={unit.plumbDeg} format={(n) => formatDeg(n, true)} />
            </Entry>
          </>
        ) : null}
        {unit.kind === 'dish' ? (
          <>
            <Entry label={t('telecom.antennas.value.elevation')}>
              <ValueText v={unit.elevationDeg} format={(n) => formatDeg(n, true)} />
            </Entry>
            <Entry label={t('telecom.antennas.value.diameter')}>
              <ValueText v={unit.diameterM} format={metres} />
            </Entry>
          </>
        ) : null}
        <Entry label={t('telecom.antennas.value.width')}>
          <ValueText v={unit.widthM} format={metres} />
        </Entry>
        <Entry label={t('telecom.antennas.value.height')}>
          <ValueText v={unit.heightM} format={metres} />
        </Entry>
        <Entry label={t('telecom.antennas.value.depth')}>
          <ValueText v={unit.depthM} format={metres} />
        </Entry>
        <Entry label={t('telecom.antennas.value.altitude')}>
          <span className="mono">{metres(c[2])}</span>
        </Entry>
        <Entry label={t('telecom.antennas.value.coordinates')}>
          <span className="mono">
            {c[0].toFixed(2)}, {c[1].toFixed(2)}
          </span>
        </Entry>
      </dl>

      <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        <label style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          {t('telecom.antennas.field.model')}
          <input
            type="text"
            value={model}
            disabled={readOnly}
            maxLength={120}
            onChange={(e) => {
              setModel(e.target.value);
            }}
            onBlur={() => {
              if (model !== (unit.user.model ?? '')) props.onPatchUser({ model });
            }}
          />
        </label>
        <label style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          {t('telecom.antennas.field.weight')}
          <input
            type="text"
            inputMode="decimal"
            value={weight}
            disabled={readOnly}
            aria-invalid={weightBad ? true : undefined}
            aria-describedby={weightBad ? 'antenna-weight-err' : undefined}
            onChange={(e) => {
              setWeight(e.target.value);
            }}
            onBlur={commitWeight}
          />
          {weightBad ? (
            <small id="antenna-weight-err" role="alert">
              {t('telecom.antennas.field.weight.invalid')}
            </small>
          ) : null}
        </label>
        <label style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          {t('telecom.antennas.field.frequencies')}
          <input
            type="text"
            value={freq}
            disabled={readOnly}
            maxLength={200}
            onChange={(e) => {
              setFreq(e.target.value);
            }}
            onBlur={() => {
              if (freq !== (unit.user.frequencies ?? '')) props.onPatchUser({ frequencies: freq });
            }}
          />
        </label>
        <label style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={unit.user.active === true}
            disabled={readOnly}
            onChange={(e) => {
              props.onPatchUser({ active: e.target.checked });
            }}
          />
          {t('telecom.antennas.field.active')}
        </label>
      </div>

      <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
        <h4 style={{ margin: 0, fontSize: 'var(--t-title)' }}>{t('telecom.antennas.photos')}</h4>
        {unit.crop ? (
          <img
            src={assetUrl(props.projectId, { path: unit.crop })}
            alt=""
            data-testid="antenna-crop"
            style={{ maxWidth: '100%' }}
          />
        ) : null}
        {unit.photos.length === 0 ? (
          <p style={{ margin: 0 }}>{t('telecom.antennas.photos.none')}</p>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
            {unit.photos.map((p, i) => (
              <Button
                key={`${p.layer}/${p.id}`}
                data-testid="antenna-photo"
                onClick={() => {
                  props.onOpenPhoto(p.layer, p.id);
                }}
              >
                {t('telecom.antennas.photo.open', { n: i + 1 })}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
        <Button
          data-testid="antenna-accept"
          pressed={unit.status === 'accepted'}
          {...(readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {})}
          onClick={() => {
            props.onSetStatus('accepted');
          }}
        >
          {t('telecom.antennas.accept')}
        </Button>
        <Button
          data-testid="antenna-reject"
          pressed={unit.status === 'rejected'}
          {...(readOnly ? { disabledReason: t('telecom.antennas.readOnly') } : {})}
          onClick={() => {
            props.onSetStatus('rejected');
          }}
        >
          {t('telecom.antennas.reject')}
        </Button>
      </div>
    </section>
  );
}
