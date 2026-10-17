/**
 * Import the cell export CSV (spec D6): choose a file, review every row matched to a detected unit
 * by name (or id), with the rows that match no unit listed too, then apply the chosen rows to the
 * RF working copy. Nothing is written until the tab saves; imported values are the person's
 * (basis user). The format is `cellCsv.ts`.
 */
import { Button, IconButton, PortalRoot, useFocusTrap, useT, type MessageKey } from '@aio/ui';
import { useMemo, useRef, useState } from 'react';
import { applicable, parseCellCsv, type CellProblem, type CellRow } from './cellCsv';
import { applyCellImport, useRf } from './rfStore';
import './rf.css';

const PROBLEM_KEY: Readonly<Record<CellProblem, MessageKey>> = {
  'no-unit': 'rf.csv.problem.noUnit',
  duplicate: 'rf.csv.problem.duplicate',
  'band-unknown': 'rf.csv.problem.band',
  bandwidth: 'rf.csv.problem.bandwidth',
  power: 'rf.csv.problem.power',
  etilt: 'rf.csv.problem.etilt',
  'antenna-model': 'rf.csv.problem.antennaModel',
  'radio-model': 'rf.csv.problem.radioModel',
  tech: 'rf.csv.problem.tech',
};

export interface CsvImportProps {
  onClose: () => void;
  /** The button that opened it (theme, and where focus goes back). */
  opener: HTMLElement | null;
  /** Read a chosen file; tests pass text straight in. */
  readFile?: (file: File) => Promise<string>;
}

const blank = (v: string | number | undefined): string => (v === undefined ? '' : String(v));

export function CsvImport({ onClose, opener, readFile }: CsvImportProps) {
  const t = useT();
  const units = useRf((s) => s.antennas?.units ?? null);
  const catalogue = useRf((s) => s.catalogue);
  const readOnly = useRf((s) => s.readOnly);
  const [rows, setRows] = useState<CellRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skip, setSkip] = useState<ReadonlySet<number>>(new Set());
  const dlg = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  useFocusTrap(dlg, true, {
    onEscape: onClose,
    initial: () => choose.current,
    returnTo: () => opener,
  });
  const entries = useMemo(() => catalogue.map((c) => c.entry), [catalogue]);
  const nameOf = (id: string | undefined) =>
    id === undefined
      ? ''
      : (() => {
          const e = entries.find((x) => x.id === id);
          return e ? `${e.vendor} ${e.model}` : id;
        })();

  const load = async (file: File) => {
    const text = readFile ? await readFile(file) : await file.text();
    const r = parseCellCsv(text, units ?? [], entries);
    setFileName(file.name);
    setSkip(new Set());
    if (!r.ok) {
      setRows(null);
      setError(t(r.error === 'empty' ? 'rf.csv.empty' : 'rf.csv.noAntennaColumn'));
      return;
    }
    setError(null);
    setRows(r.rows);
  };

  const usable = rows?.filter(applicable) ?? [];
  const chosen = usable.filter((r) => !skip.has(r.line));
  const unmatched = (rows ?? []).filter((r) => r.unitId === null).length;
  const applyReason = readOnly
    ? t('rf.csv.readOnly')
    : chosen.length === 0
      ? t('rf.csv.nothingToApply')
      : undefined;

  return (
    <PortalRoot opener={opener}>
      <div
        className="dlg-scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={dlg}
          className="dlg wide rf-csv"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rf-csv-title"
          data-testid="rf-csv"
        >
          <div className="dlg-h">
            <h2 id="rf-csv-title">{t('rf.csv.title')}</h2>
            {fileName && <span className="sub">{fileName}</span>}
            <IconButton icon="x" label={t('rf.csv.close')} onClick={onClose} />
          </div>
          <div className="dlg-b">
            <p className="rf-note">{t('rf.csv.format')}</p>
            <p className="rf-note mono">{t('rf.csv.columns')}</p>
            <div className="rf-actions">
              <Button
                ref={choose}
                icon="import"
                onClick={() => {
                  input.current?.click();
                }}
              >
                {t(rows ? 'rf.csv.chooseAnother' : 'rf.csv.choose')}
              </Button>
              <input
                ref={input}
                className="sr-only"
                type="file"
                accept=".csv,text/csv"
                tabIndex={-1}
                aria-hidden="true"
                data-testid="rf-csv-file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void load(f);
                }}
              />
            </div>
            {error && (
              <p className="rf-note rf-err" role="alert">
                {error}
              </p>
            )}
            {rows && (
              <>
                <p className="rf-note" role="status" data-testid="rf-csv-summary">
                  {t('rf.csv.summary', { matched: usable.length, unmatched })}
                </p>
                <div className="rf-csv-table-wrap">
                  <table className="rf-csv-table">
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className="sr-only">{t('rf.csv.col.apply')}</span>
                        </th>
                        <th scope="col">{t('rf.csv.col.inFile')}</th>
                        <th scope="col">{t('rf.csv.col.unit')}</th>
                        <th scope="col">{t('rf.csv.col.sector')}</th>
                        <th scope="col">{t('rf.csv.col.band')}</th>
                        <th scope="col">{t('rf.csv.col.bandwidth')}</th>
                        <th scope="col">{t('rf.csv.col.power')}</th>
                        <th scope="col">{t('rf.csv.col.etilt')}</th>
                        <th scope="col">{t('rf.csv.col.equipment')}</th>
                        <th scope="col">{t('rf.csv.col.problems')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const ok = applicable(r);
                        return (
                          <tr
                            key={r.line}
                            data-testid={`rf-csv-row-${String(r.line)}`}
                            data-matched={r.unitId !== null}
                          >
                            <td>
                              <input
                                type="checkbox"
                                disabled={!ok}
                                checked={ok && !skip.has(r.line)}
                                aria-label={t('rf.csv.applyRow', { name: r.ref || r.line })}
                                onChange={(e) => {
                                  const next = new Set(skip);
                                  if (e.target.checked) next.delete(r.line);
                                  else next.add(r.line);
                                  setSkip(next);
                                }}
                              />
                            </td>
                            <td className="mono">{r.ref}</td>
                            <td>
                              {r.unitName ?? <span className="rf-off">{t('rf.csv.noMatch')}</span>}
                            </td>
                            <td>{blank(r.sector)}</td>
                            <td>{blank(r.band)}</td>
                            <td className="mono">{blank(r.bandwidthMhz)}</td>
                            <td className="mono">{blank(r.powerDbm)}</td>
                            <td className="mono">{blank(r.etiltDeg)}</td>
                            <td>
                              {[nameOf(r.radioEntry), nameOf(r.antennaEntry)]
                                .filter((x) => x !== '')
                                .join(', ')}
                            </td>
                            <td className="rf-csv-problems">
                              {r.problems.map((p) => t(PROBLEM_KEY[p])).join(' ')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
          <div className="dlg-f">
            <span className="grow rf-cat-foot">{t('rf.csv.notSaved')}</span>
            <Button onClick={onClose}>{t('rf.csv.cancel')}</Button>
            <Button
              variant="primary"
              disabledReason={applyReason}
              data-testid="rf-csv-apply"
              onClick={() => {
                applyCellImport(chosen);
                onClose();
              }}
            >
              {t('rf.csv.apply', { count: chosen.length })}
            </Button>
          </div>
        </div>
      </div>
    </PortalRoot>
  );
}
