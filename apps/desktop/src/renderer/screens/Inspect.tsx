import { useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { PageHeader } from '../shell/PageHeader';
import { NoProject } from './NoProject';

/** Inspect: photos, drawing and AI review on one screen. The body arrives with the screen build. */
export function InspectScreen() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  if (!project)
    return (
      <>
        <PageHeader heading="nav.inspect" />
        <NoProject view={t('nav.inspect')} />
      </>
    );
  return <section className="screen inspect" aria-label={t('nav.inspect')} />;
}
