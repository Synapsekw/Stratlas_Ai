/**
 * The measurement settings of a thermal photo, in a popover under the settings line's Edit:
 * emissivity, distance, air temperature, humidity and the reflected temperature (same as the air
 * unless set). The scope buttons are the save: This photo, the photos marked in the filmstrip (when
 * more than one), or the whole dataset. A value out of range leaves them greyed. Only the fields
 * the person changed are applied, so the other photos keep the rest of their own settings (a
 * distance from each photo's height, say).
 */
import type { ThermalSettings } from '@aio/schema';
import { Button, Popover, useT, type MessageKey } from '@aio/ui';
import { useState, type RefObject } from 'react';
import { changedSettings } from './settings';

export type SettingsScope = 'photo' | 'selected' | 'all';

type Field = 'emissivity' | 'distanceM' | 'airC' | 'humidityPct';

/** Each setting's label, by its name in `ThermalSettings` (the clamped notice uses it too). */
export const SETTING_LABEL: Record<keyof ThermalSettings, MessageKey> = {
  emissivity: 'thermal.settings.emissivity',
  distanceM: 'thermal.settings.distance',
  airC: 'thermal.settings.air',
  humidityPct: 'thermal.settings.humidity',
  reflectedC: 'thermal.settings.reflected',
};

const FIELDS: readonly { key: Field; min?: number; max?: number; step: number }[] = [
  { key: 'emissivity', min: 0.01, max: 1, step: 0.01 },
  { key: 'distanceM', min: 0, step: 1 },
  { key: 'airC', step: 0.5 },
  { key: 'humidityPct', min: 0, max: 100, step: 1 },
];

type Form = Record<Field, string> & { reflected: string; sameAsAir: boolean };

const formOf = (s: ThermalSettings): Form => ({
  emissivity: String(s.emissivity),
  distanceM: String(s.distanceM),
  airC: String(s.airC),
  humidityPct: String(s.humidityPct),
  reflected: String(s.reflectedC ?? s.airC),
  sameAsAir: s.reflectedC === null,
});

const num = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The settings the form holds, or null when a value is missing or out of range. */
export function settingsOf(f: Form): ThermalSettings | null {
  const emissivity = num(f.emissivity);
  const distanceM = num(f.distanceM);
  const airC = num(f.airC);
  const humidityPct = num(f.humidityPct);
  const reflected = f.sameAsAir ? null : num(f.reflected);
  if (emissivity === null || emissivity <= 0 || emissivity > 1) return null;
  if (distanceM === null || distanceM < 0) return null;
  if (airC === null) return null;
  if (humidityPct === null || humidityPct < 0 || humidityPct > 100) return null;
  if (!f.sameAsAir && reflected === null) return null;
  return { emissivity, distanceM, airC, humidityPct, reflectedC: reflected };
}

interface EditorProps {
  open: boolean;
  onClose: () => void;
  opener: RefObject<HTMLElement | null>;
  settings: ThermalSettings;
  /** Photos marked in the filmstrip; the selected scope shows for more than one. */
  selected: number;
  /** The fields changed from `settings`, for the scope picked. */
  onApply: (scope: SettingsScope, patch: Partial<ThermalSettings>) => void;
}

/** Mounted only while open, so each opening starts from the photo's settings. */
export function SettingsEditor(props: EditorProps) {
  return props.open ? <EditorBody {...props} /> : null;
}

function EditorBody({ onClose, opener, settings, selected, onApply }: EditorProps) {
  const t = useT();
  const [form, setForm] = useState<Form>(() => formOf(settings));
  const parsed = settingsOf(form);
  const apply = (scope: SettingsScope) => {
    if (!parsed) return;
    onApply(scope, changedSettings(settings, parsed));
    onClose();
  };
  return (
    <Popover
      open
      onClose={onClose}
      opener={opener}
      anchor="below"
      className="th-editor"
      footer={
        <div className="th-editor-scope">
          <Button
            variant="primary"
            disabled={!parsed}
            data-testid="thermal-apply-photo"
            onClick={() => {
              apply('photo');
            }}
          >
            {t('thermal.settings.applyPhoto')}
          </Button>
          {selected > 1 && (
            <Button
              disabled={!parsed}
              data-testid="thermal-apply-selected"
              onClick={() => {
                apply('selected');
              }}
            >
              {t('thermal.settings.applySelected', { count: selected })}
            </Button>
          )}
          <Button
            disabled={!parsed}
            data-testid="thermal-apply-all"
            onClick={() => {
              apply('all');
            }}
          >
            {t('thermal.settings.applyAll')}
          </Button>
        </div>
      }
    >
      <div className="pop-form th-editor-form" data-testid="thermal-settings-editor">
        {FIELDS.map((f) => (
          <label key={f.key} className="th-field">
            <span>{t(SETTING_LABEL[f.key])}</span>
            <input
              type="number"
              inputMode="decimal"
              value={form[f.key]}
              min={f.min}
              max={f.max}
              step={f.step}
              data-testid={`thermal-setting-${f.key}`}
              onChange={(e) => {
                setForm({ ...form, [f.key]: e.target.value });
              }}
            />
          </label>
        ))}
        <fieldset className="th-field th-reflected">
          <legend>{t('thermal.settings.reflected')}</legend>
          <label className="th-check">
            <input
              type="checkbox"
              checked={form.sameAsAir}
              data-testid="thermal-setting-sameAsAir"
              onChange={(e) => {
                setForm({ ...form, sameAsAir: e.target.checked });
              }}
            />
            {t('thermal.settings.reflectedSameAsAir')}
          </label>
          {!form.sameAsAir && (
            <input
              type="number"
              inputMode="decimal"
              step={0.5}
              value={form.reflected}
              aria-label={t('thermal.settings.reflected')}
              data-testid="thermal-setting-reflectedC"
              onChange={(e) => {
                setForm({ ...form, reflected: e.target.value });
              }}
            />
          )}
        </fieldset>
      </div>
    </Popover>
  );
}
