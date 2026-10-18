import type { Assembly, ParamQuality, ScaleRecord } from '@aio/schema';
import { Icon, useT, type MessageKey } from '@aio/ui';
import { useRef, useState } from 'react';
import { assemblyFields, kindLabel, type AssemblyField } from './assemblyEdit';

/**
 * What is known about one component and how: each value with the basis it rests on (Measured,
 * Observed, Inferred, Entered by you), how well a measurement fits and how much of the component was
 * seen, in words and never as a percentage; the evidence it came from with thumbnails; the
 * surfaces nobody saw; and, for a model without a measured scale, the provisional size. Editing a
 * value hands it to the host, which rebuilds through the assembler. Presentational.
 */
export interface ComponentEvidence {
  /** Thumbnail URLs by evidence reference (`img-photo-ab12cd34ef56`, a cloud layer id). */
  thumbnails: Readonly<Record<string, string>>;
  scale?: ScaleRecord;
}

export interface ComponentCardProps {
  assembly: Assembly;
  evidence: ComponentEvidence;
  locked?: boolean;
  onField: (key: string, value: number | string | boolean) => void;
  /** Bring the component into view. */
  onFocus: () => void;
}

/** How a measured value fits its points, in words. Never a confidence figure. */
export function residualWords(
  t: (k: MessageKey, v?: Record<string, string | number>) => string,
  q: ParamQuality,
): string | null {
  if (q.basis !== 'measured' || q.residualM === undefined) return null;
  const cm = q.residualM * 100;
  return cm < 1 ? t('review.residualTight') : t('review.residual', { cm: Math.round(cm) });
}

/** How much of a component was seen, in words. */
export function coverageWords(
  t: (k: MessageKey, v?: Record<string, string | number>) => string,
  q: ParamQuality,
): string | null {
  if (q.coverage === undefined) return null;
  if (q.coverage >= 0.85) return t('review.coverage.all');
  if (q.coverage >= 0.6) return t('review.coverage.most');
  if (q.coverage >= 0.3) return t('review.coverage.some');
  return t('review.coverage.little');
}

function Editor({
  f,
  disabled,
  onCommit,
}: {
  f: AssemblyField;
  disabled: boolean;
  onCommit: (v: number | string | boolean) => void;
}) {
  const shown = typeof f.value === 'number' ? String(Math.round(f.value * 1000) / 1000) : '';
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  if (typeof f.value === 'boolean')
    return (
      <input
        type="checkbox"
        checked={f.value}
        disabled={disabled}
        aria-label={f.label}
        onChange={(e) => {
          onCommit(e.target.checked);
        }}
      />
    );
  if (f.options)
    return (
      <select
        value={String(f.value)}
        disabled={disabled}
        aria-label={f.label}
        onChange={(e) => {
          onCommit(e.target.value);
        }}
      >
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  if (typeof f.value === 'string')
    return (
      <input
        type="text"
        defaultValue={f.value}
        disabled={disabled}
        aria-label={f.label}
        onBlur={(e) => {
          if (e.target.value !== f.value) onCommit(e.target.value);
        }}
      />
    );
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    const ok =
      text.trim() !== '' &&
      Number.isFinite(v) &&
      (f.min === undefined || v >= f.min) &&
      (f.max === undefined || v <= f.max) &&
      (!f.integer || Number.isInteger(v));
    setBad(!ok);
    if (ok && v !== f.value) onCommit(v);
    else if (!ok) return;
    else setText(shown);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      aria-label={f.unit ? `${f.label} (${f.unit === 'deg' ? '°' : f.unit})` : f.label}
      aria-invalid={bad || undefined}
      onChange={(e) => {
        setText(e.target.value);
        setBad(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

export function ComponentCard(p: ComponentCardProps) {
  const t = useT();
  const a = p.assembly;
  const fields = assemblyFields(a);
  const locked = p.locked === true;
  const scale = p.evidence.scale;
  const imageDialog = useRef<HTMLDialogElement>(null);
  const [fullImage, setFullImage] = useState<{ src: string; alt: string } | null>(null);
  const vectors = Object.entries(a.params).filter(
    ([k, v]) =>
      (k === 'size' || k === 'centre') &&
      Array.isArray(v) &&
      v.length === 3 &&
      v.every((n: unknown) => typeof n === 'number'),
  );
  return (
    <div className="mb-cmp-card" data-testid="component-card" data-component={a.id}>
      <div className="mb-cmp-head">
        <h3>
          {kindLabel(a.kind)} <span>{a.name}</span>
        </h3>
        <span className={`mb-st ${a.status}`}>{t(`review.status.${a.status}` as MessageKey)}</span>
        <button type="button" className="btn ghost sm" onClick={p.onFocus}>
          <Icon name="crosshair" size={12} /> {t('review.focus')}
        </button>
      </div>
      {a.description !== '' && <p className="mb-hint">{a.description}</p>}

      {scale && scale.status !== 'measured' ? (
        <p className="mb-cmp-scale" role="note" data-scale={scale.status}>
          {scale.status === 'provisional'
            ? t('review.scale.provisional')
            : t('review.scale.reference')}
        </p>
      ) : scale ? (
        <p className="mb-hint">{t('review.scale.measured')}</p>
      ) : null}

      <h4>{t('review.values')}</h4>
      <dl className="mb-cmp-values">
        {vectors.map(([key, value]) => (
          <div key={key} className="mb-cmp-value" data-field={key}>
            <dt>{t(key === 'size' ? 'review.dimensions' : 'review.position')}</dt>
            <dd>
              <output>{(value as number[]).map((n) => n.toFixed(3)).join(' / ')}</output>
              <span className="mb-cmp-basis">
                {t(`review.basis.${a.quality[key]?.basis ?? 'inferred'}` as MessageKey)}
              </span>
            </dd>
          </div>
        ))}
        {fields.map((f) => {
          const q = a.quality[f.key];
          const fit = q ? residualWords(t, q) : null;
          const seen = q ? coverageWords(t, q) : null;
          return (
            <div
              key={`${a.id}:${f.key}:${String(f.value)}`}
              className="mb-cmp-value"
              data-field={f.key}
            >
              <dt>{f.label}</dt>
              <dd>
                <Editor
                  f={f}
                  disabled={locked || f.readOnly === true}
                  onCommit={(v) => {
                    p.onField(f.key, v);
                  }}
                />
                {f.unit && <em>{f.unit === 'deg' ? '°' : f.unit}</em>}
                <span className={`mb-cmp-basis ${f.basis}`} data-basis={f.basis}>
                  {t(`review.basis.${f.basis}` as MessageKey)}
                </span>
                {(fit ?? seen) && (
                  <small className="mb-cmp-q">{[fit, seen].filter(Boolean).join('. ')}</small>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      {a.unobserved && a.unobserved.length > 0 && (
        <p className="mb-cmp-unseen">
          {t('review.unobserved', {
            surfaces: a.unobserved.map((s) => t(`review.surface.${s}` as MessageKey)).join(', '),
          })}
        </p>
      )}

      <h4>{t('review.sources')}</h4>
      {a.sources.length === 0 ? (
        <p className="mb-hint">{t('review.noSources')}</p>
      ) : (
        <ul className="mb-cmp-sources">
          {a.sources.map((s, i) => {
            const thumb = p.evidence.thumbnails[s.ref];
            return (
              <li key={`${s.kind}:${s.ref}:${String(i)}`}>
                {thumb ? (
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={t('review.enlarge')}
                    onClick={() => {
                      setFullImage({
                        src: thumb,
                        alt: `${t(`review.source.${s.kind}` as MessageKey)} ${s.view ?? s.ref}`,
                      });
                      imageDialog.current?.showModal();
                    }}
                  >
                    <img
                      src={thumb}
                      alt={`${t(`review.source.${s.kind}` as MessageKey)} ${s.view ?? s.ref}`}
                      width={56}
                      height={42}
                    />
                  </button>
                ) : (
                  <span className="mb-cmp-nothumb" aria-hidden="true" />
                )}
                <span>
                  <b>{t(`review.source.${s.kind}` as MessageKey)}</b>
                  <small>{s.view ?? s.ref}</small>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <dialog
        ref={imageDialog}
        className="mb-evidence-dialog"
        aria-label={t('review.enlarge')}
        onKeyDown={(e) => {
          e.stopPropagation();
        }}
      >
        <button type="button" className="btn" onClick={() => imageDialog.current?.close()}>
          {t('review.closeImage')}
        </button>
        {fullImage && (
          <img
            src={fullImage.src}
            alt={fullImage.alt}
            style={{ display: 'block', maxWidth: '85vw', maxHeight: '80vh', objectFit: 'contain' }}
          />
        )}
      </dialog>
    </div>
  );
}
