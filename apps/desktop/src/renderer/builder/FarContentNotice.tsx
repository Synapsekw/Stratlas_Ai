import { useAnnotateReadOnly } from '@aio/annotate';
import { ContextMenu, Icon, actionsFor, makeActionCtx, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { useShell } from '../shell';
import { toastHost } from '../shell/actions/toastHost';
import { farNotice, useFarNotice } from './farSession';

const ALIGN_TO = 'photos.alignTo';

/**
 * A layer far from the project origin, with "Re-centre project here" and "Keep"; photos far from
 * the survey data get "Ignore their GPS" instead.
 */
export function FarContentNotice() {
  const n = useFarNotice((s) => s.notice);
  const pkg = useShell((s) => s.pkg);
  const lookOnly = useAnnotateReadOnly();
  const manifest = useWorkspace((s) => s.project?.manifest);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (!n) return null;
  // the menu holds Align to only: the notice offers that one way out besides ignoring the GPS
  const items =
    at && manifest
      ? actionsFor(
          { kind: 'layers', layerIds: n.photoLayers },
          makeActionCtx({
            manifest,
            pkg: pkg !== null,
            canEdit: !lookOnly && pkg === null,
            host: toastHost(t('align.to.notice')),
          }),
        ).filter((i) => i.id === ALIGN_TO)
      : [];
  return (
    <div className="toast" data-testid="far-content-notice">
      <div className="toast-h">
        <Icon name="target" size={14} />
        <b>
          {n.done
            ? 'Project origin'
            : n.photoLayers.length > 0 && n.far.length === 0
              ? 'Photos away from the survey'
              : 'Far from the project origin'}
        </b>
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
          {n.photoLayers.length > 0 && (
            <button
              type="button"
              className="btn sm"
              data-testid="far-align-to"
              disabled={n.busy || lookOnly || pkg !== null}
              title={
                pkg !== null
                  ? t('actions.reason.package')
                  : lookOnly
                    ? t('actions.reason.readOnly')
                    : undefined
              }
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
