/**
 * The antenna inventory as a section of the Measure workbench: the run's warnings, the units by
 * kind and the selected unit's details. A unit picked in the 3D view holds the section open while
 * it stays selected (without changing the person's own fold) and its row scrolls into view once
 * the section has opened. A search shows the section only when its title matches. Why the AI
 * labelling was skipped shows above the section, so no fold hides it. The boxes, the
 * inventory read and the AI send preview are `AntennaRunner`'s; the "Detect antennas" button is in
 * the Telecom family (`survey/DetectAntennas.tsx`), the CSV export next to "Export survey data"
 * (`AntennaCsvTool.tsx`).
 */
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { openPhoto } from '../builder/photoOpen';
import { Section } from '../workspace/workbench/Section';
import { AntennaDetails } from './AntennaDetails';
import { AntennaInventory } from './AntennaInventory';
import { useAntennaClouds } from './AntennaRunner';
import {
  patchUnitUser,
  selectAntenna,
  setUnitStatus,
  toggleAntennaHidden,
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
  // the pick being revealed: held open while its unit stays selected
  const [revealing, setRevealing] = useState<{ seq: number; id: string } | null>(null);
  if (s.reveal !== 0 && (revealing?.seq ?? 0) < s.reveal && s.selected !== null)
    setRevealing({ seq: s.reveal, id: s.selected });
  else if (revealing && s.selected !== revealing.id) setRevealing(null);

  // scroll the revealed row into view once the fold has opened (it animates from zero height)
  const seq = revealing?.seq;
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

  const selected = file?.units.find((u) => u.id === s.selected);
  const aiProvider = selected?.ai?.provider;
  const listed = file?.units.filter((u) => u.status !== 'rejected').length ?? 0;

  return (
    <>
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
        forceOpen={searching || revealing !== null ? true : undefined}
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
            readOnly={s.readOnly}
            onSelect={selectAntenna}
            onToggleVisible={toggleAntennaHidden}
            onSetStatus={(id, status) => {
              void setUnitStatus(id, status);
            }}
            onOpenDetails={selectAntenna}
          />
          {selected && (
            <AntennaDetails
              key={selected.id}
              unit={selected}
              projectId={projectId}
              readOnly={s.readOnly}
              {...(aiProvider !== undefined ? { aiProvider } : {})}
              onSetStatus={(status) => {
                void setUnitStatus(selected.id, status);
              }}
              onPatchUser={(fields) => {
                void patchUnitUser(selected.id, fields);
              }}
              onOpenPhoto={openPhoto}
            />
          )}
        </div>
      </Section>
    </>
  );
}
