/**
 * The volume card's base picker (volumetric parity W3): one chip ("Base: Triangulated toe") that
 * opens the seven bases, each with its name and a one-line note on when to use it. "Previous
 * survey or design" opens the list of surveys and designs; a fixed level shows its level field
 * and a custom base its point editor (`BaseEditor`) under the chip.
 */
import { fromSI, toSI, unitLabel } from '@aio/geo';
import type { BaseSpec, SurfaceRef, SurveyMeasurement } from '@aio/schema';
import { customBase, effectiveUnits, sideFor, sideKey, type SideOption } from '@aio/survey';
import { arrowFocus, Icon, Popover, Row, useT } from '@aio/ui';
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { BaseEditor } from '../BaseEditor';
import { useMeasure } from '../measureStore';
import '../../charts/charts.css';
import '../compare.css';

import { BASES, baseIdOf, baseName, optionLabel, type BaseId } from './baseNames';

// the bases and their plain names live in one pure module, shared with the report
export {
  BASES,
  baseIdOf,
  baseName,
  missingName,
  optionLabel,
  OLDER_MODES,
  type BaseId,
} from './baseNames';

/** The default base of a new volume: a triangulated surface through the pile's toe. */
export const DEFAULT_BASE: BaseSpec = { kind: 'smart' };

/** The surveys and designs a base can be (never the current survey: that is what is measured). */
const surfaceChoices = (surfaces: readonly SideOption[]) =>
  surfaces.filter((o) => o.group !== 'Bases' && o.key !== 'current');

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
          {id === null && (
            <Row
              as="button"
              kind="menu"
              role="menuitemradio"
              aria-checked={true}
              selected
              className="bp-row"
              data-base="older"
              onClick={() => {
                setOpen(false);
              }}
              label={<RowText name={name} hint={null} on />}
            />
          )}
          {BASES.map((b) => {
            const on = b.id === id;
            const isSurface = b.id === 'surface';
            return (
              <div key={b.id} className="bp-entry">
                <Row
                  as="button"
                  kind="menu"
                  role="menuitemradio"
                  aria-checked={on}
                  {...(isSurface ? { 'aria-expanded': surfacesOpen } : {})}
                  className="bp-row"
                  data-base={b.id}
                  selected={on}
                  onClick={() => {
                    if (isSurface) setSurfacesOpen((x) => !x);
                    else pickBase(b.id);
                  }}
                  label={
                    <RowText
                      name={t(b.name)}
                      hint={t(b.hint)}
                      on={on}
                      {...(isSurface ? { open: surfacesOpen } : {})}
                    />
                  }
                />
                {isSurface && surfacesOpen && (
                  <div
                    role="group"
                    aria-label={t(b.name)}
                    className="bp-surfaces"
                    data-testid="bp-surfaces"
                  >
                    {choices.length === 0 && <p className="bp-none">{t('vol.card.noSurfaces')}</p>}
                    {choices.map((o) => (
                      <Row
                        key={o.key}
                        as="button"
                        kind="menu"
                        role="menuitemradio"
                        aria-checked={o.key === selectedKey}
                        className="bp-surface"
                        selected={o.key === selectedKey}
                        onClick={() => {
                          pick(sideFor(o, points, p.value));
                        }}
                        label={optionLabel(o)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Popover>
      <BaseFields value={p.value} m={p.m} readOnly={p.readOnly} onChange={change} />
    </>
  );
}

/**
 * A fixed level's field and a custom base's point editor, under whichever side holds the base
 * (the From picker, or the To chip of a comparison measured against a base).
 */
export function BaseFields(p: {
  value: BaseSpec | SurfaceRef;
  m: SurveyMeasurement | undefined;
  readOnly: boolean;
  onChange: (v: SurfaceRef) => void;
  testId?: string;
}): ReactElement | null {
  if (p.value.kind === 'reference' && p.value.mode === 'level')
    return (
      <LevelField
        value={p.value}
        m={p.m}
        readOnly={p.readOnly}
        onChange={p.onChange}
        testId={p.testId ?? 'survey-ref-level'}
      />
    );
  if (p.value.kind === 'custom' && p.m)
    return (
      <div className="bp-custom">
        <BaseEditor m={p.m} base={p.value} disabled={p.readOnly} onChange={p.onChange} />
      </div>
    );
  return null;
}

/** A base's row: the tick, its name and when to use it, and the chevron of the surface list. */
function RowText(p: { name: string; hint: string | null; on: boolean; open?: boolean }) {
  return (
    <span className="bp-line">
      <span className="menu-lead">{p.on && <Icon name="check" size={12} />}</span>
      <span className="bp-text">
        <span className="bp-name">{p.name}</span>
        {p.hint !== null && <span className="bp-hint">{p.hint}</span>}
      </span>
      {p.open !== undefined && <Icon name={p.open ? 'chevup' : 'chevdown'} size={12} />}
    </span>
  );
}

/** The typed floor height of a fixed level, in the site's distance unit. */
function LevelField({
  value,
  m,
  readOnly,
  onChange,
  testId,
}: {
  value: Extract<SurfaceRef, { kind: 'reference' }>;
  m: SurveyMeasurement | undefined;
  readOnly: boolean;
  onChange: (v: SurfaceRef) => void;
  testId: string;
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
        data-testid={testId}
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
