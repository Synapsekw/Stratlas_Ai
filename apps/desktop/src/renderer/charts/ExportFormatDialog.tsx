/**
 * The one export dialog (volumetric parity W1). It replaces the five DXF buttons in the section
 * toolbar: the choices are laid out in groups (DXF, CSV, PNG), one is picked, and Export hands it
 * back. The dialog only asks; the caller runs the export.
 */
import { Dialog, useT } from '@aio/ui';
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
  // the picked choice takes focus first
  const checked = useRef<HTMLInputElement>(null);
  const groupId = useId();
  const name = useId();
  return (
    <Dialog
      open
      onClose={() => {
        p.onClose();
      }}
      title={p.title}
      size="sm"
      className="xf-dialog"
      testId="export-format-dialog"
      initialFocus={checked}
      footer={
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
      }
    >
      {GROUPS.map((g) => {
        const items = p.choices.filter((c) => c.group === g);
        if (!items.length) return null;
        const headId = `${groupId}-${g}`;
        return (
          <div key={g} className="xf-group" role="radiogroup" aria-labelledby={headId}>
            <span id={headId} className="xf-group-name">
              {t(GROUP_KEY[g])}
            </span>
            {items.map((c) => (
              <label key={c.format} className="xf-choice">
                <input
                  ref={picked === c.format ? checked : undefined}
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
    </Dialog>
  );
}
