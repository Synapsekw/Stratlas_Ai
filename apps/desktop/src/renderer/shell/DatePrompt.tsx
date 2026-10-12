import { defaultUtcOffsetMin } from '@aio/geo';
import { formatDate, useT } from '@aio/ui';
import { planFiling, useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { builder } from '../builder/state';
import { newSurveyDate } from '../change/SurveyDate';
import { useCaptureIndex } from '../workspace/compare';
import { datePromptPref, useDatePromptDone } from './datePromptPref';
import { moveLayersToDate, type MovedLayer } from './dateFolders';

export interface DatePromptNote {
  text: string;
  undo?: { moved: MovedLayer[]; target: string | null };
}

/**
 * The one-time offer to file the datasets that were recorded on survey days but sit in Every
 * date. Shown once per project on this machine; both answers end it.
 */
export function DatePrompt({
  canEdit,
  onResult,
}: {
  canEdit: boolean;
  onResult: (note: DatePromptNote) => void;
}) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const index = useCaptureIndex();
  const importing = useStore(builder, (s) => s.importing);
  const done = useDatePromptDone(project?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manifest = project?.manifest;
  const groups = useMemo(() => {
    if (!manifest || !index) return [];
    const epsg = 'epsg' in manifest.crs ? manifest.crs.epsg : 0;
    const offset = epsg === 0 ? 0 : defaultUtcOffsetMin(manifest.origin, epsg);
    return planFiling(manifest, index, offset);
  }, [manifest, index]);

  if (!project || !canEdit || importing || done || groups.length === 0) return null;
  const projectId = project.id;
  const count = groups.reduce((n, g) => n + g.layerIds.length, 0);

  const file = async () => {
    setBusy(true);
    setError(null);
    const moved: MovedLayer[] = [];
    let target: string | null = null;
    for (const g of groups) {
      let captureId = g.captureId;
      if (captureId === null) {
        const r = await newSurveyDate(g.day);
        if ('error' in r) {
          setError(r.error);
          setBusy(false);
          return;
        }
        captureId = r.captureId;
      }
      const r = await moveLayersToDate(g.layerIds, captureId);
      if (r.error) {
        setError(r.error);
        setBusy(false);
        return;
      }
      moved.push(...r.moved);
      target = captureId;
    }
    datePromptPref.getState().finish(projectId);
    setBusy(false);
    onResult({
      text: t('tree.datePrompt.done', { count }),
      ...(groups.length === 1 ? { undo: { moved, target } } : {}),
    });
  };

  return (
    <p className="dtree-note" role="status" data-testid="date-prompt">
      <span>{t('tree.datePrompt.title', { count })}</span>
      {groups.map((g) => (
        <span key={g.day} className="date-prompt-line">
          {t(g.captureId === null ? 'tree.datePrompt.new' : 'tree.datePrompt.existing', {
            count: g.layerIds.length,
            date: formatDate(g.day),
          })}
        </span>
      ))}
      {error ? <span role="alert">{error}</span> : null}
      <button
        type="button"
        className="btn"
        data-testid="date-prompt-file"
        disabled={busy}
        onClick={() => void file()}
      >
        {t('tree.datePrompt.file')}
      </button>
      <button
        type="button"
        className="btn"
        data-testid="date-prompt-later"
        disabled={busy}
        onClick={() => {
          datePromptPref.getState().finish(projectId);
        }}
      >
        {t('tree.datePrompt.later')}
      </button>
    </p>
  );
}
