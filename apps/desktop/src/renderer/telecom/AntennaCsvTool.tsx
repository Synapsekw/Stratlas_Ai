/**
 * The antenna inventory's CSV export, next to "Export survey data" in the Measure workbench's
 * Site data: a tool that opens a small panel with the drafts choice and the save. Shown once the
 * project has an inventory.
 */
import { Button, t } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import { bridge } from '../shell';
import { PopTool } from '../workspace/StageTools';
import { antennasToCsv } from './antennaCsv';
import { useAntennaClouds } from './AntennaRunner';
import { useAntennas } from './antennaStore';

export function AntennaCsvTool(): ReactElement | null {
  const file = useAntennas((a) => a.file);
  const hasCloud = useAntennaClouds().length > 0;
  const [drafts, setDrafts] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!file || !hasCloud) return null;

  const exportCsv = async () => {
    const r = await bridge.call('dialog:saveFile', {
      defaultName: 'antenna-inventory.csv',
      data: antennasToCsv(file, { includeDrafts: drafts }),
      title: t('telecom.antennas.csv'),
    });
    if (!r.ok) setNote(r.error);
    else if (r.value.error) setNote(r.value.error);
    else if (r.value.path !== null) setNote(t('telecom.antennas.csv.done', { path: r.value.path }));
  };

  return (
    <PopTool
      icon="report"
      label={t('telecom.antennas.csv.tool')}
      onOpenChange={() => {
        setNote(null);
      }}
    >
      <div className="telecom-csv" data-testid="antenna-csv-panel">
        <label className="telecom-check">
          <input
            type="checkbox"
            checked={drafts}
            onChange={(e) => {
              setDrafts(e.target.checked);
            }}
          />
          {t('telecom.antennas.csv.drafts')}
        </label>
        <Button
          data-testid="antenna-csv"
          onClick={() => {
            void exportCsv();
          }}
        >
          {t('telecom.antennas.csv')}
        </Button>
        {note && (
          <p className="telecom-help" role="status">
            {note}
          </p>
        )}
      </div>
    </PopTool>
  );
}
