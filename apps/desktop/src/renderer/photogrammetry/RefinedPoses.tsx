/**
 * **Use refined poses** (G4): a preview of how far each camera of the photos layer moves to its
 * calibrated position, then the swap on the person's word. The poses before are kept in the run
 * folder (`cameras.json.bak`) and the manifest keeps its `.bak`.
 */
import type { PhotoRun } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { bridge } from '../shell';
import { reloadManifest } from './actions';
import { formatResidual } from './report';

interface Preview {
  cameras: number;
  medianMoveM: number;
  maxMoveM: number;
  applied: boolean;
}

export function RefinedPoses({ run, data }: { run: string; data: PhotoRun | null }) {
  const project = useWorkspace((s) => s.project);
  const layer = data && 'layer' in data.photos.source ? data.photos.source.layer : null;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!project || !layer) return;
    let live = true;
    void bridge
      .call('photo:applyPoses', { projectId: project.id, run, layer, apply: false })
      .then((r) => {
        if (!live) return;
        if (!r.ok) setError(r.error);
        else if (!r.value.ok) setError(r.value.error);
        else {
          setError(null);
          setPreview(r.value);
        }
      });
    return () => {
      live = false;
    };
  }, [project, run, layer]);

  if (!project) return null;
  if (!layer)
    return (
      <p className="small faint">
        Refined poses apply to a photos layer. This run read its photos from folders; import them as
        a layer to use the calibrated cameras for findings.
      </p>
    );

  const apply = async () => {
    setBusy(true);
    const r = await bridge.call('photo:applyPoses', {
      projectId: project.id,
      run,
      layer,
      apply: true,
    });
    setBusy(false);
    setConfirming(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
    else {
      setPreview(r.value);
      await reloadManifest();
    }
  };

  return (
    <div className="ph-poses" data-testid="refined-poses">
      <p className="small">
        Alignment calibrated every camera. Using the refined poses moves the photos of the layer to
        those positions, so findings in a photo land closer on the model.
      </p>
      {preview && !preview.applied && (
        <p data-testid="poses-preview">
          {preview.cameras} cameras move by {formatResidual(preview.medianMoveM)} (median), at most{' '}
          {formatResidual(preview.maxMoveM)}.
        </p>
      )}
      {preview?.applied && (
        <p className="notice ok small" role="status" data-testid="poses-applied">
          <Icon name="check" size={14} />
          The refined poses are in use for {preview.cameras} cameras. The poses before are kept in
          the run folder as cameras.json.bak.
        </p>
      )}
      {error && (
        <p className="notice warn small" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      {preview && !preview.applied && (
        <div className="ph-acts">
          {confirming ? (
            <>
              <span className="small">
                Move {preview.cameras} cameras of the layer? The manifest keeps a backup.
              </span>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Keep the current poses
              </button>
              <button
                type="button"
                className="btn sm primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                Move the cameras
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Use refined poses
            </button>
          )}
        </div>
      )}
    </div>
  );
}
