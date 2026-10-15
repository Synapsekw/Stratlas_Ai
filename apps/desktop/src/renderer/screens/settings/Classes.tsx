import { useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';

/** Settings, Classes: the open project's classes (ANN-7). */
export function Classes() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  if (!project) return <p className="help">{t('classes.noProject')}</p>;
  return <div data-testid="classes-panel" />;
}
