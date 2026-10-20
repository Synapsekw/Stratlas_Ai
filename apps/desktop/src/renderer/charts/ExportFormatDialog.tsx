/**
 * The one export dialog (volumetric parity W1). It replaces the five DXF buttons in the section
 * toolbar: the choices are laid out in groups (DXF, CSV, PNG), one is picked, and Export hands it
 * back. The dialog only asks; the caller runs the export.
 */
import { Icon, useFocusTrap, useT } from '@aio/ui';
import { useId, useRef, useState, type ReactElement } from 'react';
import './ExportFormatDialog.css';

export interface ExportChoice<F extends string> {
  format: F;
  label: string;
  group: 'DXF' | 'CSV' | 'PNG';
}

const GROUPS = ['DXF', 'CSV', 'PNG'] as const;
const GROUP_KEY = { DXF: 'chart.dxf', CSV: 'chart.csv', PNG: 'chart.png' } as const;

export function ExportFormatDialog<F extends string>(p: {
  title: string;
  choices: readonly ExportChoice<F>[];
  initial: F;
  onExport(f: F): void;
  onClose(): void;
}): ReactElement {
  const t = useT();
  const [picked, setPicked] = useState<F>(p.initial);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const name = useId();
  useFocusTrap(ref, true, {
    onEscape: () => {
      p.onClose();
    },
    initial: () => ref.current?.querySelector<HTMLElement>('input:checked') ?? null,
  });
  return (
    <div
      className="sv-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div
        ref={ref}
        className="sv-dialog xf-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="export-format-dialog"
      >
        <header className="sv-head" role="none">
          <h2 id={titleId}>{p.title}</h2>
          <button
            type="button"
            className="btn ghost sm"
            aria-label={t('chart.exportClose')}
            onClick={() => {
              p.onClose();
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        {GROUPS.map((g) => {
          const items = p.choices.filter((c) => c.group === g);
          if (!items.length) return null;
          const headId = `${titleId}-${g}`;
          return (
            <div key={g} className="xf-group" role="radiogroup" aria-labelledby={headId}>
              <span id={headId} className="xf-group-name">
                {t(GROUP_KEY[g])}
              </span>
              {items.map((c) => (
                <label key={c.format} className="xf-choice">
                  <input
                    type="radio"
                    name={name}
                    value={c.format}
                    checked={picked === c.format}
                    onChange={() => {
                      setPicked(c.format);
                    }}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          );
        })}
        <footer className="sv-foot">
          <button
            type="button"
            className="btn primary"
            data-testid="export-go"
            onClick={() => {
              p.onExport(picked);
            }}
          >
            {t('chart.export')}
          </button>
        </footer>
      </div>
    </div>
  );
}
