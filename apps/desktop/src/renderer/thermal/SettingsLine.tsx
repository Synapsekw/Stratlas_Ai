/**
 * The one line under the thermal photo with the settings its temperatures are computed with
 * ("Emissivity 0.95 · Distance 18 m · Air 32 °C · Humidity 60%") and Edit, which opens the
 * settings editor. A read-only bench shows the line without Edit. With a raster on show the line
 * is the settings the raster was decoded with; when the camera's SDK clamped a value, a note says
 * which and what it used.
 */
import type { ThermalSettings } from '@aio/schema';
import { Button, useT } from '@aio/ui';
import { useRef, useState } from 'react';
import { SETTING_LABEL, SettingsEditor, type SettingsScope } from './SettingsEditor';

/** A setting as the line shows it: at most one decimal (emissivity two). */
const one = (v: number): string => String(Math.round(v * 10) / 10);

const isSetting = (k: string): k is keyof ThermalSettings => k in SETTING_LABEL;

export function SettingsLine({
  settings,
  clamped,
  readOnly,
  selected,
  onApply,
}: {
  settings: ThermalSettings;
  /** Settings the camera's SDK held to its limits (the raster's, whose settings `settings` are). */
  clamped: readonly string[];
  readOnly: boolean;
  selected: number;
  /** The fields the person changed, for the scope picked. */
  onApply: (scope: SettingsScope, patch: Partial<ThermalSettings>) => void;
}) {
  const t = useT();
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="th-settings">
      <div className="th-settings-row">
        <p className="th-settings-line" data-testid="thermal-settings-line">
          {t('thermal.settings.line', {
            e: settings.emissivity.toFixed(2),
            d: one(settings.distanceM),
            a: one(settings.airC),
            h: one(settings.humidityPct),
          })}
        </p>
        {!readOnly && (
          <Button
            ref={opener}
            variant="link"
            aria-haspopup="dialog"
            aria-expanded={open}
            data-testid="thermal-settings-edit"
            onClick={() => {
              setOpen((o) => !o);
            }}
          >
            {t('thermal.settings.edit')}
          </Button>
        )}
      </div>
      {clamped.filter(isSetting).map((k) => (
        <p key={k} className="th-note" data-testid={`thermal-clamped-${k}`}>
          {t('thermal.settings.clamped', {
            field: t(SETTING_LABEL[k]),
            value: one(settings[k] ?? settings.airC),
          })}
        </p>
      ))}
      <SettingsEditor
        open={open && !readOnly}
        onClose={() => {
          setOpen(false);
        }}
        opener={opener}
        settings={settings}
        selected={selected}
        onApply={onApply}
      />
    </div>
  );
}
