/**
 * Settings, This project, Project settings: what belongs to the open project. Its privacy and AI
 * policy (moved from Privacy and cloud) and its street map, with the way to "Maps for your
 * projects" on Offline maps (that panel plans maps for the whole library, so it stays there).
 * Listed in the nav only while a project is open.
 */
import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import type { ReactElement } from 'react';
import { useMapCoverage } from '../../mapCoverage/store';
import { shell } from '../../shell';
import { ProjectPrivacy } from './ProjectPrivacy';
import { projectMapKey } from './projectSettingsView';

function ProjectStreetMap({ projectId }: { projectId: string }): ReactElement {
  const { coverage, loaded } = useMapCoverage();
  const status = coverage.find((c) => c.project.id === projectId)?.status;
  return (
    <div className="sblock" data-testid="project-street-map">
      <h2>{t('settings.project.maps.title')}</h2>
      <p className="help" data-testid="project-street-map-state">
        {loaded ? t(projectMapKey(status)) : ''}
      </p>
      <button
        type="button"
        className="btn sm"
        data-testid="project-street-map-open"
        onClick={() => {
          shell.getState().openSettings('project-maps');
        }}
      >
        {t('settings.project.maps.open')}
      </button>
    </div>
  );
}

export function ProjectSettings(): ReactElement {
  const project = useWorkspace((s) => s.project);
  if (!project) return <p className="help">{t('settings.project.none')}</p>;
  return (
    <>
      <div data-settings-focus="project-privacy">
        <ProjectPrivacy />
      </div>
      <ProjectStreetMap projectId={project.id} />
    </>
  );
}
