/**
 * Units (M11 G3): one measurement's own units over the site units, or the site units themselves
 * (written through G1's site settings). Stored values stay SI; this is display only. The
 * international foot and the US survey foot are offered side by side with distinct names.
 */
import {
  AreaUnit,
  DensityUnit,
  DistanceUnit,
  GradeStyle,
  MassUnit,
  VolumeUnit,
  type SurveyUnits,
  UnitsOverride,
} from '@aio/schema';
import { formatQuantity, unitName, type AnyUnit } from '@aio/geo';
import { effectiveUnits } from '@aio/survey';
import { Dialog, Icon } from '@aio/ui';
import { useState } from 'react';
import { openDialog, saveSiteSettings, updateMeasurement, useMeasure } from './measureStore';

type Key = keyof SurveyUnits;

const QUANTITIES: { key: Key; label: string; options: readonly string[]; sample: number }[] = [
  { key: 'distance', label: 'Distance', options: DistanceUnit.options, sample: 100 },
  { key: 'area', label: 'Area', options: AreaUnit.options, sample: 10_000 },
  { key: 'volume', label: 'Volume', options: VolumeUnit.options, sample: 1000 },
  { key: 'density', label: 'Density', options: DensityUnit.options, sample: 1.8 },
  { key: 'mass', label: 'Mass', options: MassUnit.options, sample: 1_000_000 },
  { key: 'grade', label: 'Grade', options: GradeStyle.options, sample: 0.05 },
];

const SI_LABEL: Record<Key, string> = {
  distance: '100 m',
  area: '1 ha',
  volume: '1,000 m³',
  density: '1.8 t/m³',
  mass: '1,000 t',
  grade: '5 %',
};

export function UnitsDialog() {
  const dialog = useMeasure((s) => s.dialog);
  const settings = useMeasure((s) => s.settings);
  const m = useMeasure((s) => s.file.measurements.find((x) => x.id === s.focus) ?? null);
  const target = dialog?.kind === 'units' ? dialog.target : 'site';
  const forMeasurement = target === 'measurement' && m !== null;
  const [own, setOwn] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(m?.units ?? {}).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
    ),
  );
  const [site, setSite] = useState<SurveyUnits>(() => ({ ...settings.units }));
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    openDialog(null);
  };

  const shown: SurveyUnits = forMeasurement ? effectiveUnits(settings.units, clean(own)) : site;
  const save = async () => {
    if (forMeasurement) {
      const units = clean(own);
      updateMeasurement(m.id, (x) => {
        const next = { ...x };
        if (Object.keys(units).length > 0) next.units = units;
        else delete next.units;
        return next;
      });
      close();
      return;
    }
    const err = await saveSiteSettings({ ...settings, units: site });
    if (err) setError(`The site units were not saved: ${err}`);
    else close();
  };

  return (
    <Dialog
      open
      onClose={close}
      title={forMeasurement ? `Units for ${m.label}` : 'Site units'}
      testId="survey-units-dialog"
      description={
        forMeasurement
          ? 'This measurement shows its values in these units; the others keep the site units. Values are stored in metres.'
          : 'How every measurement shows its values unless it has its own units. Values are stored in metres.'
      }
      footer={
        <>
          <button type="button" className="btn sm ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn sm primary"
            data-testid="survey-units-save"
            onClick={() => {
              void save();
            }}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="sv-unit-grid">
        {QUANTITIES.map((q) => {
          const value = forMeasurement ? (own[q.key] ?? '') : site[q.key];
          return (
            <label key={q.key} className="sv-field">
              <span>{q.label}</span>
              <select
                className="sv-input"
                value={value}
                data-testid={`survey-unit-${q.key}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (forMeasurement) {
                    const next = Object.fromEntries(
                      Object.entries(own).filter(([k]) => k !== q.key),
                    );
                    if (v) next[q.key] = v;
                    setOwn(next);
                  } else setSite({ ...site, [q.key]: v });
                }}
              >
                {forMeasurement && (
                  <option value="">Site ({unitName(settings.units[q.key])})</option>
                )}
                {q.options.map((o) => (
                  <option key={o} value={o}>
                    {unitName(o as AnyUnit)}
                  </option>
                ))}
              </select>
              <small className="faint mono">
                {SI_LABEL[q.key]} reads {formatQuantity(q.sample, q.key, shown, settings.precision)}
              </small>
            </label>
          );
        })}
      </div>
      {error && (
        <p className="notice danger small" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The override without empty keys. */
function clean(o: Record<string, string>): UnitsOverride {
  const parsed = UnitsOverride.safeParse(
    Object.fromEntries(Object.entries(o).filter(([, v]) => v)),
  );
  return parsed.success ? parsed.data : {};
}
