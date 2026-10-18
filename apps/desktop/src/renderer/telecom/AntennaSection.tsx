/**
 * The antenna inventory as a section of the Measure workbench: the run's warnings, the units by
 * kind and the selected unit's details. A unit picked in the 3D view holds the section open while
 * it stays selected (without changing the person's own fold) and its row scrolls into view once
 * the section has opened; a click on the header ends the hold and folds it. A search shows the section only when its title matches. Why the AI
 * labelling was skipped shows above the section, so no fold hides it. The boxes, the
 * inventory read and the AI send preview are `AntennaRunner`'s; the "Detect antennas" button is in
 * the Telecom family (`survey/DetectAntennas.tsx`), the CSV export next to "Export survey data"
 * (`AntennaCsvTool.tsx`).
 */
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import { Section } from '../workspace/workbench/Section';
import { useSections } from '../workspace/workbench/sectionState';
import { AntennaInventory } from './AntennaInventory';
import { useAntennaClouds } from './AntennaRunner';
import {
  hideAllAntennas,
  selectAntenna,
  setAntennaFilter,
  setAntennaSolo,
  showAllAntennas,
  toggleAntennaHidden,
  toggleGroupHidden,
  useAntennas,
} from './antennaStore';

const BENCH = 'measure';
const SECTION = 'telecom-antennas';
/** The longest a fold takes to open (section.css) before a revealed row scrolls anyway. */
const OPEN_FALLBACK_MS = 400;

/** Whether the inventory section is shown for a search (its title matches) or without one. */
export function antennaSectionMatches(query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || t('telecom.antennas.title').toLowerCase().includes(q);
}

export function AntennaSection({ query = '' }: { query?: string }): ReactElement | null {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const s = useAntennas((a) => a);
  const hasCloud = useAntennaClouds().length > 0;
  const host = useRef<HTMLDivElement>(null);
  const sections = useSections(BENCH);
  // the last pick seen, and the unit it holds open while that unit stays selected
  const [seen, setSeen] = useState(s.reveal);
  const [hold, setHold] = useState<string | null>(null);
  if (s.reveal !== seen) {
    setSeen(s.reveal);
    setHold(s.selected);
  } else if (hold !== null && s.selected !== hold) setHold(null);

  // scroll the revealed row into view once the fold has opened (it animates from zero height)
  const seq = hold === null ? undefined : seen;
  useEffect(() => {
    if (seq === undefined) return;
    const section = host.current?.closest<HTMLElement>('.wb-section');
    const body = section?.querySelector<HTMLElement>('.wb-section-body');
    if (!section || !body) return;
    const scroll = () => {
      const row = section.querySelector('[role="treeitem"][aria-selected="true"]');
      (row as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
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
  }, [seq]);

  const file = s.file;
  if (!projectId || !hasCloud || (file === null && !s.running)) return null;
  if (!antennaSectionMatches(query)) return null;
  const searching = query.trim() !== '';

  const listed = file?.units.filter((u) => u.status !== 'rejected').length ?? 0;

  // while a pick holds the section open its header click would look dead: it ends the hold and
  // folds the section (a fold the person asks for, so it is kept)
  const releaseOnHead = (e: MouseEvent) => {
    if (hold === null || !(e.target as Element).closest('.wb-section-head')) return;
    e.stopPropagation();
    setHold(null);
    if (sections.isOpen(SECTION, true)) sections.toggle(SECTION, true);
  };

  return (
    <div className="telecom-section" onClickCapture={releaseOnHead}>
      {s.aiNote !== null && (
        <p className="telecom-help telecom-note" role="status" data-testid="antenna-ai-note">
          {t('telecom.antennas.ai.skipped', { reason: s.aiNote })}
        </p>
      )}
      <Section
        bench={BENCH}
        id={SECTION}
        title={t('telecom.antennas.title')}
        count={listed}
        defaultOpen
        forceOpen={searching || hold !== null ? true : undefined}
      >
        <div
          ref={host}
          role="region"
          data-testid="antenna-panel"
          aria-label={t('telecom.antennas.title')}
        >
          {file && file.run.warnings.length > 0 && (
            <div>
              <b>{t('telecom.antennas.warnings')}</b>
              <ul>
                {file.run.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <AntennaInventory
            file={file}
            selected={s.selected}
            hidden={s.hidden}
            solo={s.solo}
            filter={s.filter}
            readOnly={s.readOnly}
            onSelect={selectAntenna}
            onToggleVisible={toggleAntennaHidden}
            onToggleGroup={toggleGroupHidden}
            onSolo={setAntennaSolo}
            onFilter={setAntennaFilter}
            onHideAll={hideAllAntennas}
            onShowAll={showAllAntennas}
            note={s.note}
          />
        </div>
      </Section>
    </div>
  );
}
