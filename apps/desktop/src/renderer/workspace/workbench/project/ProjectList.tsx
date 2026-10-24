/**
 * The Project tab's "In this project" list, above the Measure tools: the caption (one click folds
 * the whole list, remembered per computer as section `project-contents` of bench `measure`), one
 * Section per registered content group that applies to the project (count 0 still shows), then
 * the TOOLS caption. A reveal (`revealInList`) holds the folded list open until its caption is
 * clicked; a tools-scroll request (`requestToolsScroll`, the island's Measure group) scrolls the
 * bench so the TOOLS caption is at the top, also when it was made before the list mounted.
 */
import { Icon, useT } from '@aio/ui';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Section } from '../Section';
import { useSections } from '../sectionState';
import { PROJECT_GROUPS, useOrderedGroups, type ProjectGroupDef } from './groupRegistry';
import { GROUP_DEFAULT_OPEN, groupSectionId } from './projectGroups';
import { useProjectList } from './projectListStore';
import { useRevealRow } from './useRevealRow';
import '../section.css';
import './rowList.css';

/** The whole list's fold, among the Project tab's sections. */
export const CONTENTS_SECTION = 'project-contents';

/** The last tools-scroll request a list has taken, so one made while none was mounted counts. */
let lastToolsSeq = 0;
/** The last reveal the caption has held open for (any group). */
let lastRevealSeq = 0;

function GroupSection({ def }: { def: ProjectGroupDef }): ReactElement {
  const t = useT();
  const count = def.useCount();
  // a static per group (the registry never changes), so the hook order holds
  const selected = def.useSelected ? def.useSelected() : null;
  const { host, forceOpen, release } = useRevealRow(def.id, selected);
  const { Body, Actions } = def;
  return (
    <div className="pl-group" onClickCapture={release}>
      <Section
        bench="measure"
        id={groupSectionId(def.id)}
        title={t(def.title)}
        count={count}
        defaultOpen={GROUP_DEFAULT_OPEN}
        forceOpen={forceOpen}
        actions={Actions ? <Actions /> : undefined}
      >
        <div ref={host} className="pl-body">
          <Body />
        </div>
      </Section>
    </div>
  );
}

/** Scroll the bench so the TOOLS caption is at its top. */
function scrollToTools(caption: HTMLElement): void {
  const scroller = caption.closest<HTMLElement>('.wb-scroll');
  if (!scroller) return;
  const offset = caption.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += offset;
}

export function ProjectList({
  groups = PROJECT_GROUPS,
}: {
  /** The registered groups (a test passes its own). */
  groups?: readonly ProjectGroupDef[];
}): ReactElement {
  const t = useT();
  const sections = useSections('measure');
  const ordered = useOrderedGroups(groups);
  const bodyId = useId();
  const tools = useRef<HTMLHeadingElement>(null);

  // a reveal while the list is folded holds it open (the fold itself is kept) until the caption
  const revealSeq = useProjectList((s) => s.reveal?.seq ?? 0);
  const [held, setHeld] = useState(false);
  const [seenReveal, setSeenReveal] = useState(() =>
    revealSeq > lastRevealSeq ? lastRevealSeq : revealSeq,
  );
  if (revealSeq !== 0 && revealSeq !== seenReveal) {
    setSeenReveal(revealSeq);
    setHeld(true);
  }
  useEffect(() => {
    lastRevealSeq = seenReveal;
  }, [seenReveal]);

  // a request made before this mount (the island opened the tab) is taken on mount
  const toolsSeq = useProjectList((s) => s.toolsSeq);
  useEffect(() => {
    if (toolsSeq <= lastToolsSeq) return;
    lastToolsSeq = toolsSeq;
    if (tools.current) scrollToTools(tools.current);
  }, [toolsSeq]);

  const saved = sections.isOpen(CONTENTS_SECTION, true);
  const open = held || saved;
  return (
    <div className="pl" data-testid="project-list">
      <section className="wb-section pl-contents" data-open={open}>
        <button
          type="button"
          className="wb-section-head pl-caption"
          data-testid="project-caption"
          aria-expanded={open}
          aria-controls={bodyId}
          title={t(open ? 'project.caption.fold' : 'project.caption.unfold')}
          onClick={() => {
            if (held) {
              // the hold ends and the list folds as the caption asks; a saved fold is kept
              setHeld(false);
              if (saved) sections.toggle(CONTENTS_SECTION, true);
              return;
            }
            sections.toggle(CONTENTS_SECTION, true);
          }}
        >
          <Icon name="chev-r" size={12} />
          <span className="caps">{t('project.caption')}</span>
        </button>
        <div className="wb-section-body" id={bodyId} inert={!open}>
          <div className="wb-section-inner pl-groups">
            {ordered.map((def) => (
              <GroupSection key={def.id} def={def} />
            ))}
          </div>
        </div>
      </section>
      <h3 ref={tools} className="pl-caption pl-tools caps" data-testid="project-tools-caption">
        {t('project.tools')}
      </h3>
    </div>
  );
}
