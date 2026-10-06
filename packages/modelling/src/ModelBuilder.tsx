import type { PartStatus, ProcModel, ProcModelSummary, ProcPart } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { partNodeName } from './mesher';
import { partDimensions, partSummary, type DimensionKey } from './procmodel';

/**
 * The Model builder panel (BLD-11): the parts of a procedural model with their status and origin,
 * accept or reject one or all (keyboard: arrows move, A accepts, R rejects, D makes a draft again,
 * Shift+A accepts all), numeric editing of the selected part, and the ways parts come in (from an
 * imported drawing, from a point cloud fit). Presentational: the host app passes state and actions.
 */
export interface ModelBuilderProps {
  model: ProcModel | null;
  models: readonly ProcModelSummary[];
  readOnly: boolean;
  selected: string | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  drawings: readonly { stem: string; name: string }[];
  clouds: readonly { id: string; name: string }[];
  cloudDrawings: boolean;
  /** Extra content under the sources (the place-by-points tool). */
  children?: ReactNode;
  onClose: () => void;
  onSelect: (partId: string | null) => void;
  onOpenModel: (id: string) => void;
  onStatus: (ids: readonly string[] | 'all', status: PartStatus) => void;
  onDimension: (partId: string, key: DimensionKey, value: number) => void;
  onText: (partId: string, key: 'tag' | 'name', value: string) => void;
  onImport: () => void;
  onPlace: (stem: string) => void;
  onFromDrawing: (stem: string) => void;
  onFromCloud: (layerId: string) => void;
  onPreview: () => void;
  onBuild: () => void;
  onCloudDrawings: (allow: boolean) => void;
  onDismiss: () => void;
}

const KIND_LABEL: Record<ProcPart['kind'], string> = {
  cylinder: 'Cylinder',
  box: 'Box',
  extrusion: 'Extrusion',
  pipe: 'Pipe',
  sphere: 'Sphere',
};

const ORIGIN_LABEL: Record<ProcPart['origin']['by'], string> = {
  drawing: 'From drawing',
  fit: 'Fitted',
  agent: 'From the agent',
  manual: 'By hand',
};

/** Fit quality from the RMS residual: good up to 2 cm, fair up to 5 cm, else poor. */
export function fitQuality(
  part: ProcPart,
): { label: string; tone: 'good' | 'fair' | 'poor' } | null {
  if (part.origin.by !== 'fit') return null;
  const cm = part.origin.residualM * 100;
  const tone = cm <= 2 ? 'good' : cm <= 5 ? 'fair' : 'poor';
  return { label: `${cm.toFixed(1)} cm`, tone };
}

function originText(p: ProcPart): string {
  const q = fitQuality(p);
  if (q) return `${ORIGIN_LABEL.fit}, ${q.label} off`;
  if (p.origin.by === 'drawing' && p.origin.layer)
    return `${ORIGIN_LABEL.drawing}, ${p.origin.layer}`;
  return ORIGIN_LABEL[p.origin.by];
}

function NumberField({
  label,
  unit,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  unit: string;
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(Math.round(value * 1000) / 1000));
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (text.trim() !== '' && Number.isFinite(v) && v !== value) onCommit(v);
    else setText(String(Math.round(value * 1000) / 1000));
  };
  return (
    <label className="mb-field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-label={`${label} (${unit})`}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <em>{unit}</em>
    </label>
  );
}

function TextField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim());
  };
  return (
    <label className="mb-field">
      <span>{label}</span>
      <input
        type="text"
        value={text}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

export function ModelBuilder(p: ModelBuilderProps) {
  const parts = p.model?.parts ?? [];
  const selected = parts.find((x) => x.id === p.selected) ?? null;
  const listRef = useRef<HTMLUListElement>(null);
  const [drawing, setDrawing] = useState('');
  const [cloud, setCloud] = useState('');
  const locked = p.readOnly || p.busy !== null;
  const accepted = parts.filter((x) => x.status === 'accepted').length;
  const drafts = parts.filter((x) => x.status === 'draft').length;
  const drawingStem = (drawing !== '' ? drawing : p.drawings[0]?.stem) ?? '';
  const cloudId = (cloud !== '' ? cloud : p.clouds[0]?.id) ?? '';

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (parts.length === 0) return;
    const i = parts.findIndex((x) => x.id === p.selected);
    const key = e.key.toLowerCase();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(parts.length - 1, i + 1) : Math.max(0, i - 1);
      p.onSelect(parts[next]?.id ?? null);
      return;
    }
    if (locked) return;
    if (key === 'a' && e.shiftKey) {
      e.preventDefault();
      p.onStatus('all', 'accepted');
    } else if (selected && (key === 'a' || key === 'r' || key === 'd')) {
      e.preventDefault();
      p.onStatus([selected.id], key === 'a' ? 'accepted' : key === 'r' ? 'rejected' : 'draft');
    }
  };

  return (
    <section className="mb" aria-label="Model builder" data-testid="model-builder">
      <header role="none">
        <Icon name="plant" size={14} />
        <b>Model builder</b>
        {p.models.length > 1 && p.model && (
          <select
            aria-label="Model"
            value={p.model.id}
            onChange={(e) => {
              p.onOpenModel(e.target.value);
            }}
          >
            {p.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn ghost sm" onClick={p.onClose}>
          Close
        </button>
      </header>

      {[p.busy, p.error, p.notice].some(Boolean) && (
        <div
          className={`mb-say${p.error ? ' bad' : ''}`}
          role={p.error ? 'alert' : 'status'}
          data-testid="model-builder-say"
        >
          <span>{p.busy ? `${p.busy}...` : (p.error ?? p.notice)}</span>
          {!p.busy && (
            <button type="button" className="btn ghost sm" onClick={p.onDismiss}>
              OK
            </button>
          )}
        </div>
      )}
      {p.readOnly && (
        <div className="mb-say">
          This project is a read-only package: models can be looked at only.
        </div>
      )}

      <div className="mb-scroll">
        <div className="mb-sec">
          <h3>Parts come from</h3>
          <div className="mb-row">
            <button type="button" className="btn sm" disabled={locked} onClick={p.onImport}>
              <Icon name="import" size={12} /> Import drawing (DXF)
            </button>
          </div>
          {p.drawings.length > 0 && (
            <div className="mb-row">
              <select
                aria-label="Drawing"
                value={drawingStem}
                onChange={(e) => {
                  setDrawing(e.target.value);
                }}
              >
                {p.drawings.map((d) => (
                  <option key={d.stem} value={d.stem}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn sm"
                disabled={locked}
                onClick={() => {
                  p.onFromDrawing(drawingStem);
                }}
              >
                From drawing
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={locked}
                onClick={() => {
                  p.onPlace(drawingStem);
                }}
              >
                Place by points
              </button>
            </div>
          )}
          {p.clouds.length > 0 && (
            <div className="mb-row">
              <select
                aria-label="Point cloud"
                value={cloudId}
                onChange={(e) => {
                  setCloud(e.target.value);
                }}
              >
                {p.clouds.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn sm"
                disabled={locked}
                onClick={() => {
                  p.onFromCloud(cloudId);
                }}
              >
                From point cloud
              </button>
            </div>
          )}
          {p.children}
        </div>

        <div className="mb-sec">
          <h3>
            Parts{' '}
            <span className="mb-count">
              {parts.length ? `${String(accepted)} accepted, ${String(drafts)} drafts` : ''}
            </span>
          </h3>
          {parts.length === 0 ? (
            <p className="mb-hint">
              No parts yet. Import a drawing, then add its parts, or fit parts to a point cloud.
            </p>
          ) : (
            <>
              <div className="mb-row">
                <button
                  type="button"
                  className="btn sm"
                  disabled={locked || drafts === 0}
                  onClick={() => {
                    p.onStatus(
                      parts.filter((x) => x.status === 'draft').map((x) => x.id),
                      'accepted',
                    );
                  }}
                >
                  Accept all drafts
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={locked || drafts === 0}
                  onClick={() => {
                    p.onStatus(
                      parts.filter((x) => x.status === 'draft').map((x) => x.id),
                      'rejected',
                    );
                  }}
                >
                  Reject all drafts
                </button>
              </div>
              <ul
                ref={listRef}
                className="mb-parts"
                role="listbox"
                aria-label="Parts. A accepts, R rejects, D makes a draft, Shift+A accepts all"
                tabIndex={0}
                onKeyDown={onKey}
              >
                {parts.map((x) => {
                  const q = fitQuality(x);
                  return (
                    <li
                      key={x.id}
                      role="option"
                      aria-selected={x.id === p.selected}
                      data-status={x.status}
                      data-part={x.id}
                      onClick={() => {
                        p.onSelect(x.id);
                        listRef.current?.focus();
                      }}
                    >
                      <span className={`mb-st ${x.status}`}>{x.status}</span>
                      <span className="mb-name">
                        <b>{partNodeName(x)}</b>
                        <small>
                          {partSummary(x)}
                          {x.confidence !== undefined
                            ? `, ${String(Math.round(x.confidence * 100))}% sure`
                            : ''}
                        </small>
                        <small>{originText(x)}</small>
                      </span>
                      {q && <span className={`mb-q ${q.tone}`} title="Fit residual" />}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {selected && (
          <div className="mb-sec" aria-label={`Edit ${partNodeName(selected)}`}>
            <h3>
              {KIND_LABEL[selected.kind]} {partNodeName(selected)}
            </h3>
            {/* the selected part's review (an option of the list holds no buttons of its own) */}
            {!p.readOnly && (
              <div className="mb-row mb-acts">
                {(
                  [
                    ['accepted', 'Accept'],
                    ['rejected', 'Reject'],
                    ['draft', 'Make draft'],
                  ] as const
                ).map(([status, label]) => (
                  <button
                    key={status}
                    type="button"
                    className="btn ghost sm"
                    aria-label={`${label} ${partNodeName(selected)}`}
                    disabled={locked || selected.status === status}
                    onClick={() => {
                      p.onStatus([selected.id], status);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="mb-grid">
              <TextField
                key={`tag:${selected.id}:${selected.tag ?? ''}`}
                label="Tag"
                value={selected.tag ?? ''}
                disabled={locked}
                onCommit={(v) => {
                  p.onText(selected.id, 'tag', v);
                }}
              />
              <TextField
                key={`name:${selected.id}:${selected.name ?? ''}`}
                label="Name"
                value={selected.name ?? ''}
                disabled={locked}
                onCommit={(v) => {
                  p.onText(selected.id, 'name', v);
                }}
              />
              {partDimensions(selected).map((d) => (
                <NumberField
                  key={`${selected.id}:${d.key}:${String(d.value)}`}
                  label={d.label}
                  unit={d.unit}
                  value={d.value}
                  disabled={locked}
                  onCommit={(v) => {
                    p.onDimension(selected.id, d.key, v);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div className="mb-sec">
          <label className="mb-check">
            <input
              type="checkbox"
              checked={p.cloudDrawings}
              disabled={p.readOnly}
              onChange={(e) => {
                p.onCloudDrawings(e.target.checked);
              }}
            />
            <span>
              Allow cloud AI for drawings
              <small>
                Off: the agent keeps plan images and drawings on this computer. A local model always
                can read them.
              </small>
            </span>
          </label>
        </div>
      </div>

      <footer className="mb-foot">
        <button
          type="button"
          className="btn ghost sm"
          disabled={locked || parts.every((x) => x.status === 'rejected')}
          onClick={p.onPreview}
        >
          Preview drafts
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={locked || accepted === 0}
          onClick={p.onBuild}
        >
          Build model
        </button>
      </footer>
    </section>
  );
}
