/**
 * The volume card's base picker (volumetric parity W3): one chip ("Base: Triangulated toe") that
 * opens the seven bases, each with its name and a one-line note on when to use it. "Previous
 * survey or design" opens the list of surveys and designs; a fixed level shows its level field
 * and a custom base its point editor (`BaseEditor`) under the chip.
 */
import { fromSI, toSI, unitLabel } from '@aio/geo';
import type { BaseSpec, SurfaceRef, SurveyMeasurement } from '@aio/schema';
import { customBase, effectiveUnits, sideFor, sideKey, type SideOption } from '@aio/survey';
import { arrowFocus, Icon, Popover, useT, type MessageKey } from '@aio/ui';
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { BaseEditor } from '../BaseEditor';
import { useMeasure } from '../measureStore';
import '../../charts/charts.css';
import '../compare.css';

export type BaseId = 'smart' | 'lowest' | 'plane' | 'level' | 'mean' | 'surface' | 'custom';

/** The seven bases in the picker's order: the default (Triangulated toe) first. */
export const BASES: readonly { id: BaseId; name: MessageKey; hint: MessageKey }[] = [
  { id: 'smart', name: 'base.smart', hint: 'base.smartHint' },
  { id: 'lowest', name: 'base.lowest', hint: 'base.lowestHint' },
  { id: 'plane', name: 'base.plane', hint: 'base.planeHint' },
  { id: 'level', name: 'base.level', hint: 'base.levelHint' },
  { id: 'mean', name: 'base.mean', hint: 'base.meanHint' },
  { id: 'surface', name: 'base.surface', hint: 'base.surfaceHint' },
  { id: 'custom', name: 'base.custom', hint: 'base.customHint' },
];

/** The default base of a new volume: a triangulated surface through the pile's toe. */
export const DEFAULT_BASE: BaseSpec = { kind: 'smart' };

/**
 * Which of the seven bases a side is. Lowest point and Fixed level are reference bases (the
 * lowest point on the perimeter, a typed level); a survey or design side is "surface". Null for a
 * reference mode the picker does not offer (an older file's highest point, say).
 */
export function baseIdOf(ref: SurfaceRef): BaseId | null {
  switch (ref.kind) {
    case 'smart':
      return 'smart';
    case 'fit-plane':
      return 'plane';
    case 'perimeter-mean':
      return 'mean';
    case 'custom':
      return 'custom';
    case 'reference':
      return ref.mode === 'perimeter-min' ? 'lowest' : ref.mode === 'level' ? 'level' : null;
    default:
      return 'surface';
  }
}

/** A surface option as the pickers show it: "Previous survey (01 Sep)". */
export const optionLabel = (o: SideOption): string => (o.note ? `${o.label} (${o.note})` : o.label);

/** The surveys and designs a base can be (never the current survey: that is what is measured). */
const surfaceChoices = (surfaces: readonly SideOption[]) =>
  surfaces.filter((o) => o.group !== 'Bases' && o.key !== 'current');

/** A side's plain name: the base's, or the survey's or design's. */
export function baseName(
  ref: SurfaceRef,
  surfaces: readonly SideOption[],
  t: (k: MessageKey) => string,
): string {
  const id = baseIdOf(ref);
  if (id === 'surface') {
    const key = sideKey(ref);
    const o = surfaces.find((x) => x.key === key);
    return o ? optionLabel(o) : key;
  }
  const b = BASES.find((x) => x.id === id);
  if (b) return t(b.name);
  // a reference mode the picker does not offer: the engine's own name for it
  return surfaces.find((x) => x.key === 'reference')?.label ?? t('base.level');
}

export function BasePicker(p: {
  value: BaseSpec | SurfaceRef;
  onChange(v: BaseSpec | SurfaceRef): void;
  surfaces: readonly SideOption[];
  readOnly: boolean;
  /** The measurement: its vertices start a fixed level and a custom base, and edit the latter. */
  m?: SurveyMeasurement;
  testId?: string;
}): ReactElement {
  const t = useT();
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [surfacesOpen, setSurfacesOpen] = useState(false);
  const points = p.m?.points ?? [];
  const id = baseIdOf(p.value);
  const name = baseName(p.value, p.surfaces, t);
  const choices = surfaceChoices(p.surfaces);
  const change = (next: SurfaceRef) => {
    p.onChange(next);
  };
  const pick = (next: SurfaceRef) => {
    setOpen(false);
    setSurfacesOpen(false);
    change(next);
  };
  const pickBase = (b: BaseId) => {
    // the same base again keeps its parameters (a typed level, the custom points)
    if (b === id) {
      setOpen(false);
      return;
    }
    if (b === 'smart') pick({ kind: 'smart' });
    else if (b === 'lowest') pick({ kind: 'reference', mode: 'perimeter-min' });
    else if (b === 'plane') pick({ kind: 'fit-plane' });
    else if (b === 'mean') pick({ kind: 'perimeter-mean' });
    else if (b === 'custom') pick(customBase(points));
    else if (b === 'level') {
      // a typed level starts at the mean vertex height (as the engine's pickers do)
      const zs = points.map((x) => x[2]).filter(Number.isFinite);
      const mean = zs.length ? zs.reduce((a, z) => a + z, 0) / zs.length : 0;
      pick({ kind: 'reference', mode: 'level', levelM: Math.round(mean * 1000) / 1000 });
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (arrowFocus(e.currentTarget, e.key)) e.preventDefault();
  };
  const selectedKey = id === 'surface' ? sideKey(p.value) : null;
  return (
    <>
      <span className="pc-chip bp-chip" data-on="">
        <button
          ref={opener}
          type="button"
          className="pc-chip-main"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={p.readOnly}
          data-testid={p.testId ?? 'survey-from'}
          data-base={id ?? 'other'}
          onClick={() => {
            setSurfacesOpen(id === 'surface');
            setOpen((x) => !x);
          }}
        >
          <span className="pc-chip-label bp-chip-label">
            {id === 'surface' ? t('vol.card.fromChip', { name }) : t('vol.card.baseChip', { name })}
          </span>
          {!p.readOnly && <Icon name="chevdown" size={12} />}
        </button>
      </span>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={opener}
        anchor="below"
        className="menu-pop bp-pop"
      >
        <div
          role="menu"
          aria-label={t('vol.card.chooseBase')}
          className="menu-list bp-list"
          onKeyDown={onMenuKey}
        >
          {BASES.map((b) => {
            const on = b.id === id;
            const isSurface = b.id === 'surface';
            return (
              <div key={b.id} className="bp-entry">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  {...(isSurface ? { 'aria-expanded': surfacesOpen } : {})}
                  className="row bp-row"
                  data-kind="menu"
                  data-base={b.id}
                  data-selected={on ? '' : undefined}
                  onClick={() => {
                    if (isSurface) setSurfacesOpen((x) => !x);
                    else pickBase(b.id);
                  }}
                >
                  <span className="menu-lead">{on && <Icon name="check" size={12} />}</span>
                  <span className="bp-text">
                    <span className="bp-name">{t(b.name)}</span>
                    <span className="bp-hint">{t(b.hint)}</span>
                  </span>
                  {isSurface && <Icon name={surfacesOpen ? 'chevup' : 'chevdown'} size={12} />}
                </button>
                {isSurface && surfacesOpen && (
                  <div
                    role="group"
                    aria-label={t(b.name)}
                    className="bp-surfaces"
                    data-testid="bp-surfaces"
                  >
                    {choices.length === 0 && <p className="bp-none">{t('vol.card.noSurfaces')}</p>}
                    {choices.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={o.key === selectedKey}
                        className="row bp-surface"
                        data-kind="menu"
                        data-selected={o.key === selectedKey ? '' : undefined}
                        onClick={() => {
                          pick(sideFor(o, points, p.value));
                        }}
                      >
                        {optionLabel(o)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Popover>
      {p.value.kind === 'reference' && p.value.mode === 'level' && (
        <LevelField value={p.value} m={p.m} readOnly={p.readOnly} onChange={change} />
      )}
      {p.value.kind === 'custom' && p.m && (
        <div className="bp-custom">
          <BaseEditor m={p.m} base={p.value} disabled={p.readOnly} onChange={change} />
        </div>
      )}
    </>
  );
}

/** The typed floor height of a fixed level, in the site's distance unit. */
function LevelField({
  value,
  m,
  readOnly,
  onChange,
}: {
  value: Extract<SurfaceRef, { kind: 'reference' }>;
  m: SurveyMeasurement | undefined;
  readOnly: boolean;
  onChange: (v: SurfaceRef) => void;
}) {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const unit = effectiveUnits(settings.units, m?.units).distance;
  const decimals = settings.precision.distance;
  const shownOf = (levelM: number | undefined) =>
    levelM !== undefined ? fromSI(levelM, 'distance', unit).toFixed(decimals) : '';
  const [text, setText] = useState(shownOf(value.levelM));
  const [seen, setSeen] = useState(value.levelM);
  // a level set from outside (an undo, another picker) starts a fresh text
  if (seen !== value.levelM) {
    setSeen(value.levelM);
    if (
      Number(text) !== (value.levelM !== undefined ? fromSI(value.levelM, 'distance', unit) : NaN)
    )
      setText(shownOf(value.levelM));
  }
  return (
    <label className="bp-level">
      <span className="bp-level-name">{t('base.level')}</span>
      <input
        className="sv-input mono"
        type="number"
        step="0.001"
        aria-label={`${t('base.level')} (${unitLabel(unit)})`}
        data-testid="survey-ref-level"
        value={text}
        readOnly={readOnly}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v))
            onChange({ kind: 'reference', mode: 'level', levelM: toSI(v, 'distance', unit) });
        }}
      />
      <span className="bp-unit">{unitLabel(unit)}</span>
    </label>
  );
}
