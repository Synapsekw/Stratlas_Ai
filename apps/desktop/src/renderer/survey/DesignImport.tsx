/**
 * The options step of **Import design** (M11 G6, DSN-1), after the file is picked: format (as
 * detected by default), CRS (searched in the EPSG catalogue, the project's by default) or the site
 * calibration when one is applied, units (the file's own when it states them), the layers to
 * import (ticked from a quick look at the file, else typed) and the name. **Import** starts
 * `design.import` with them (`designImportForm.ts`).
 */
import { isKnownCrs, toWgs84 } from '@aio/geo';
import type { CrsCatalogueEntry, DesignFormat, DesignSourceUnits } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useId, useMemo, useState } from 'react';
import { bridge } from '../shell';
import {
  FORMAT_LABELS,
  formProblem,
  importParams,
  initialForm,
  listsLayers,
  typedLayerNames,
  UNIT_LABELS,
  type DesignProbe,
  type ImportForm,
} from './designImportForm';
import { startDesignImport } from './designsStore';
import { useMeasure } from './measureStore';

const FORMATS: DesignFormat[] = ['landxml', 'dxf', '12da', 'csv'];
const UNITS: DesignSourceUnits[] = ['m', 'mm', 'cm', 'ft', 'us-ft', 'in'];

function CrsSearch({
  near,
  onPick,
}: {
  near: [number, number] | undefined;
  onPick: (e: CrsCatalogueEntry) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CrsCatalogueEntry[]>([]);
  useEffect(() => {
    if (!query.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      void bridge
        .call('geodesy:searchCrs', {
          query,
          ...(near ? { near } : {}),
          kinds: ['projected', 'geographic'],
          limit: 20,
        })
        .then((r) => {
          if (live && r.ok && r.value.ok) setResults(r.value.results);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, near]);
  const shown = query.trim() ? results : [];
  return (
    <div>
      <input
        className="input"
        placeholder="Search by name, place or EPSG code"
        aria-label="Search coordinate systems for the design"
        data-testid="design-import-crs-search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
      />
      {shown.length > 0 && (
        <ul className="design-import-crs" role="listbox" aria-label="Coordinate systems">
          {shown.map((e) => (
            <li key={e.code}>
              <button
                type="button"
                className="btn ghost sm"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onPick(e);
                  setQuery('');
                }}
              >
                <span className="mono">EPSG {e.code}</span> {e.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DesignImportOptions({
  path,
  probe,
  onClose,
}: {
  path: string;
  probe: DesignProbe | null;
  onClose: (error: string | null) => void;
}) {
  const project = useWorkspace((s) => s.project);
  const calibration = useMeasure((s) => s.settings.calibration ?? null);
  const [form, setForm] = useState<ImportForm>(() => initialForm(path, probe));
  const [crsName, setCrsName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const manifest = project?.manifest ?? null;
  const near = useMemo((): [number, number] | undefined => {
    const crs = manifest?.crs;
    if (!manifest || !crs || !('epsg' in crs) || !isKnownCrs(crs.epsg)) return undefined;
    try {
      const [lon, lat] = toWgs84(manifest.origin, crs.epsg);
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : undefined;
    } catch {
      return undefined;
    }
  }, [manifest]);
  if (!project) return null;
  const projectCrs =
    'epsg' in project.manifest.crs ? `EPSG:${String(project.manifest.crs.epsg)}` : 'WKT';
  const patch = (p: Partial<ImportForm>) => {
    setForm((f) => ({ ...f, ...p }));
  };
  const problem = formProblem(form, probe);
  const file = path.split(/[\\/]/).pop() ?? path;
  const detected = probe?.format ? FORMAT_LABELS[probe.format] : 'not recognised';
  const ticked = listsLayers(probe);
  const typed = typedLayerNames(form.typedLayers);
  return (
    <section
      className="pop-form design-import"
      aria-label="Import design options"
      data-testid="design-import"
    >
      <h4>Import {file}</h4>
      <label className="pop-row">
        <span>Name</span>
        <input
          value={form.name}
          maxLength={200}
          aria-label="Design name to import as"
          onChange={(e) => {
            patch({ name: e.target.value });
          }}
        />
      </label>
      <label className="pop-row">
        <span>Format</span>
        <select
          value={form.format}
          aria-label="Design format"
          data-testid="design-import-format"
          onChange={(e) => {
            patch({ format: e.target.value as ImportForm['format'] });
          }}
        >
          <option value="auto">Automatic ({detected})</option>
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      {calibration && (
        <label className="pop-row">
          <input
            type="checkbox"
            checked={form.useCalibration}
            data-testid="design-import-calibration"
            onChange={(e) => {
              patch({ useCalibration: e.target.checked });
            }}
          />
          <span>Place it through the site calibration (local site coordinates)</span>
        </label>
      )}
      {!form.useCalibration && (
        <fieldset className="pop-form" aria-labelledby={`${ids}-crs`}>
          <legend id={`${ids}-crs`}>Coordinate system of the file</legend>
          <p className="pop-note" data-testid="design-import-crs">
            {form.crs
              ? (crsName ?? ('epsg' in form.crs ? `EPSG:${String(form.crs.epsg)}` : 'WKT'))
              : `The file's own, else the project's (${projectCrs})`}
            {form.crs && (
              <>
                {' '}
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    patch({ crs: null });
                    setCrsName(null);
                  }}
                >
                  Use the default
                </button>
              </>
            )}
          </p>
          <CrsSearch
            near={near}
            onPick={(e) => {
              patch({ crs: { epsg: e.code } });
              setCrsName(`EPSG:${String(e.code)} ${e.name}`);
            }}
          />
        </fieldset>
      )}
      <label className="pop-row">
        <span>Units</span>
        <select
          value={probe?.units ? 'file' : form.units}
          disabled={Boolean(probe?.units)}
          aria-label="Design units"
          data-testid="design-import-units"
          onChange={(e) => {
            patch({ units: e.target.value as ImportForm['units'] });
          }}
        >
          <option value="file">
            {probe?.units
              ? `As the file states (${UNIT_LABELS[probe.units]})`
              : 'As the file states (metres if it states none)'}
          </option>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </label>
      {probe?.units && (
        <p className="pop-note">The file states its units, so they are used as they are.</p>
      )}
      <fieldset className="pop-form" aria-labelledby={`${ids}-layers`}>
        <legend id={`${ids}-layers`}>Layers to import</legend>
        {ticked && probe ? (
          <ul className="design-import-layers" data-testid="design-import-layers">
            {probe.layers.map((l) => (
              <li key={l}>
                <label>
                  <input
                    type="checkbox"
                    checked={form.picked.includes(l)}
                    onChange={(e) => {
                      patch({
                        picked: e.target.checked
                          ? [...form.picked, l]
                          : form.picked.filter((x) => x !== l),
                      });
                    }}
                  />{' '}
                  {l}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <input
              value={form.typedLayers}
              placeholder="Every layer"
              aria-label="Layer names to import, comma separated"
              data-testid="design-import-typed-layers"
              onChange={(e) => {
                patch({ typedLayers: e.target.value });
              }}
            />
            <p className="pop-note">
              {probe?.partial
                ? 'The file is too large to list its layers here. '
                : 'The layers could not be listed. '}
              Type their names, comma separated, or leave it empty for every layer
              {typed.length > 0 ? ` (${String(typed.length)} named)` : ''}.
            </p>
          </>
        )}
      </fieldset>
      {(problem ?? error) && (
        <p className="pop-note" role="alert">
          {problem ?? error}
        </p>
      )}
      <div className="pop-row">
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || problem !== null}
          data-testid="design-import-start"
          onClick={() => {
            setBusy(true);
            void startDesignImport(project.root, importParams(path, form, probe)).then((e) => {
              setBusy(false);
              if (e) setError(e);
              else onClose(null);
            });
          }}
        >
          Import
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            onClose(null);
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
