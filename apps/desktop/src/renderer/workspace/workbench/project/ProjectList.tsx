/**
 * Project > In this project (UI revision D2): one Section per registered content group that
 * applies to the project (count 0 still shows). The tab's section header is its fold; a reveal
 * (`revealInList`) opens and scrolls to its row.
 */
import { useT } from '@aio/ui';
import type { ReactElement } from 'react';
import { Section } from '../Section';
import { PROJECT_GROUPS, useOrderedGroups, type ProjectGroupDef } from './groupRegistry';
import { GROUP_DEFAULT_OPEN, groupSectionId } from './projectGroups';
import { useRevealRow } from './useRevealRow';
import '../section.css';
import './rowList.css';

function GroupSection({ def }: { def: ProjectGroupDef }): ReactElement {
  const t = useT();
  const count = def.useCount();
  // a static per group (the registry never changes), so the hook order holds
  const selected = def.useSelected ? def.useSelected() : null;
  const defaultOpen = def.defaultOpen ?? GROUP_DEFAULT_OPEN;
  const { host, forceOpen, release } = useRevealRow(def.id, selected, defaultOpen);
  const { Body, Actions } = def;
  return (
    <div className="pl-group" onClickCapture={release}>
      <Section
        bench="measure"
        id={groupSectionId(def.id)}
        title={t(def.title)}
        count={count}
        defaultOpen={defaultOpen}
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

export function ProjectList({
  groups = PROJECT_GROUPS,
}: {
  /** The registered groups (a test passes its own). */
  groups?: readonly ProjectGroupDef[];
}): ReactElement {
  const ordered = useOrderedGroups(groups);
  return (
    <div className="pl pl-groups" data-testid="project-list">
      {ordered.map((def) => (
        <GroupSection key={def.id} def={def} />
      ))}
    </div>
  );
}
