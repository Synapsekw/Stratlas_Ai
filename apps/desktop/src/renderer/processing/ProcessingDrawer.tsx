/**
 * The Processing drawer: the open project's processing, opened from the title bar chip. It lies
 * over the right of the screen and does not block the app. The list (`DrawerList`), or one job's
 * details with **Back**. Esc inside it, or its close button, closes it; focus returns to the chip.
 * It also closes when the photo wizard or a run's panel opens over the screen.
 */
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { PhotoRuns } from '../photogrammetry/PhotoRuns';
import { photoUi } from '../photogrammetry/store';
import { openProcessingTools } from '../processingTools';
import { jobs, useJobs, useShell } from '../shell';
import { DrawerList } from './DrawerList';
import { JobDetail } from './JobDetail';
import { useNow } from './JobParts';
import { drawerProject, projectJobs, projectLabel, runningElsewhere, shownJob } from './model';
import { processing, useProcessing } from './store';
import './processing.css';

export function focusChip(): void {
  document.querySelector<HTMLElement>('[data-testid="processing-chip"]')?.focus();
}

export function ProcessingDrawer() {
  useT();
  const open = useProcessing((s) => s.open);
  const picked = useProcessing((s) => s.picked);
  const all = useJobs((s) => s.jobs);
  const runtime = useJobs((s) => s.runtime);
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg !== null);
  const library = useShell((s) => s.library);
  const heading = useRef<HTMLHeadingElement>(null);
  const own = project !== null && !pkg;
  const root = own ? project.root : null;
  const mine = useMemo(() => projectJobs(all, root), [all, root]);
  const elsewhere = useMemo(
    () =>
      runningElsewhere(all, root).map((job) => ({
        job,
        project: projectLabel(job.project, library ?? []),
      })),
    [all, root, library],
  );
  const now = useNow(open && mine.running.length + elsewhere.length > 0);
  const photoOpen = useStore(photoUi, (s) => s.view !== null);

  // the photo wizard and a run's panel lie over the screen: the drawer makes way for them. (The
  // store does not open it while one is open.) Only an open drawer is closed, because closing also
  // marks the project's processing as looked at
  useEffect(() => {
    if (photoOpen && processing.getState().open) processing.getState().closeDrawer();
  }, [photoOpen]);
  // opening reads the list again
  useEffect(() => {
    if (open) void jobs.getState().refresh();
  }, [open]);

  // a picked job that is gone, or of a project no longer open, falls back to the list
  const job = shownJob(all, picked, root);
  const shownId = job?.id ?? null;
  // opening, and a row or Back unmounting the button that had the focus (the app would hand the
  // focus to the screen heading outside the drawer, and Esc would no longer close it): the focus
  // sits on our heading
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open, shownId]);
  // another project's job shows under that project's name, never under the open project's
  const headerProject = drawerProject(job, root, own ? project.manifest.name : null, library ?? []);

  if (!open) return null;
  const close = () => {
    processing.getState().closeDrawer();
    focusChip();
  };
  return (
    <aside
      id="processing-drawer"
      className="proc-drawer"
      aria-label={t('processing.title')}
      data-testid="processing-drawer"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <header className="proc-h">
        {job && (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="proc-back"
            onClick={() => {
              processing.getState().pick(null);
            }}
          >
            <Icon name="back" size={14} />
            {t('processing.back')}
          </button>
        )}
        <div className="proc-t">
          <h2 ref={heading} tabIndex={-1}>
            {t('processing.title')}
          </h2>
          {headerProject !== null && (
            <p className="muted" dir="auto" data-testid="proc-project">
              {headerProject}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('processing.close')}
          data-testid="proc-close"
          onClick={close}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="proc-b">
        {job ? (
          <JobDetail job={job} now={now} folded />
        ) : (
          <DrawerList
            projectName={own ? project.manifest.name : null}
            running={mine.running}
            finished={mine.finished}
            elsewhere={elsewhere}
            toolsMissing={runtime?.found === false}
            now={now}
            onPick={(id) => {
              processing.getState().pick(id);
              void jobs.getState().select(id);
            }}
            onCreateMaps={() => {
              // the drawer closes as the wizard opens (the effect above)
              photoUi.getState().openWizard();
            }}
            onUpdateTools={() => {
              close();
              openProcessingTools();
            }}
          >
            <PhotoRuns />
          </DrawerList>
        )}
      </div>
    </aside>
  );
}
