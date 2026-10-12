import { defaultUtcOffsetMin } from '@aio/geo';
import { formatDate, useT } from '@aio/ui';
import { planFiling, useWorkspace, workspace } from '@aio/workspace';
import { Fragment, useMemo, useState } from 'react';
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
  // keyed by project id, so a project switch drops a busy flag or an error of the old one
  const [attempt, setAttempt] = useState<{
    pid: string;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const manifest = project?.manifest;
  const groups = useMemo(() => {
    if (!manifest || !index) return [];
    const epsg = 'epsg' in manifest.crs ? manifest.crs.epsg : 0;
    const offset = epsg === 0 ? 0 : defaultUtcOffsetMin(manifest.origin, epsg);
    return planFiling(manifest, index, offset);
  }, [manifest, index]);

  if (!project || !canEdit || importing || done || groups.length === 0) return null;
  const projectId = project.id;
  const mine = attempt?.pid === projectId ? attempt : null;
  const busy = mine?.busy ?? false;
  const error = mine?.error ?? null;
  const count = groups.reduce((n, g) => n + g.layerIds.length, 0);
  // a project switch mid-filing drops this attempt, so the buttons are free if the project comes back
  const stillOpen = () => {
    if (workspace.getState().project?.id === projectId) return true;
    setAttempt((a) => (a?.pid === projectId ? null : a));
    return false;
  };

  const file = async () => {
    setAttempt({ pid: projectId, busy: true, error: null });
    const fail = (message: string) => {
      setAttempt({ pid: projectId, busy: false, error: message });
    };
    const moved: MovedLayer[] = [];
    let target: string | null = null;
    for (const g of groups) {
      let captureId = g.captureId;
      if (captureId === null) {
        const r = await newSurveyDate(g.day);
        if (!stillOpen()) return;
        if ('error' in r) {
          fail(r.error);
          return;
        }
        captureId = r.captureId;
      }
      const r = await moveLayersToDate(g.layerIds, captureId);
      if (!stillOpen()) return;
      if (r.error) {
        fail(r.error);
        return;
      }
      moved.push(...r.moved);
      target = captureId;
    }
    datePromptPref.getState().finish(projectId);
    setAttempt(null);
    if (moved.length === 0) return;
    onResult({
      text: t('tree.datePrompt.done', { count: moved.length }),
      ...(groups.length === 1 ? { undo: { moved, target } } : {}),
    });
  };

  return (
    <p className="dtree-note date-prompt" data-testid="date-prompt">
      <span role="status">
        {t('tree.datePrompt.title', { count })}
        {groups.map((g) => (
          <Fragment key={g.day}>
            <br />
            {t(g.captureId === null ? 'tree.datePrompt.new' : 'tree.datePrompt.existing', {
              count: g.layerIds.length,
              date: formatDate(g.day),
            })}
          </Fragment>
        ))}
        {error ? (
          <>
            <br />
            <span role="alert">{error}</span>
          </>
        ) : null}
      </span>
      <button
        type="button"
        className="dtree-undo"
        data-testid="date-prompt-file"
        disabled={busy}
        onClick={() => void file()}
      >
        {t('tree.datePrompt.file')}
      </button>
      <button
        type="button"
        className="dtree-undo"
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
