/**
 * The Measurements group of the "In this project" list: every measurement of the file by name with
 * its tool and primary value. A click selects it (the same `measureStore.focus` the left tree and a
 * pick in 3D use); the focused one shows its `MeasurementPanel` inline under its row, in
 * `survey-side`, so there is one panel for a measurement. Right-click gives the registered
 * measurement actions (`MeasureMenu`). The list holds the group open for a revealed row
 * (`useRevealRow`, called by the list), so the Body never calls it. The open panel counts beside
 * the eight rows (`--pl-details-h`), as the antenna details do.
 */
import type { SurveyMeasurement } from '@aio/schema';
import { sortMeasurements, TOOL_LABELS } from '@aio/survey';
import { EmptyState, Row, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { TOOL_ICON } from '../../../../survey/card';
import { primaryText } from '../../../../survey/card/cardModel';
import { MeasureMenu } from '../../../../survey/MeasureMenu';
import type { MeasureMenuAt } from '../../../../survey/measurePick';
import { knownTemplates, select, useMeasure } from '../../../../survey/measureStore';
import { MeasurementPanel } from '../../../../survey/MeasurementPanel';
import type { ProjectGroupDef } from '../groupRegistry';
import './groups.css';

/** The open panel's height, measured, so the rows' scroller holds eight rows beside it. */
function usePanelHeight(open: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setHeight(0);
      return;
    }
    const measure = () => {
      setHeight(el.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [open]);
  return { ref, height };
}

function useCount(): number {
  return useMeasure((s) => s.file.measurements.length);
}

function useFocused(): string | null {
  return useMeasure((s) => s.focus);
}

function Body(): ReactElement {
  const t = useT();
  const list = useMeasure((s) => s.file.measurements);
  const focus = useMeasure((s) => s.focus);
  const selected = useMeasure((s) => s.selected);
  const settings = useMeasure((s) => s.settings);
  const templates = useMeasure((s) => s.templates);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const [menu, setMenu] = useState<MeasureMenuAt | null>(null);
  const sorted = useMemo(() => sortMeasurements(list, 'name'), [list]);
  const all = useMemo(() => knownTemplates({ templates, settings }), [templates, settings]);
  const value = (m: SurveyMeasurement) => primaryText(m, { settings, templates: all });
  const open = sorted.some((m) => m.id === focus) ? focus : null;
  const panel = usePanelHeight(open);
  if (sorted.length === 0) return <EmptyState title={t('project.measurements.none')} />;
  return (
    <>
      <ul
        className="pl-rows pl-measure-rows"
        data-testid="project-measurements"
        style={{ '--pl-details-h': `${String(panel.height)}px` } as CSSProperties}
      >
        {sorted.map((m) => (
          <li key={m.id} data-row-id={m.id}>
            <Row
              kind="tree"
              icon={TOOL_ICON[m.tool]}
              label={
                <>
                  {m.label}
                  <span className="pl-row-sub">{TOOL_LABELS[m.tool]}</span>
                </>
              }
              {...(value(m) ? { count: value(m) } : {})}
              selected={selected.includes(m.id) || focus === m.id}
              aria-current={focus === m.id ? 'true' : undefined}
              data-testid="project-measurement-row"
              tabIndex={0}
              onClick={() => {
                select([m.id], m.id);
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  select([m.id], m.id);
                }
              }}
              onContextMenu={(e) => {
                if (!projectId) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: m.id, projectId });
              }}
            />
            {open === m.id ? (
              <div ref={panel.ref} className="pl-measure-panel" data-testid="survey-side">
                <MeasurementPanel />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <MeasureMenu
        at={menu}
        onClose={() => {
          setMenu(null);
        }}
      />
    </>
  );
}

export const measurementsGroup: ProjectGroupDef = {
  id: 'measurements',
  title: 'project.group.measurements',
  useCount,
  useApplies: () => true,
  useSelected: useFocused,
  Body,
};
