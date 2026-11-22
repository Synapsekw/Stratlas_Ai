/**
 * The Sectors group of the "In this project" list: the saved sectors of the RF plan, each with its
 * bearing and antenna count. A sector can be renamed in place, flown to, or opened in Coverage;
 * everything else about a sector is planned in Coverage. Saved sectors only: with no plan file the
 * group reads "Plan sectors in Coverage." and a rename of a plan with unsaved edits stays in the
 * working copy (`renameSector`). A line says so while Coverage holds unsaved changes.
 */
import type { RfSector } from '@aio/schema';
import { IconButton, Row, useT } from '@aio/ui';
import { useRef, useState, type ReactElement } from 'react';
import { sectorBearing } from '../../../../rf/rfFields';
import { renameSector, selectUnsavedChanges, useRf } from '../../../../rf/rfStore';
import { openRfTab } from '../../../../rf/rfTab';
import { formatAngle } from '../../../../telecom/antennaFormat';
import { requestFly, useAntennas } from '../../../../telecom/antennaStore';
import type { ProjectGroupDef } from '../groupRegistry';

const NONE: readonly RfSector[] = [];

function useSavedSectors(): readonly RfSector[] {
  return useRf((s) => (s.hasFile ? s.sectors.sectors : NONE));
}

/** The name as a field: Enter or leaving it keeps the name, Escape drops the edit. */
function RenameField(props: {
  name: string;
  label: string;
  onDone(name: string | null): void;
}): ReactElement {
  const [value, setValue] = useState(props.name);
  // Enter or Escape ends the edit, and the blur that follows must not end it again
  const finished = useRef(false);
  const finish = (name: string | null): void => {
    if (finished.current) return;
    finished.current = true;
    props.onDone(name);
  };
  return (
    <input
      type="text"
      className="pl-rename"
      aria-label={props.label}
      value={value}
      maxLength={40}
      autoFocus
      onChange={(e) => {
        setValue(e.target.value);
      }}
      onFocus={(e) => {
        e.currentTarget.select();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => {
        finish(value);
      }}
    />
  );
}

/** The sector's azimuth in the shared angle format; a value that rounds up to 360 reads 0. */
function azimuthText(deg: number): string {
  const d = ((deg % 360) + 360) % 360;
  return formatAngle(Math.round(d * 10) / 10 >= 360 ? 0 : d);
}

function SectorRow(props: {
  id: string;
  name: string;
  antennaIds: readonly string[];
}): ReactElement {
  const t = useT();
  const units = useRf((s) => s.antennas?.units);
  const readOnly = useRf((s) => s.readOnly);
  const [renaming, setRenaming] = useState(false);
  const bearing = sectorBearing(props.antennaIds, units ?? []);
  // the antennas of the sector that are still in the inventory: a deleted unit leaves its id behind
  const present = props.antennaIds.filter((id) => units?.some((u) => u.id === id) === true);
  const first = present[0] ?? props.antennaIds[0];
  const done = (name: string | null): void => {
    setRenaming(false);
    if (name !== null && name.trim() !== '' && name.trim() !== props.name) {
      void renameSector(props.id, name);
    }
  };
  return (
    <Row
      as="li"
      kind="tree"
      data-row-id={props.id}
      label={
        renaming ? (
          <RenameField name={props.name} label={t('project.sectors.rename')} onDone={done} />
        ) : (
          <>
            {props.name}{' '}
            <span className="mono">
              {bearing === null ? t('project.sectors.notMeasured') : azimuthText(bearing)}
            </span>
          </>
        )
      }
      count={t('project.sectors.antennas', { count: props.antennaIds.length })}
      actions={
        <>
          {readOnly ? null : (
            <IconButton
              icon="tag"
              label={t('project.sectors.rename')}
              onClick={() => {
                setRenaming(true);
              }}
            />
          )}
          <IconButton
            icon="crosshair"
            label={t('project.sectors.flyTo')}
            disabled={present.length === 0}
            {...(present.length === 0 ? { disabledReason: t('project.sectors.flyTo.gone') } : {})}
            onClick={() => {
              requestFly(present);
            }}
          />
          <IconButton
            icon="map"
            label={t('project.sectors.openCoverage')}
            onClick={() => {
              openRfTab(first);
            }}
          />
        </>
      }
    />
  );
}

function SectorsBody(): ReactElement {
  const t = useT();
  const sectors = useSavedSectors();
  const unsaved = useRf(selectUnsavedChanges);
  const note = unsaved ? <p className="pl-empty">{t('project.sectors.unsaved')}</p> : null;
  if (sectors.length === 0) {
    return (
      <>
        {note}
        <p className="pl-empty">{t('project.sectors.none')}</p>
      </>
    );
  }
  return (
    <>
      {note}
      <ul className="pl-rows">
        {sectors.map((s) => (
          <SectorRow key={s.id} id={s.id} name={s.name} antennaIds={s.antennaIds} />
        ))}
      </ul>
    </>
  );
}

/** Applies to a project with an antenna inventory or an RF plan file (Sectors and Coverage plan). */
export function useCoverageApplies(): boolean {
  const rf = useRf((s) => s.hasFile || s.antennas !== null);
  const inventory = useAntennas((s) => s.file !== null);
  return rf || inventory;
}

export const sectorsGroup: ProjectGroupDef = {
  id: 'sectors',
  title: 'project.group.sectors',
  useCount: () => useSavedSectors().length,
  useApplies: useCoverageApplies,
  Body: SectorsBody,
};
