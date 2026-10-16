import { Icon } from '@aio/ui';
import { useId, type ReactNode } from 'react';
import { useSections } from './sectionState';
import type { TabId } from './tabsModel';
import './section.css';

export interface SectionProps {
  id: string;
  bench: TabId;
  title: string;
  count?: number | undefined;
  /** Open when the user has not chosen (favourites, the live tool's family). */
  defaultOpen?: boolean | undefined;
  /** Open whatever is saved: the live tool's family, or a search with matches. */
  forceOpen?: boolean | undefined;
  children?: ReactNode;
}

/** A workbench section: a header row (chevron, title, count) over a body that folds away. */
export function Section({
  id,
  bench,
  title,
  count,
  defaultOpen,
  forceOpen,
  children,
}: SectionProps) {
  const sections = useSections(bench);
  const bodyId = useId();
  const open = forceOpen === true || sections.isOpen(id, defaultOpen);
  return (
    <section className="wb-section" data-open={open} data-testid={`wb-section-${id}`}>
      {/* a real button: click, Enter and Space all toggle */}
      <button
        type="button"
        className="wb-section-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          sections.toggle(id, defaultOpen);
        }}
      >
        <Icon name="chev-r" size={12} />
        <span className="wb-section-title">{title}</span>
        {count !== undefined && <span className="wb-section-count">{count}</span>}
      </button>
      <div className="wb-section-body" id={bodyId} inert={!open}>
        <div className="wb-section-inner">{children}</div>
      </div>
    </section>
  );
}
