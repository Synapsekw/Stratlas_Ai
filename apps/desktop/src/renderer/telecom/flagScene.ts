/**
 * The kept points of a flag outline, drawn over the cloud so the person sees what will be measured
 * before confirming: 4 px dots in the outline's amber, never hidden behind the cloud itself.
 */
import type { EngineStage } from '@aio/engine';
import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';

export const FLAG_POINTS_NAME = 'antenna-flag-points';

/** Add the stage-local `points` (xyz triples) to the stage; returns the remover (safe to repeat). */
export function drawFlagPoints(stage: EngineStage, points: Float32Array): () => void {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(points, 3));
  const material = new PointsMaterial({
    color: '#ffb020',
    size: 4,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const obj = new Points(geometry, material);
  obj.name = FLAG_POINTS_NAME;
  obj.renderOrder = 999;
  obj.frustumCulled = false;
  stage.scene.add(obj);
  stage.requestRender();
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    stage.scene.remove(obj);
    geometry.dispose();
    material.dispose();
    stage.requestRender();
  };
}
