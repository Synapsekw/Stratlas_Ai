/**
 * **Compute from point pairs** in Site settings (M11 G1 gap): a table of pairs, each a global
 * position (WGS84, or grid in the site's base projection) beside the same point's local N, E, Z,
 * with H and V per pair, typed or imported from a CSV. **Compute** hands the pairs to the
 * parent, which runs `geo.calibration` and shows the residuals and **Apply** like a JobXML.
 */
import type { CalibrationPair } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useRef, useState } from 'react';
import {
  emptyRow,
  globalColumns,
  pairsRequest,
  parsePairsCsv,
  type PairGlobal,
  type PairRow,
} from './calibrationPairs';
import './site.css';

const LOCAL_COLUMNS = ['Local N', 'Local E', 'Local Z'] as const;
const KEYS = ['a', 'b', 'c', 'localN', 'localE', 'localZ'] as const;

export function CalibrationPairsEditor({
  initial,
  busy,
  onCompute,
  onClose,
}: {
  initial: { rows: PairRow[]; kind: PairGlobal } | null;
  busy: boolean;
  onCompute: (pairs: CalibrationPair[]) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<PairGlobal>(initial?.kind ?? 'wgs84');
  const [rows, setRows] = useState<PairRow[]>(
    initial?.rows.length ? initial.rows : [emptyRow(1), emptyRow(2), emptyRow(3)],
  );
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const cols = [...globalColumns(kind), ...LOCAL_COLUMNS];

  const patch = (i: number, p: Partial<PairRow>) => {
    setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  };
  const importCsv = async (f: File) => {
    const parsed = parsePairsCsv(await f.text());
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    if (parsed.rows.length === 0) {
      setError('The file has no point pairs.');
      return;
    }
    setError(null);
    setRows(parsed.rows);
    if (parsed.kind) setKind(parsed.kind);
    setNote(
      `${String(parsed.rows.length)} pairs read from ${f.name}${parsed.kind ? '' : '. Check what the global columns hold'}.`,
    );
  };
  const compute = () => {
    const r = pairsRequest(rows, kind);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    onCompute(r.pairs);
  };

  return (
    <div className="site-pairs" data-testid="site-pairs">
      <p className="help">
        Each pair is one point measured twice: its global position and its local site coordinates.
        Clear H or V to leave a pair out of the horizontal or the vertical adjustment. A CSV has a
        name, the three global values, then local N, E, Z, and optionally H and V (1 or 0).
      </p>
      <div className="row">
        <label className="field">
          <span>Global positions</span>
          <select
            className="input"
            value={kind}
            data-testid="site-pairs-kind"
            onChange={(e) => {
              setKind(e.target.value === 'grid' ? 'grid' : 'wgs84');
            }}
          >
            <option value="wgs84">WGS84 latitude, longitude, ellipsoidal height</option>
            <option value="grid">Grid N, E, Z in the site coordinate system</option>
          </select>
        </label>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            file.current?.click();
          }}
        >
          <Icon name="import" size={12} /> Import CSV
        </button>
        <input
          ref={file}
          type="file"
          accept=".csv,.txt,text/csv"
          hidden
          aria-label="Import point pairs from a CSV file"
          data-testid="site-pairs-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importCsv(f);
          }}
        />
      </div>
      <div className="site-pairs-scroll">
        <table className="site-pairs-table" data-testid="site-pairs-table">
          <thead>
            <tr>
              <th scope="col">Point</th>
              {cols.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
              <th scope="col">H</th>
              <th scope="col">V</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input
                    className="input"
                    aria-label={`Pair ${String(i + 1)} name`}
                    value={r.name}
                    maxLength={120}
                    onChange={(e) => {
                      patch(i, { name: e.target.value });
                    }}
                  />
                </td>
                {KEYS.map((k, j) => (
                  <td key={k}>
                    <input
                      className="input mono"
                      inputMode="decimal"
                      aria-label={`${r.name || `Pair ${String(i + 1)}`} ${cols[j] ?? ''}`}
                      value={r[k]}
                      onChange={(e) => {
                        patch(i, { [k]: e.target.value });
                      }}
                    />
                  </td>
                ))}
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Use ${r.name} for the horizontal`}
                    checked={r.useH}
                    onChange={(e) => {
                      patch(i, { useH: e.target.checked });
                    }}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Use ${r.name} for the vertical`}
                    checked={r.useV}
                    onChange={(e) => {
                      patch(i, { useV: e.target.checked });
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn ghost icon sm"
                    aria-label={`Remove ${r.name}`}
                    onClick={() => {
                      setRows(rows.filter((_, k) => k !== i));
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && (
        <p className="help" role="status" data-testid="site-pairs-note">
          {note}
        </p>
      )}
      {error && (
        <p className="notice danger small" role="alert" data-testid="site-pairs-error">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn sm"
          disabled={rows.length >= 500}
          onClick={() => {
            setRows([...rows, emptyRow(rows.length + 1)]);
          }}
        >
          <Icon name="plus" size={12} /> Add a pair
        </button>
        <span className="grow" />
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={busy}
          data-testid="site-pairs-compute"
          onClick={compute}
        >
          {busy ? 'Computing…' : 'Compute'}
        </button>
      </div>
    </div>
  );
}
