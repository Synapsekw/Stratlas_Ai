/**
 * The Sectors group of the "In this project" list: the saved sectors of the RF plan, each with its
 * bearing and antenna count. A sector can be renamed in place, flown to, or opened in Coverage;
 * everything else about a sector is planned in Coverage. Saved sectors only: with no plan file the
 * group reads "Plan sectors in Coverage." and a rename of a plan with unsaved edits stays in the
 * working copy (`renameSavedSector`).
 */
import type { RfSector } from '@aio/schema';
import { IconButton, Row, useT } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import { sectorBearing } from '../../../../rf/rfFields';
import { renameSavedSector, useRf } from '../../../../rf/rfStore';
import { openRfTab } from '../../../../rf/rfTab';
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
        if (e.key === 'Enter') props.onDone(value);
        else if (e.key === 'Escape') props.onDone(null);
      }}
      onBlur={() => {
        props.onDone(value);
      }}
    />
  );
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
  const first = props.antennaIds[0];
  const done = (name: string | null): void => {
    setRenaming(false);
    if (name !== null && name.trim() !== '' && name.trim() !== props.name) {
      void renameSavedSector(props.id, name);
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
            <span className="mono">{bearing === null ? '—' : `${bearing.toFixed(0)}°`}</span>
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
            disabled={props.antennaIds.length === 0}
            onClick={() => {
              requestFly(props.antennaIds);
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
  if (sectors.length === 0) return <p className="pl-empty">{t('project.sectors.none')}</p>;
  return (
    <ul className="pl-rows">
      {sectors.map((s) => (
        <SectorRow key={s.id} id={s.id} name={s.name} antennaIds={s.antennaIds} />
      ))}
    </ul>
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
