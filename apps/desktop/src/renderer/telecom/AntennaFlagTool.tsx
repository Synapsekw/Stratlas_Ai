/**
 * The Flag antenna tool, mounted by `AntennaSection` while the store's `flagging` is set: the
 * person clicks an outline round a unit the detection missed on the active 3D stage
 * (`PolygonClickTool`); on close the drawn points of the cloud layer detection works on (the one
 * picked for it, else the newest visible cloud) inside the outline are cut to the surface nearest
 * the camera and highlighted, and a bar offers Measure (starts `telecom.flag`), Draw again and
 * Cancel. With no points kept the unit is placed where the outline's middle meets the cloud; with
 * no hit there either, Measure waits for an outline drawn over the cloud.
 */
import { PolygonClickTool, getActiveStage, type PointSelection } from '@aio/engine';
import { collectDrawn } from '@aio/pointcloud';
import type { Vec3 } from '@aio/schema';
import { Button, t } from '@aio/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { selectionTest } from '../pointcloud/cleanupScene';
import { flagSelection, nearestCluster, type FlagSelection } from './antennaFlag';
import { useAntennaClouds } from './AntennaRunner';
import { endFlag, startFlag, useAntennas } from './antennaStore';
import { drawFlagPoints } from './flagScene';

interface Review {
  sel: PointSelection;
  layer: string;
  kept: number;
  /** Bounds and anchor to measure, null off the cloud. */
  flag: FlagSelection | null;
}

/** The mean of the outline's vertices, in NDC. */
function centroid(polygon: readonly [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of polygon) {
    x += px;
    y += py;
  }
  const n = Math.max(polygon.length, 1);
  return [x / n, y / n];
}

export function AntennaFlagTool(): ReactElement {
  const cloudLayer = useAntennas((s) => s.cloudLayer);
  const clouds = useAntennaClouds();
  const layer = cloudLayer ?? clouds.filter((l) => l.visible).at(-1)?.id ?? null;
  // the outline tool reads the layer when it closes, without being re-armed when it changes
  const layerRef = useRef(layer);
  useEffect(() => {
    layerRef.current = layer;
  }, [layer]);
  const [review, setReview] = useState<Review | null>(null);
  // bumped by Draw again, so the outline tool is armed afresh
  const [round, setRound] = useState(0);
  const unhighlight = useRef<(() => void) | null>(null);

  const clearHighlight = () => {
    unhighlight.current?.();
    unhighlight.current = null;
  };

  useEffect(() => clearHighlight, []);

  const drawing = review === null;
  useEffect(() => {
    if (!drawing) return;
    const stage = getActiveStage();
    if (!stage) return;
    const tool = new PolygonClickTool(stage, {
      onClose: (sel) => {
        const id = layerRef.current;
        const inside = selectionTest(sel.viewProj, sel.polygon);
        const drawn = id ? collectDrawn(stage, id, inside) : new Float32Array(0);
        const p = stage.camera.position;
        const eye: Vec3 = [p.x, p.y, p.z];
        const kept = nearestCluster(drawn, eye);
        let fallback: Vec3 | null = null;
        if (kept.length === 0) {
          const [cx, cy] = centroid(sel.polygon);
          const hit = stage.raycast(cx, cy);
          if (hit) fallback = [hit.point.x, hit.point.y, hit.point.z];
        }
        clearHighlight();
        if (kept.length > 0) unhighlight.current = drawFlagPoints(stage, kept);
        setReview({
          sel,
          layer: id ?? '',
          kept: kept.length / 3,
          flag: id ? flagSelection(kept, fallback) : null,
        });
      },
      onCancel: () => {
        endFlag();
      },
    });
    return tool.attach();
  }, [drawing, round]);

  if (review === null)
    return (
      <p className="telecom-help telecom-note" role="status" data-testid="antenna-flag-hint">
        {t('telecom.antennas.flag.drawing')}
      </p>
    );

  const flag = review.flag;
  return (
    <div data-testid="antenna-flag-bar" role="group" aria-label={t('telecom.antennas.flag.button')}>
      <p className="telecom-help telecom-note" role="status">
        {review.kept > 0
          ? t('telecom.antennas.flag.kept', { count: review.kept })
          : t('telecom.antennas.flag.none')}
      </p>
      <div className="telecom-actions">
        <Button
          size="sm"
          variant="primary"
          data-testid="antenna-flag-confirm"
          {...(flag ? {} : { disabledReason: t('telecom.antennas.flag.offCloud') })}
          onClick={() => {
            if (!flag) return;
            clearHighlight();
            void startFlag({
              sel: review.sel,
              bounds: flag.bounds,
              anchor: flag.anchor,
              layer: review.layer,
            });
          }}
        >
          {t('telecom.antennas.flag.measure')}
        </Button>
        <Button
          size="sm"
          data-testid="antenna-flag-again"
          onClick={() => {
            clearHighlight();
            setReview(null);
            setRound((r) => r + 1);
          }}
        >
          {t('telecom.antennas.flag.again')}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          data-testid="antenna-flag-cancel"
          onClick={() => {
            clearHighlight();
            endFlag();
          }}
        >
          {t('telecom.antennas.flag.cancel')}
        </Button>
      </div>
    </div>
  );
}
