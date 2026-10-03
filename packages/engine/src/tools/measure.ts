import type { Vector3 } from 'three';
import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from 'three';
import { formatMetres } from '../overlay/declutter';
import { PALETTE } from '../palette';

/** Two-click distance tool. A third click starts a new measurement. */
export class MeasureTool {
  readonly line: Line;
  private readonly points: Vector3[] = [];

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    this.line = new Line(
      g,
      new LineBasicMaterial({ color: PALETTE.measure, depthTest: false, transparent: true }),
    );
    this.line.name = 'engine:measure';
    this.line.renderOrder = 30;
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.line.raycast = () => undefined;
  }

  add(p: Vector3): void {
    if (this.points.length >= 2) this.points.length = 0;
    this.points.push(p.clone());
    this.sync();
  }

  clear(): void {
    this.points.length = 0;
    this.sync();
  }

  get a(): Vector3 | null {
    return this.points[0] ?? null;
  }

  get b(): Vector3 | null {
    return this.points[1] ?? null;
  }

  /** Distance in metres (the local frame is metric), or null until both points are set. */
  distance(): number | null {
    const [a, b] = this.points;
    return a && b ? a.distanceTo(b) : null;
  }

  label(): string {
    const d = this.distance();
    return d === null ? '' : formatMetres(d);
  }

  private sync() {
    const [a, b] = this.points;
    const attr = this.line.geometry.getAttribute('position') as BufferAttribute;
    if (a && b) {
      attr.setXYZ(0, a.x, a.y, a.z);
      attr.setXYZ(1, b.x, b.y, b.z);
      attr.needsUpdate = true;
      this.line.visible = true;
    } else this.line.visible = false;
  }

  dispose() {
    this.line.geometry.dispose();
    (this.line.material as LineBasicMaterial).dispose();
  }
}
