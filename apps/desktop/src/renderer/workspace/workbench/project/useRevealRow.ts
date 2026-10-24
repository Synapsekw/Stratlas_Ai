/**
 * A revealed row in a group of the "In this project" list (`revealInList`): the group is held open
 * without changing the person's own fold, and the row scrolls into view once the fold has opened.
 * A reveal of a row holds the group while that row stays selected; a reveal with id null holds it
 * until the next reveal. A click on the group's header ends the hold and folds the group (a fold
 * the person asks for, so it is kept). A reveal made while the group was not mounted is honoured
 * when it mounts. The row is found by `data-row-id` inside the group's `.pl-rows` scroller, which
 * is scrolled by its own `scrollTop`, then the bench; never `scrollIntoView`, which would move
 * every scroller up to the window.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { useSections } from '../sectionState';
import { GROUP_DEFAULT_OPEN, groupSectionId, type GroupId } from './projectGroups';
import { useProjectList } from './projectListStore';

/** The longest a fold takes to open (section.css) before a revealed row scrolls anyway. */
const OPEN_FALLBACK_MS = 400;

/** The last reveal each group has taken (any instance), so one made while none was mounted counts. */
const lastSeen = new Map<GroupId, number>();

/** Scroll `scroller` by the least that brings `el` into its view. */
function nudge(scroller: HTMLElement, el: HTMLElement): void {
  const s = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < s.top) scroller.scrollTop -= s.top - r.top;
  else if (r.bottom > s.bottom) scroller.scrollTop += Math.min(r.bottom - s.bottom, r.top - s.top);
}

/** The row inside its group's scroller first, then the group in the bench. */
function scrollRow(section: HTMLElement, id: string): void {
  const row = [...section.querySelectorAll<HTMLElement>('[data-row-id]')].find(
    (el) => el.dataset.rowId === id,
  );
  if (!row) return;
  const rows = row.closest<HTMLElement>('.pl-rows');
  if (rows) nudge(rows, row);
  const bench = section.closest<HTMLElement>('.wb-scroll');
  if (bench) nudge(bench, row);
}

export interface RevealRow {
  /** Put on an element inside the group's body (it finds the section and the rows). */
  host: RefObject<HTMLDivElement | null>;
  /** The group Section's `forceOpen` while a reveal holds it. */
  forceOpen: true | undefined;
  /** An `onClickCapture` around the group's Section: a header click ends the hold and folds. */
  release: (e: MouseEvent) => void;
}

export function useRevealRow(group: GroupId, selected: string | null): RevealRow {
  const reveal = useProjectList((s) => (s.reveal?.group === group ? s.reveal : null));
  const host = useRef<HTMLDivElement>(null);
  const sections = useSections('measure');
  const now = reveal?.seq ?? 0;
  // the last reveal seen; one made before this mount counts as new
  const [seen, setSeen] = useState(() => {
    const last = lastSeen.get(group) ?? 0;
    return now > last ? last : now;
  });
  // what the reveal holds: its row while it stays selected (`from`: the selection when it came,
  // so a row selected just after its reveal is still held), or (id null) the group
  const [hold, setHold] = useState<{ id: string | null; from: string | null } | null>(null);
  if (reveal && reveal.seq !== seen) {
    setSeen(reveal.seq);
    setHold({ id: reveal.id, from: selected });
  } else if (hold !== null && hold.id !== null) {
    if (selected === hold.id) {
      if (hold.from !== hold.id) setHold({ id: hold.id, from: hold.id });
    } else if (selected !== hold.from) setHold(null);
  }
  useEffect(() => {
    lastSeen.set(group, seen);
  }, [group, seen]);

  // scroll the revealed row into view once the fold has opened (it animates from zero height)
  const rowId = hold?.id ?? null;
  const seq = rowId === null ? undefined : seen;
  useEffect(() => {
    if (seq === undefined || rowId === null) return;
    const section = host.current?.closest<HTMLElement>('.wb-section');
    const body = section?.querySelector<HTMLElement>(':scope > .wb-section-body');
    if (!section || !body) return;
    const scroll = () => {
      scrollRow(section, rowId);
    };
    if (host.current && host.current.getBoundingClientRect().height > 0) {
      // already open: after this commit has been laid out
      const frame = requestAnimationFrame(scroll);
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    // still folded: once the opening transition ends, with a fallback for reduced motion
    const done = () => {
      clearTimeout(timer);
      body.removeEventListener('transitionend', done);
      scroll();
    };
    const timer = setTimeout(done, OPEN_FALLBACK_MS);
    body.addEventListener('transitionend', done);
    return () => {
      clearTimeout(timer);
      body.removeEventListener('transitionend', done);
    };
  }, [seq, rowId]);

  // while a reveal holds the group open its header click would look dead: it ends the hold and
  // folds the group (not a header inside the body, nor the header's actions)
  const holding = hold !== null;
  const release = useCallback(
    (e: MouseEvent) => {
      if (!holding) return;
      const head = (e.target as Element).closest('.wb-section-head');
      const section = host.current?.closest('.wb-section');
      if (!head || !section || head.parentElement !== section) return;
      e.stopPropagation();
      setHold(null);
      const id = groupSectionId(group);
      if (sections.isOpen(id, GROUP_DEFAULT_OPEN)) sections.toggle(id, GROUP_DEFAULT_OPEN);
    },
    [holding, group, sections],
  );

  return { host, forceOpen: holding ? true : undefined, release };
}
