/** The Annotate group: the annotation tools on and off. */
import { useT } from '@aio/ui';
import { shell, useShell } from '../../shell';
import { Tool } from '../StageTools';

export function AnnotateToggle() {
  const t = useT();
  const on = useShell((s) => s.annotating);
  // Packages are never annotated (player mode).
  const pkg = useShell((s) => s.pkg);
  if (pkg) return null;
  return (
    <Tool
      icon="anno"
      label={on ? t('bench.annotate.close') : t('bench.annotate.start')}
      shortcut="scene.annotate"
      pressed={on}
      onClick={() => {
        shell.getState().setAnnotating(!on);
      }}
    />
  );
}
