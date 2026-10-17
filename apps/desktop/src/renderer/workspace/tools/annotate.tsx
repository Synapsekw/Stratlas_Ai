/** The Annotate group: the annotation tools on and off. */
import { shell, useShell } from '../../shell';
import { Tool } from '../StageTools';

export function AnnotateToggle() {
  const on = useShell((s) => s.annotating);
  // Packages are never annotated (player mode).
  const pkg = useShell((s) => s.pkg);
  if (pkg) return null;
  return (
    <Tool
      icon="anno"
      label={on ? 'Close the annotation tools' : 'Annotate: pins, lines, areas, cloud regions'}
      shortcut="scene.annotate"
      pressed={on}
      onClick={() => {
        shell.getState().setAnnotating(!on);
      }}
    />
  );
}
