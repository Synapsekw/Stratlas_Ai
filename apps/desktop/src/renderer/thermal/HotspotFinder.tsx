/**
 * The Find hot spots row of the thermal bench: the button, "Looking for hot spots" while the job
 * runs, then how many possible hot spots it wrote for review in Inspect, or why it failed. Hidden
 * read-only; the button waits while any thermal job of the dataset runs.
 */
import { Button, useT } from '@aio/ui';
import type { ReactElement } from 'react';
import { useJobs } from '../shell';
import { HOTSPOT_PARAMS, useHotspotFinder } from './findHotspots';
import './hotspotFinder.css';

const RUNNING = new Set(['starting', 'running', 'cancelling']);
const THERMAL_JOBS = new Set(['thermal.decode', 'thermal.hotspots']);

export function HotspotFinder(p: {
  projectId: string;
  layerId: string;
  readOnly: boolean;
}): ReactElement | null {
  const t = useT();
  const find = useHotspotFinder((s) => (s.find?.layerId === p.layerId ? s.find : null));
  const run = useHotspotFinder((s) => s.run);
  const busy = useJobs((s) =>
    s.jobs.some(
      (j) =>
        THERMAL_JOBS.has(j.pipeline) && RUNNING.has(j.status) && j.params.layerId === p.layerId,
    ),
  );
  if (p.readOnly) return null;
  const running = find?.phase === 'running';
  return (
    <div className="th-find" data-testid="thermal-find-row">
      <Button
        data-testid="thermal-find"
        disabled={busy || running}
        onClick={() => {
          void run(p.projectId, p.layerId);
        }}
      >
        {t('thermal.find.run')}
      </Button>
      {running && (
        <p className="th-progress" role="status" data-testid="thermal-find-progress">
          <span className="th-progress-dot" aria-hidden="true" />
          {t('thermal.find.running')}
        </p>
      )}
      {find?.phase === 'done' && (
        <p className="th-note" role="status" data-testid="thermal-find-result">
          {find.count === null
            ? t('thermal.find.done')
            : find.count === 0
              ? t('thermal.find.none', { threshold: HOTSPOT_PARAMS.thresholdC })
              : t('thermal.find.found', { count: find.count })}
        </p>
      )}
      {find?.phase === 'error' && (
        <p className="th-note th-error" role="alert" data-testid="thermal-find-result">
          {find.error}
        </p>
      )}
    </div>
  );
}
