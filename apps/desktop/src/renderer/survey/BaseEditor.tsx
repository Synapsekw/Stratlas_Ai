/**
 * The custom base editor (M11 G4, PRD SRV-2): a TIN of the polygon's vertices with heights a person
 * edits. Each vertex has an absolute elevation or an offset from the surface side at that vertex
 * (never both, data-conventions section 26). Rows are selected by click, a range with Shift; the
 * selection moves up or down together or is set to one level. Values show in the measurement's
 * distance unit and are stored in metres.
 */
import { fromSI, toSI, unitLabel } from '@aio/geo';
import type { BaseSpec, CustomBaseVertex, SurveyMeasurement } from '@aio/schema';
import { customBase, effectiveUnits } from '@aio/survey';
import { useState } from 'react';
import { useMeasure } from './measureStore';

type Custom = Extract<BaseSpec, { kind: 'custom' }>;

const MAX_ROWS = 200;

/** Move the chosen vertices by `dz` metres (an offset moves its offset, a level its level). */
export function moveVertices(base: Custom, which: ReadonlySet<number>, dz: number): Custom {
  return {
    ...base,
    vertices: base.vertices.map((v, k) => {
      if (!which.has(k)) return v;
      return v.z !== undefined
        ? { e: v.e, n: v.n, z: v.z + dz }
        : { e: v.e, n: v.n, offsetM: (v.offsetM ?? 0) + dz };
    }),
  };
}

/** Set the chosen vertices to one absolute level, metres. */
export function levelVertices(base: Custom, which: ReadonlySet<number>, z: number): Custom {
  return {
    ...base,
    vertices: base.vertices.map((v, k) => (which.has(k) ? { e: v.e, n: v.n, z } : v)),
  };
}

/** One vertex as an offset from the surface (0) or as an absolute level (the vertex's own Z). */
function toggleMode(v: CustomBaseVertex, pointZ: number): CustomBaseVertex {
  return v.z !== undefined ? { e: v.e, n: v.n, offsetM: 0 } : { e: v.e, n: v.n, z: pointZ };
}

export function BaseEditor({
  m,
  base,
  disabled,
  onChange,
}: {
  m: SurveyMeasurement;
  base: Custom;
  disabled: boolean;
  onChange: (next: BaseSpec) => void;
}) {
  const settings = useMeasure((s) => s.settings);
  const unit = effectiveUnits(settings.units, m.units).distance;
  const dec = settings.precision.distance;
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [moveBy, setMoveBy] = useState('');
  const [level, setLevel] = useState('');
  const show = (x: number) => fromSI(x, 'distance', unit).toFixed(dec);
  const read = (t: string): number | null => {
    const v = Number(t);
    return t.trim() !== '' && Number.isFinite(v) ? toSI(v, 'distance', unit) : null;
  };
  const mismatch = base.vertices.length !== m.points.length;
  const click = (k: number, shift: boolean) => {
    const next = new Set(shift ? sel : []);
    if (shift && anchor !== null) {
      const [a, b] = anchor < k ? [anchor, k] : [k, anchor];
      for (let i = a; i <= b; i++) next.add(i);
    } else if (sel.has(k) && sel.size === 1) next.delete(k);
    else next.add(k);
    setSel(next);
    setAnchor(k);
  };
  const setVertex = (k: number, v: CustomBaseVertex) => {
    onChange({ ...base, vertices: base.vertices.map((x, i) => (i === k ? v : x)) });
  };
  const which = sel.size > 0 ? sel : new Set(base.vertices.map((_, k) => k));
  const scope = sel.size > 0 ? `${String(sel.size)} selected` : 'all';
  return (
    <fieldset className="sv-sub sv-base" disabled={disabled} data-testid="survey-base-editor">
      <legend>Custom base vertices</legend>
      {mismatch && (
        <p className="notice warn small" role="note">
          The polygon has {m.points.length} vertices and the base {base.vertices.length}.{' '}
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              onChange(customBase(m.points));
              setSel(new Set());
            }}
          >
            Use the polygon's vertices
          </button>
        </p>
      )}
      <p className="small faint">
        Click a vertex number to select it, Shift+click for a range. A vertex holds an elevation or
        an offset from the surface under it.
      </p>
      <div className="sv-scroll sv-base-rows">
        <table className="sv-verts">
          <caption className="sr-only">Custom base vertices</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{settings.order === 'ENZ' ? 'E' : 'N'}</th>
              <th scope="col">{settings.order === 'ENZ' ? 'N' : 'E'}</th>
              <th scope="col">Height</th>
              <th scope="col">Value ({unitLabel(unit)})</th>
            </tr>
          </thead>
          <tbody>
            {base.vertices.slice(0, MAX_ROWS).map((v, k) => {
              const on = sel.has(k);
              return (
                <tr
                  key={k}
                  aria-selected={on}
                  className={on ? 'on' : undefined}
                  data-testid="survey-base-row"
                >
                  <td>
                    <button
                      type="button"
                      className="btn ghost sm mono"
                      aria-pressed={on}
                      aria-label={`Select vertex ${String(k + 1)}`}
                      onClick={(e) => {
                        click(k, e.shiftKey);
                      }}
                    >
                      {k + 1}
                    </button>
                  </td>
                  <td className="mono">{show(settings.order === 'ENZ' ? v.e : v.n)}</td>
                  <td className="mono">{show(settings.order === 'ENZ' ? v.n : v.e)}</td>
                  <td>
                    <select
                      className="sv-input"
                      aria-label={`Vertex ${String(k + 1)} height kind`}
                      value={v.z !== undefined ? 'z' : 'offset'}
                      onChange={() => {
                        setVertex(k, toggleMode(v, m.points[k]?.[2] ?? 0));
                      }}
                    >
                      <option value="z">Level</option>
                      <option value="offset">Offset</option>
                    </select>
                  </td>
                  <td>
                    <VertexValue
                      key={`${String(k)}-${String(v.z ?? v.offsetM ?? 0)}`}
                      label={`Vertex ${String(k + 1)} ${v.z !== undefined ? 'elevation' : 'offset'}`}
                      value={v.z ?? v.offsetM ?? 0}
                      show={show}
                      read={read}
                      onCommit={(x) => {
                        setVertex(
                          k,
                          v.z !== undefined
                            ? { e: v.e, n: v.n, z: x }
                            : { e: v.e, n: v.n, offsetM: x },
                        );
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sv-row sv-wrap">
        <label className="sv-field sv-inline">
          <span>Move {scope} by</span>
          <input
            className="sv-input mono"
            type="number"
            step="0.01"
            value={moveBy}
            aria-label={`Move ${scope} vertices by (${unitLabel(unit)})`}
            data-testid="survey-base-move"
            onChange={(e) => {
              setMoveBy(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="btn sm"
          disabled={read(moveBy) === null}
          data-testid="survey-base-move-apply"
          onClick={() => {
            const dz = read(moveBy);
            if (dz !== null) onChange(moveVertices(base, which, dz));
            setMoveBy('');
          }}
        >
          Move
        </button>
        <label className="sv-field sv-inline">
          <span>Set {scope} to level</span>
          <input
            className="sv-input mono"
            type="number"
            step="0.01"
            value={level}
            aria-label={`Set ${scope} vertices to the level (${unitLabel(unit)})`}
            data-testid="survey-base-level"
            onChange={(e) => {
              setLevel(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="btn sm"
          disabled={read(level) === null}
          data-testid="survey-base-level-apply"
          onClick={() => {
            const z = read(level);
            if (z !== null) onChange(levelVertices(base, which, z));
            setLevel('');
          }}
        >
          Set
        </button>
      </div>
      {base.vertices.length > MAX_ROWS && (
        <p className="small faint">
          The first {MAX_ROWS} of {base.vertices.length} vertices; Move and Set apply to all.
        </p>
      )}
    </fieldset>
  );
}

function VertexValue({
  label,
  value,
  show,
  read,
  onCommit,
}: {
  label: string;
  value: number;
  show: (x: number) => string;
  read: (t: string) => number | null;
  onCommit: (x: number) => void;
}) {
  const [text, setText] = useState(show(value));
  const commit = () => {
    const x = read(text);
    if (x !== null && Math.abs(x - value) > 1e-9) onCommit(x);
    else setText(show(value));
  };
  return (
    <input
      className="sv-input mono"
      type="number"
      step="0.001"
      aria-label={label}
      value={text}
      data-testid="survey-base-value"
      onChange={(e) => {
        setText(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}
