/**
 * A right-panel tab's sections (D2): a scrolling list, each section a header over its body. A
 * section shows when the project holds its data or its tool is open, never because of the
 * project type; its body mounts only while it is open. A wide tool's header offers "Expand panel".
 */
import { Icon, IconButton, useT } from '@aio/ui';
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { FlightlineSection } from '../../../flyability/FlightlineSection';
import { SiteDigest } from '../../../insights/SiteDigest';
import { useIsRoad } from '../../../road/useRoadMap';
import { FrontBody } from '../FrontBody';
import { usePanelData } from '../panelData';
import { ProjectList } from '../project/ProjectList';
import { useLayout } from '../../../layout/useApplyPreset';
import { leadWith, sectionsOf, type PanelTab, type SectionDef } from '../tabsModel';
import { useWorkbench, workbench } from '../workbenchStore';
import { revealSection } from './revealSection';

/** The number beside a section's name, where one helps: open issues, piles. */
function useSectionCount(def: SectionDef): number | undefined {
  const issues = useWorkspace((s) =>
    def.id === 'project.issues' ? s.issues.filter((i) => i.status !== 'closed').length : 0,
  );
  const piles = useVolumetric((s) => (def.id === 'project.volumes' ? s.piles.length : 0));
  if (def.id === 'project.issues') return issues;
  if (def.id === 'project.volumes' && piles > 0) return piles;
  return undefined;
}

function SectionBody({ def, lead }: { def: SectionDef; lead?: ReactNode }) {
  const road = useIsRoad();
  if (lead !== undefined)
    return (
      <>
        {lead}
        {def.body !== null && <FrontBody front={def.body} road={road} />}
      </>
    );
  if (def.id === 'project.digest') return <SiteDigest />;
  if (def.id === 'layers.flightlines') return <FlightlineSection />;
  if (def.id === 'project.inThisProject') return <ProjectList />;
  if (def.body === null) return null;
  return <FrontBody front={def.body} road={road} />;
}

/**
 * A section: its header and, open, its body. `lead` goes above the body (the Tools tab's
 * registry tools and switches, W8).
 */
export function PanelSection({ def, lead }: { def: SectionDef; lead?: ReactNode }) {
  const t = useT();
  const bodyId = useId();
  const open = useWorkbench((s) => s.sections[def.id] === true);
  const live = useWorkbench((s) => s.tabs.some((x) => x.id === def.body && x.live));
  const expanded = useWorkbench((s) => s.expanded);
  const count = useSectionCount(def);
  const wide = def.wide === true && open;
  // brought forward (its body in front and the section open): scrolled into the tab's box
  const ref = useRef<HTMLElement>(null);
  const forward = useWorkbench((s) => def.body !== null && s.front === def.body) && open;
  useEffect(() => {
    if (forward) revealSection(ref.current);
  }, [forward]);
  return (
    <section
      ref={ref}
      className="wb-section wb-psec"
      data-open={open}
      data-section={def.id}
      data-body={def.body ?? undefined}
      data-actions={wide ? '' : undefined}
      data-testid={`panel-section-${def.id}`}
    >
      <button
        type="button"
        className="wb-section-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          workbench.getState().toggleSection(def.id);
        }}
      >
        <Icon name="chev-r" size={12} />
        <span className="wb-section-title">{t(def.label)}</span>
        {live && (
          <span className="tab-live" role="img" aria-label={t('tabs.live')}>
            <i />
          </span>
        )}
        {count !== undefined && <span className="wb-section-count">{count}</span>}
      </button>
      {wide && (
        <div className="wb-section-actions">
          <IconButton
            icon="maximize"
            pressed={expanded}
            label={expanded ? t('wb.restoreWidth') : t('wb.expandPanel')}
            data-testid="panel-expand"
            onClick={() => {
              workbench.getState().expand(!expanded);
            }}
          />
        </div>
      )}
      <div className="wb-section-body" id={bodyId} inert={!open}>
        <div className="wb-section-inner wb-psec-inner" data-front={def.body ?? undefined}>
          {open ? <SectionBody def={def} lead={lead} /> : null}
        </div>
      </div>
    </section>
  );
}

/** Every section a tab shows for this project, in the tab's order. */
export function PanelSections({
  tab,
  foot,
}: {
  tab: Exclude<PanelTab, 'selection'>;
  /** Below the last section (Layers & display's Reset layout). */
  foot?: ReactNode;
}) {
  const data = usePanelData();
  const tabs = useWorkbench((s) => s.tabs);
  // a tool's body opened (not the fixed bodies, always in the store: Volumes, Changes)
  const opened = useMemo(() => new Set(tabs.filter((x) => !x.fixed).map((x) => x.id)), [tabs]);
  // Project's sections: the project type's lead, the rest in the tab's order (D7)
  const lead = useLayout()?.layout.projectSections;
  const defs = useMemo(
    () => leadWith(sectionsOf(tab, data, opened), tab === 'project' ? lead : undefined),
    [tab, data, opened, lead],
  );
  return (
    <div className="wb-sections" data-testid={`panel-sections-${tab}`}>
      {defs.map((def) => (
        <PanelSection key={def.id} def={def} />
      ))}
      {foot}
    </div>
  );
}
