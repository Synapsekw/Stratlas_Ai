/**
 * The Antennas group of the Project tab's "In this project" list (`project/groupRegistry.ts`):
 * why the last action failed (a delete, a save, a flag), "Which one is the tower?" while a detection
 * waits for a click on the tower, the run's warnings, why the AI labelling was skipped and the Flag
 * antenna tool above the rows, then the list (filter chips, editable rows,
 * the selected unit's details inline, Detect antennas when it is empty) and the bulk bar. The
 * header carries the eye (Hide all / Show all) and Flag antenna; the group opens whenever the flag
 * tool is on (Flag antenna, Redraw outline from any route), so the tool is always on screen. It
 * applies to a project with a point cloud and a list or a detection run; its count is the units not
 * rejected. The list holds it open for a revealed row (`revealInList`) and scrolls the row into
 * view, so this group never calls `useRevealRow` itself. The boxes, the list's read and the AI send
 * preview are `AntennaRunner`'s; "Detect antennas" is also in the Telecom tools
 * (`survey/DetectAntennas.tsx`), the CSV export next to "Export survey data".
 */
import { Button, IconButton, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, type ReactElement } from 'react';
import type { ProjectGroupDef } from '../workspace/workbench/project/groupRegistry';
import { GROUP_DEFAULT_OPEN, groupSectionId } from '../workspace/workbench/project/projectGroups';
import { useSections } from '../workspace/workbench/sectionState';
import { AntennaBulkBar } from './AntennaBulkBar';
import { AntennaFlagTool } from './AntennaFlagTool';
import { AntennaInventory } from './AntennaInventory';
import { useAntennaClouds } from './AntennaRunner';
import { AntennaTowerHint } from './AntennaTowerHint';
import {
  beginFlag,
  hideAllAntennas,
  selectAntenna,
  setAntennaFilter,
  showAllAntennas,
  toggleTicked,
  useAntennas,
} from './antennaStore';
import './antennaGroup.css';

/** The old section's show rule: a project, a cloud, and an inventory, a run, or a read done. */
function useApplies(): boolean {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const hasCloud = useAntennaClouds().length > 0;
  const shown = useAntennas((s) => s.file !== null || s.running || s.status === 'ready');
  return projectId !== null && hasCloud && shown;
}

function useCount(): number {
  return useAntennas((s) => s.file?.units.filter((u) => u.status !== 'rejected').length ?? 0);
}

function useSelected(): string | null {
  return useAntennas((s) => s.selected);
}

/** Why Flag antenna cannot start now, or null. */
function useFlagReason(): string | null {
  return useAntennas((s) =>
    !s.file
      ? t('telecom.antennas.flag.needsRun')
      : s.readOnly
        ? t('telecom.antennas.readOnly')
        : s.running
          ? t('telecom.antennas.running')
          : s.flagStarting || s.flagJob
            ? t('telecom.antennas.flag.busy')
            : null,
  );
}

/** The header's eye (Hide all while any unit shows, else Show all) and Flag antenna. */
function Actions(): ReactElement {
  const allHidden = useAntennas(
    (s) => (s.file?.units.length ?? 0) > 0 && (s.file?.units.every((u) => s.hidden[u.id]) ?? false),
  );
  const reason = useFlagReason();
  const sections = useSections('measure');
  const flagging = useAntennas((s) => s.flagging !== null);
  const id = groupSectionId('antennas');
  const folded = !sections.isOpen(id, GROUP_DEFAULT_OPEN);
  // the tool shows above the rows: a folded group opens, as the person asked for the tool
  useEffect(() => {
    if (flagging && folded) sections.toggle(id, GROUP_DEFAULT_OPEN);
  }, [flagging, folded, sections, id]);
  return (
    <>
      {allHidden ? (
        <IconButton
          icon="eye-off"
          label={t('telecom.antennas.showAll')}
          data-testid="antenna-show-all"
          onClick={showAllAntennas}
        />
      ) : (
        <IconButton
          icon="eye"
          label={t('telecom.antennas.hideAll')}
          data-testid="antenna-hide-all"
          onClick={hideAllAntennas}
        />
      )}
      <Button
        size="sm"
        variant="quiet"
        icon="flag"
        data-testid="antenna-flag"
        tip={t('telecom.antennas.flag.tip')}
        {...(reason ? { disabledReason: reason } : {})}
        onClick={() => {
          beginFlag();
        }}
      >
        {t('telecom.antennas.flag.button')}
      </Button>
    </>
  );
}

function Body(): ReactElement {
  const s = useAntennas((a) => a);
  const file = s.file;
  return (
    <div
      role="region"
      className="antenna-group"
      data-testid="antenna-panel"
      aria-label={t('telecom.antennas.title')}
    >
      {s.message && (
        // a failed delete, save or flag says why here, where the action was
        <p className="telecom-help telecom-note" role="status" data-testid="antenna-group-message">
          {s.message}
        </p>
      )}
      {/* "Which one is the tower?" where Detect antennas was pressed; the click is taken once */}
      <AntennaTowerHint />
      {s.aiNote !== null && (
        <p className="telecom-help telecom-note" role="status" data-testid="antenna-ai-note">
          {t('telecom.antennas.ai.skipped', { reason: s.aiNote })}
        </p>
      )}
      {file && file.run.warnings.length > 0 && (
        <div className="antenna-warnings">
          <b>{t('telecom.antennas.warnings')}</b>
          <ul>
            {file.run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {s.flagging !== null && <AntennaFlagTool key={s.flagging.unit ?? ''} />}
      <AntennaInventory
        file={file}
        selected={s.selected}
        ticked={s.ticked}
        hidden={s.hidden}
        solo={s.solo}
        filter={s.filter}
        readOnly={s.readOnly}
        note={s.note}
        onSelect={selectAntenna}
        onTick={toggleTicked}
        onFilter={setAntennaFilter}
      />
      <AntennaBulkBar />
    </div>
  );
}

export const antennasGroup: ProjectGroupDef = {
  id: 'antennas',
  title: 'project.group.antennas',
  useCount,
  useApplies,
  useSelected,
  Body,
  Actions,
};
