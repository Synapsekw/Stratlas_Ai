/**
 * The surfaces on a chart, as chips: press one to hide or show its line, × takes it off, and
 * "+ Add survey or design" offers the rest grouped as surveys, designs and the base. Each chip's
 * swatch is drawn in its line's style, so the chips double as the legend.
 */
import { seriesStyle, type ChartSeries, type SeriesKind } from '@aio/survey';
import { arrowFocus, Icon, Popover, useT } from '@aio/ui';
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import './charts.css';

export interface ChipOption {
  key: string;
  label: string;
  kind: SeriesKind;
  group: 'survey' | 'design' | 'base';
}

const GROUPS: readonly ChipOption['group'][] = ['survey', 'design', 'base'];

/** A short line sample in the series' stroke, dash and opacity. */
function Swatch({ option, all }: { option: ChipOption; all: readonly ChartSeries[] }) {
  const s = seriesStyle({ ...option, chainage: [], z: [] }, all);
  return (
    <svg className="pc-swatch" viewBox="0 0 16 8" aria-hidden="true">
      <line
        x1={1}
        x2={15}
        y1={4}
        y2={4}
        stroke={s.stroke}
        strokeWidth={s.width + 0.5}
        strokeOpacity={s.opacity}
        strokeDasharray={s.dash || undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SurfaceChips(p: {
  shown: readonly ChipOption[];
  off: ReadonlySet<string>;
  addable: readonly ChipOption[];
  onToggle(key: string): void;
  onAdd(key: string): void;
  onRemove(key: string): void;
  testId?: string;
}): ReactElement {
  const t = useT();
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const testId = p.testId ?? 'surface-chips';
  // the swatches of earlier dates shade by their order among the shown ones, as the lines do
  const all = p.shown.map((o) => ({ ...o, chainage: [], z: [] }));
  const groupLabel: Record<ChipOption['group'], string> = {
    survey: t('house.captures'),
    design: t('measureBench.siteDesigns'),
    base: t('chart.base'),
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (arrowFocus(e.currentTarget, e.key)) e.preventDefault();
  };
  return (
    <div className="pc-chips" data-testid={testId}>
      {p.shown.map((o) => {
        const on = !p.off.has(o.key);
        return (
          <span key={o.key} className="pc-chip" data-chip={o.key} data-on={on ? '' : undefined}>
            <button
              type="button"
              className="pc-chip-main"
              aria-pressed={on}
              onClick={() => {
                p.onToggle(o.key);
              }}
            >
              <Swatch option={o} all={all} />
              <span className="pc-chip-label">{o.label}</span>
            </button>
            {o.kind !== 'current' && (
              <button
                type="button"
                className="pc-chip-x"
                aria-label={t('review.remove', { name: o.label })}
                onClick={() => {
                  p.onRemove(o.key);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </span>
        );
      })}
      {p.addable.length > 0 && (
        <>
          <button
            ref={opener}
            type="button"
            className="pc-chip-add"
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid={`${testId}-add`}
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {t('chart.addSurface')}
          </button>
          <Popover
            open={open}
            onClose={() => {
              setOpen(false);
            }}
            opener={opener}
            anchor="below"
            className="menu-pop"
          >
            <div
              role="menu"
              aria-label={t('chart.addSurface')}
              className="menu-list pc-add-menu"
              onKeyDown={onMenuKey}
            >
              {GROUPS.map((g) => {
                const items = p.addable.filter((o) => o.group === g);
                if (items.length === 0) return null;
                return (
                  <div key={g} role="group" aria-label={groupLabel[g]} className="pc-add-group">
                    <div className="pc-add-head" aria-hidden="true">
                      {groupLabel[g]}
                    </div>
                    {items.map((o) => (
                      <button
                        key={o.key}
                        type="button"
                        role="menuitem"
                        className="row"
                        data-kind="menu"
                        onClick={() => {
                          setOpen(false);
                          p.onAdd(o.key);
                        }}
                      >
                        <span className="menu-lead">
                          <Swatch option={o} all={[...all, { ...o, chainage: [], z: [] }]} />
                        </span>
                        <span className="row-label">{o.label}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </Popover>
        </>
      )}
    </div>
  );
}
