import { ContextMenu, Icon, actionsFor, makeActionCtx, t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useState } from 'react';
import { useShell } from '../shell';
import { farNotice, useFarNotice } from './farSession';

const ALIGN_TO = 'photos.alignTo';

/**
 * A layer far from the project origin, with "Re-centre project here" and "Keep"; photos far from
 * the survey data get "Ignore their GPS" instead.
 */
export function FarContentNotice() {
  const n = useFarNotice((s) => s.notice);
  const pkg = useShell((s) => s.pkg);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!n) return null;
  const project = workspace.getState().project;
  // the menu holds Align to only: the notice offers that one way out besides ignoring the GPS
  const items =
    at && project
      ? actionsFor(
          { kind: 'layers', layerIds: n.photoLayers },
          makeActionCtx({ manifest: project.manifest, pkg: pkg !== null }),
        ).filter((i) => i.id === ALIGN_TO)
      : [];
  return (
    <div className="toast" data-testid="far-content-notice">
      <div className="toast-h">
        <Icon name="target" size={14} />
        <b>{n.done ? 'Project origin' : 'Far from the project origin'}</b>
        <span className="toast-grow" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label="Dismiss"
          onClick={() => {
            farNotice.getState().dismiss();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="toast-p" data-testid="far-content-text">
        {n.text}
      </div>
      {!n.done && (
        <div className="toast-p pm-acts">
          {n.canRecentre && (
            <button
              type="button"
              className="btn sm primary"
              disabled={n.busy}
              onClick={() => void farNotice.getState().recentre()}
            >
              Re-centre project here
            </button>
          )}
          {n.photoLayers.length > 0 && (
            <button
              type="button"
              className="btn sm primary"
              disabled={n.busy}
              onClick={() => void farNotice.getState().ignorePhotoGps()}
            >
              Ignore their GPS
            </button>
          )}
          {n.photoLayers.length > 0 && !pkg && (
            <button
              type="button"
              className="btn sm"
              data-testid="far-align-to"
              disabled={n.busy}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setAt({ x: r.left, y: r.bottom + 4 });
              }}
            >
              {t('align.to.far')}
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              farNotice.getState().dismiss();
            }}
          >
            Keep
          </button>
        </div>
      )}
      {at && items.length > 0 && (
        <ContextMenu
          items={items}
          x={at.x}
          y={at.y}
          label={t('actions.menu.label', { name: t('align.to.far') })}
          initialSub={ALIGN_TO}
          onClose={() => {
            setAt(null);
          }}
        />
      )}
    </div>
  );
}
