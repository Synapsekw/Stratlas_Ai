/**
 * Tools (D2, D3; UI revision W8): the tool registry's groups as sections, in its order (a preset's
 * order first, W13), each with its tools as rows, its switches, then its bench (Measure's
 * catalogue, Annotate, Point cloud, Terrain analysis, Survey checks, Video, Engineering, Coverage,
 * Thermal, Environment). While a measuring tool is armed the list gives way to the tool's card
 * with "Back to tools"; Escape (the tool's Stop) returns to the list too.
 */
import { Button, Icon, useT } from '@aio/ui';
import { useEffect, useMemo, useRef } from 'react';
import { stopTool, useMeasure } from '../../../survey/measureStore';
import { GROUPS, toolsFor, type ToolGroup } from '../../../tools/registry';
import { ToolRows } from '../../../tools/ToolRows';
import { useToolCtx } from '../../../tools/useToolCtx';
import '../../../tools/tools.css';
import { GroupControls } from '../../island/groups';
import { usePanelData } from '../panelData';
import { sectionDef, sectionsOf, type SectionDef } from '../tabsModel';
import { useWorkbench } from '../workbenchStore';
import { PanelSection } from './PanelSections';

/**
 * The armed tool's card in place of the list, with the way back to it: Measure's section alone,
 * whose bench is the live card while a tool draws (`MeasureBench`).
 */
function ArmedTool() {
  const t = useT();
  const measure = sectionDef('tools.measure');
  const ref = useRef<HTMLDivElement>(null);
  // started from a row the card took away: the focus goes to the way back, not lost
  useEffect(() => {
    const at = document.activeElement;
    if (at === null || at === document.body)
      ref.current?.querySelector<HTMLElement>('[data-testid="tools-back"]')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className="tools-armed"
      data-testid="tools-armed"
      onKeyDown={(e) => {
        // Esc in the card puts the tool down, as on the stage: the list comes back
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        stopTool();
      }}
    >
      <Button
        variant="quiet"
        size="sm"
        className="tools-back"
        data-testid="tools-back"
        onClick={() => {
          stopTool();
        }}
      >
        <Icon name="back" size={14} />
        {t('toolReg.back')}
      </Button>
      <div className="wb-sections" data-testid="panel-sections-tools">
        {measure && <PanelSection def={measure} />}
      </div>
    </div>
  );
}

/** The groups whose bench lists their tools itself: the registry's rows would repeat them. */
const OWN_LIST: ReadonlySet<ToolGroup> = new Set(['measure', 'annotate']);

/** Every group the project offers as a section, its tools first. */
function ToolList({ order }: { order?: readonly ToolGroup[] }) {
  const ctx = useToolCtx();
  const data = usePanelData();
  const tabs = useWorkbench((s) => s.tabs);
  // a tool's body opened (not the fixed bodies): its section shows even without the data
  const opened = useMemo(() => new Set(tabs.filter((x) => !x.fixed).map((x) => x.id)), [tabs]);
  const groups = toolsFor(ctx, order);
  const shown = sectionsOf('tools', data, opened);
  const listed = new Set(groups.map((g) => GROUPS[g.group].section));
  const rows: { def: SectionDef; group: ToolGroup | null }[] = [
    ...groups.flatMap((g) => {
      const def = sectionDef(GROUPS[g.group].section);
      return def ? [{ def, group: g.group }] : [];
    }),
    // a tool's section opened without its data (a Coverage plan opened from its chip)
    ...shown.filter((d) => !listed.has(d.id)).map((def) => ({ def, group: null })),
  ];
  return (
    <div className="wb-sections" data-testid="panel-sections-tools">
      {rows.map(({ def, group }) => {
        const tools = group ? (groups.find((g) => g.group === group)?.tools ?? []) : [];
        // Measure's catalogue and Annotate's toolbar list their tools themselves
        const lead =
          group === null ? undefined : (
            <>
              {!OWN_LIST.has(group) && <ToolRows tools={tools} ctx={ctx} />}
              <GroupControls group={group} stage={ctx.stage} mode={ctx.mode} />
            </>
          );
        return <PanelSection key={def.id} def={def} lead={lead} />;
      })}
    </div>
  );
}

export function ToolsTab() {
  const armed = useMeasure((s) => s.tool !== null && s.draw !== null);
  return armed ? <ArmedTool /> : <ToolList />;
}
