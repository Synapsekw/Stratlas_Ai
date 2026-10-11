import type { ProjectManifest } from '@aio/schema';
import { kindLabel, projectKind, starterFor } from './model';

/** The project's type above the heading of the empty project hint; nothing without one. */
export function ProjectKindTag({ manifest }: { manifest: ProjectManifest }) {
  const kind = projectKind(manifest);
  if (!kind) return null;
  return (
    <span className="b-kind" data-testid="project-kind">
      {kindLabel(kind)}
    </span>
  );
}

/** Which data to add first to an empty project of its type; nothing for a project without one. */
export function ProjectStarter({ manifest }: { manifest: ProjectManifest }) {
  const kind = projectKind(manifest);
  if (!kind) return null;
  return (
    <div className="b-starter" data-testid="project-starter">
      <b>Add first</b>
      <ul>
        {starterFor(kind).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
