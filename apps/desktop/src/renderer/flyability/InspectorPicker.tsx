import { Button, Dialog, useT } from '@aio/ui';
import { importable, selectionOf } from './pickerModel';
import {
  closeInspectorPicker,
  confirmInspectorPicker,
  toggleFlightTick,
  toggleInspectionTick,
  usePicker,
} from './pickerStore';
import './flyability.css';

const ALIGNED = {
  relocalised: 'fly.picker.aligned.relocalised',
  transform: 'fly.picker.aligned.transform',
  reference: 'fly.picker.aligned.reference',
} as const;

/** The dialog that asks which inspections and flights of a Flyability export to bring in. */
export function InspectorPickerHost() {
  const t = useT();
  const path = usePicker((s) => s.path);
  const scan = usePicker((s) => s.scan);
  const choice = usePicker((s) => s.choice);
  if (path === null || !scan || !choice) return null;
  const ready = selectionOf(choice, scan) !== null;
  return (
    <Dialog
      open
      size="lg"
      testId="inspector-picker"
      title={t('fly.picker.title')}
      description={t('fly.picker.description')}
      onClose={closeInspectorPicker}
      footer={
        <>
          <Button variant="quiet" onClick={closeInspectorPicker} data-testid="inspector-cancel">
            {t('fly.picker.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => void confirmInspectorPicker()}
            data-testid="inspector-import"
          >
            {t('fly.picker.import')}
          </Button>
        </>
      }
    >
      <div className="fly-picker">
        <div className="fly-picker-list" data-testid="inspector-list">
          {scan.inspections.map((i) => {
            const c = choice.inspections[i.id] ?? { on: false, flights: [] };
            const usable = i.flights.filter(importable);
            const all = usable.length > 0 && usable.every((f) => c.flights.includes(f.id));
            return (
              <section key={i.id} className="fly-insp" data-testid={`inspector-row-${i.id}`}>
                <label className="fly-insp-head">
                  <input
                    type="checkbox"
                    checked={all || (c.on && usable.length === 0)}
                    ref={(el) => {
                      if (el) el.indeterminate = c.on && !all && usable.length > 0;
                    }}
                    onChange={() => {
                      toggleInspectionTick(i.id);
                    }}
                    aria-describedby={i.importedAs !== null ? `inspector-merge-${i.id}` : undefined}
                    data-testid={`inspector-tick-${i.id}`}
                  />
                  <span className="fly-insp-name">{i.name}</span>
                </label>
                <div className="fly-insp-meta">
                  <span>{i.mergedCloud ? t('fly.picker.merged') : t('fly.picker.noMerged')}</span>
                  <span>{t('fly.picker.findings', { count: i.findings })}</span>
                  {i.importedAs !== null && (
                    <span
                      id={`inspector-merge-${i.id}`}
                      className="fly-insp-merge"
                      data-testid={`inspector-imported-${i.id}`}
                    >
                      {t('fly.picker.imported')}
                    </span>
                  )}
                </div>
                {i.flights.length > 0 && (
                  <ul className="fly-flights" aria-label={t('fly.picker.flights')}>
                    {i.flights.map((f) => (
                      <li key={f.id} className="fly-flight" data-empty={!importable(f)}>
                        <label className="fly-flight-label">
                          <input
                            type="checkbox"
                            disabled={!importable(f)}
                            aria-describedby={`inspector-note-${f.id}`}
                            checked={c.flights.includes(f.id)}
                            onChange={() => {
                              toggleFlightTick(i.id, f.id);
                            }}
                            data-testid={`inspector-flight-${f.id}`}
                          />
                          <span>{f.name}</span>
                        </label>
                        <span
                          className="fly-flight-note"
                          id={`inspector-note-${f.id}`}
                          data-testid={`inspector-note-${f.id}`}
                        >
                          {importable(f) ? t(ALIGNED[f.aligned]) : t('fly.picker.noData')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
