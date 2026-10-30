/**
 * The placeholder of layers whose files are not on this computer (M9 T6): "Not on this computer
 * (12.4 GB). Download", with progress, Cancel and Resume, over the stage. The layer itself stays
 * empty (its adapter skips the missing file) and loads once the file is here. Files opens the
 * per-layer states and fetch policies. Nothing shows when every file is here, so a project that
 * is never shared looks as it always did.
 *
 * A project with photos and no maps yet (no model, point cloud or raster) gets the other empty
 * state here: **Create maps from photos**, the app's main job, where the scene would be.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { Button, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { photoUi } from '../photogrammetry/store';
import { useJobs, useShell } from '../shell';
import { Files, LayerFileRow, useLayerFiles } from '../team/Files';
import { needsAttention } from '../team/filesModel';

/** The layer kinds that are maps: what Create maps from photos makes. */
const MAP_KINDS: readonly string[] = ['mesh', 'pointcloud', 'raster'];

/**
 * Photos and no maps, from layer counts by kind (the library entry's `layerCounts`, or a
 * manifest's layers counted): the case that offers Create maps from photos.
 */
export function photosWithoutMaps(counts: Readonly<Record<string, number>>): boolean {
  return (counts.photos ?? 0) > 0 && MAP_KINDS.every((k) => (counts[k] ?? 0) === 0);
}

export function LayerPlaceholder() {
  const project = useWorkspace((s) => s.project);
  const openSeq = useWorkspace((s) => s.openSeq);
  if (!project) return null;
  // a new project starts with a fresh state
  return (
    <>
      <ProjectFiles key={`${project.id}|${project.root}`} projectId={project.id} />
      {/* each open of the project starts afresh, so Not now lasts until the project is reopened */}
      <PhotosOffer key={`offer|${String(openSeq)}`} />
    </>
  );
}

/** Create maps from photos over the scene of a photo-only project; Not now hides it until reopened. */
function PhotosOffer() {
  useT();
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const pkg = useShell((s) => s.pkg !== null);
  const lookOnly = useAnnotateReadOnly();
  // without the processing tools Create maps opens the dialog that says so: not the primary then,
  // as in the Processing drawer
  const toolsMissing = useJobs((s) => s.runtime?.found === false);
  const [later, setLater] = useState(false);
  const photoOnly = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of layers ?? []) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
    return photosWithoutMaps(counts);
  }, [layers]);
  if (!photoOnly || pkg || lookOnly || later) return null;
  return (
    <aside
      className="files-card maps-offer"
      aria-label={t('processing.photoOnly.title')}
      data-testid="photos-maps-offer"
    >
      <b>{t('processing.photoOnly.title')}</b>
      <p className="small">{t('processing.photoOnly.body')}</p>
      <div className="maps-offer-acts">
        <Button
          variant={toolsMissing ? 'secondary' : 'primary'}
          icon="photo"
          data-testid="photos-create-maps"
          onClick={() => {
            photoUi.getState().openWizard();
          }}
        >
          {t('processing.createMaps')}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setLater(true);
          }}
        >
          {t('processing.photoOnly.later')}
        </Button>
      </div>
    </aside>
  );
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
        <Button
          variant="quiet"
          onClick={() => {
            setOpen(true);
          }}
        >
          {t('blobs.files')}
        </Button>
      </div>
      <ul className="files-list">
        {pending.map((l) => (
          <LayerFileRow key={l.layer} status={l} name={names[l.layer] ?? l.layer} model={model} />
        ))}
      </ul>
    </aside>
  );
}
