/**
 * Site materials (M11 G4, PRD SRV-6, data-conventions section 27): name, ID, code, density and
 * swell factors, kept in `survey/settings.json` (`materials`, at most 500). CSV import (merged by
 * id) and export. A measurement picks one in its calculators.
 */
import type { SiteMaterial } from '@aio/schema';
import { SiteMaterial as SiteMaterialSchema } from '@aio/schema';
import {
  MAX_MATERIALS,
  materialIdFrom,
  materialsFromCsv,
  materialsToCsv,
  mergeMaterials,
} from '@aio/survey';
import { Icon, useFocusTrap } from '@aio/ui';
import { useRef, useState } from 'react';
import { bridge } from '../shell';
import { openCompareDialog } from './compareStore';
import { saveSiteSettings, useMeasure } from './measureStore';

interface Row {
  id: string;
  name: string;
  code: string;
  density: string;
  loose: string;
  compacted: string;
}

const toRow = (m: SiteMaterial): Row => ({
  id: m.id,
  name: m.name,
  code: m.code ?? '',
  density: m.densityTPerM3 === undefined ? '' : String(m.densityTPerM3),
  loose: m.swell ? String(m.swell.loose) : '',
  compacted: m.swell ? String(m.swell.compacted) : '',
});

/** The rows as materials, or the first problem (by row). */
export function rowsToMaterials(
  rows: readonly Row[],
): { materials: SiteMaterial[] } | { error: string } {
  const out: SiteMaterial[] = [];
  const ids = new Set<string>();
  for (const [k, r] of rows.entries()) {
    const n = k + 1;
    const raw: Record<string, unknown> = { id: r.id.trim(), name: r.name.trim() };
    if (r.code.trim()) raw.code = r.code.trim();
    const num = (t: string) => (t.trim() === '' ? undefined : Number(t));
    const d = num(r.density);
    const l = num(r.loose);
    const c = num(r.compacted);
    if (d !== undefined) raw.densityTPerM3 = d;
    if ((l === undefined) !== (c === undefined))
      return { error: `Row ${String(n)}: give both swell factors or neither.` };
    if (l !== undefined && c !== undefined) raw.swell = { loose: l, compacted: c };
    const p = SiteMaterialSchema.safeParse(raw);
    if (!p.success) {
      const i = p.error.issues[0];
      return {
        error: `Row ${String(n)}: ${i ? `${i.path.join('.') || 'row'} ${i.message}` : 'not a material'}`,
      };
    }
    if (ids.has(p.data.id))
      return { error: `Row ${String(n)}: the ID "${p.data.id}" is used twice.` };
    ids.add(p.data.id);
    out.push(p.data);
  }
  return { materials: out };
}

export function Materials() {
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const [rows, setRows] = useState<Row[]>(() => settings.materials.map(toRow));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const close = () => {
    openCompareDialog(null);
  };
  useFocusTrap(ref, true, { onEscape: close });
  const set = (k: number, patch: Partial<Row>) => {
    setRows(rows.map((r, i) => (i === k ? { ...r, ...patch } : r)));
  };
  const save = async () => {
    const r = rowsToMaterials(rows);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    const err = await saveSiteSettings({ ...settings, materials: r.materials });
    if (err) setError(`The materials were not saved: ${err}`);
    else close();
  };
  const importCsv = async (f: File) => {
    const text = await f.text();
    const got = materialsFromCsv(text);
    const current = rowsToMaterials(rows);
    const base = 'materials' in current ? current.materials : [];
    const merged = mergeMaterials(base, got.materials);
    setRows(merged.map(toRow));
    setError(got.problems.length ? got.problems.slice(0, 5).join(' ') : null);
    setNote(
      `${String(got.materials.length)} materials read from ${f.name}${got.problems.length ? `, ${String(got.problems.length)} rows left out` : ''}. Save to keep them.`,
    );
  };
  const exportCsv = async () => {
    const r = rowsToMaterials(rows);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    const res = await bridge.call('dialog:saveFile', {
      defaultName: 'site-materials.csv',
      data: materialsToCsv(r.materials),
      title: 'Export the site materials',
    });
    if (!res.ok) setError(res.error);
    else if (res.value.error) setError(res.value.error);
    else if (res.value.path) setNote(`Exported to ${res.value.path}.`);
  };
  return (
    <div
      ref={ref}
      className="sv-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sv-materials-title"
      data-testid="survey-materials"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sv-dialog sv-materials">
        <header className="sv-head" role="none">
          <h2 id="sv-materials-title">Site materials</h2>
          <button type="button" className="btn ghost sm" aria-label="Close" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <p className="small faint">
          Density in tonnes per cubic metre; swell as loose and compacted volume over bank (in situ)
          volume. The calculators use them at display time only.
        </p>
        <div className="sv-scroll">
          <table className="sv-verts sv-mat-table">
            <caption className="sr-only">Materials</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">ID</th>
                <th scope="col">Code</th>
                <th scope="col">Density (t/m³)</th>
                <th scope="col">Loose</th>
                <th scope="col">Compacted</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => {
                const n = String(k + 1);
                const cell = (key: keyof Row, label: string, type: 'text' | 'number' = 'text') => (
                  <td>
                    <input
                      className="sv-input"
                      type={type}
                      step={type === 'number' ? '0.01' : undefined}
                      aria-label={`Material ${n} ${label}`}
                      data-testid={`survey-mat-${key}`}
                      value={r[key]}
                      readOnly={readOnly}
                      onChange={(e) => {
                        set(k, { [key]: e.target.value });
                      }}
                    />
                  </td>
                );
                return (
                  <tr key={k} data-testid="survey-mat-row">
                    {cell('name', 'name')}
                    {cell('id', 'ID')}
                    {cell('code', 'code')}
                    {cell('density', 'density', 'number')}
                    {cell('loose', 'loose factor', 'number')}
                    {cell('compacted', 'compacted factor', 'number')}
                    <td>
                      {!readOnly && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`Remove material ${n}`}
                          onClick={() => {
                            setRows(rows.filter((_, i) => i !== k));
                          }}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="small faint">No materials yet.</p>}
        </div>
        {!readOnly && (
          <div className="sv-row sv-wrap">
            <button
              type="button"
              className="btn sm"
              disabled={rows.length >= MAX_MATERIALS}
              data-testid="survey-mat-add"
              onClick={() => {
                const taken = new Set(rows.map((r) => r.id));
                const name = `Material ${String(rows.length + 1)}`;
                setRows([
                  ...rows,
                  {
                    id: materialIdFrom(name, taken),
                    name,
                    code: '',
                    density: '',
                    loose: '',
                    compacted: '',
                  },
                ]);
              }}
            >
              <Icon name="plus" size={12} /> Add a material
            </button>
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
              accept=".csv,text/csv"
              hidden
              aria-label="Import materials from a CSV file"
              data-testid="survey-mat-import"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importCsv(f);
              }}
            />
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                void exportCsv();
              }}
            >
              <Icon name="download" size={12} /> Export CSV
            </button>
          </div>
        )}
        {note && (
          <p className="small" role="status" data-testid="survey-mat-note">
            {note}
          </p>
        )}
        {error && (
          <p className="notice danger small" role="alert" data-testid="survey-mat-error">
            <Icon name="warn" size={14} />
            {error}
          </p>
        )}
        <footer className="sv-foot" role="none">
          <span className="sv-grow" />
          <button type="button" className="btn sm ghost" onClick={close}>
            Cancel
          </button>
          {!readOnly && (
            <button
              type="button"
              className="btn sm primary"
              data-testid="survey-mat-save"
              onClick={() => {
                void save();
              }}
            >
              Save materials
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
