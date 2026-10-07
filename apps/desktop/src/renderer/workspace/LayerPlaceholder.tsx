/**
 * The placeholder of layers whose files are not on this computer (M9 T6): "Not on this computer
 * (12.4 GB). Download", with progress, Cancel and Resume, over the stage. The layer itself stays
 * empty (its adapter skips the missing file) and loads once the file is here. Files opens the
 * per-layer states and fetch policies. Nothing shows when every file is here, so a project that
 * is never shared looks as it always did.
 */
import { t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { Files, LayerFileRow, useLayerFiles } from '../team/Files';
import { needsAttention } from '../team/filesModel';

export function LayerPlaceholder() {
  const project = useWorkspace((s) => s.project);
  if (!project) return null;
  // a new project starts with a fresh state
  return <ProjectFiles key={`${project.id}|${project.root}`} projectId={project.id} />;
}

function ProjectFiles({ projectId }: { projectId: string }) {
  useT();
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const model = useLayerFiles(projectId);
  const [open, setOpen] = useState(false);
  const names = useMemo(
    () => Object.fromEntries((layers ?? []).map((l) => [l.id, l.name])),
    [layers],
  );
  const pending = needsAttention(model.layers);
  if (open) {
    return (
      <Files
        model={model}
        names={names}
        onClose={() => {
          setOpen(false);
        }}
      />
    );
  }
  if (pending.length === 0) return null;
  return (
    <aside className="files-card" aria-live="polite" data-testid="layer-placeholder">
      <div className="files-card-h">
        <b>{t('blobs.summary', { count: pending.length })}</b>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('blobs.files')}
        </button>
      </div>
      <ul className="files-list">
        {pending.map((l) => (
          <LayerFileRow key={l.layer} status={l} name={names[l.layer] ?? l.layer} model={model} />
        ))}
      </ul>
    </aside>
  );
}
