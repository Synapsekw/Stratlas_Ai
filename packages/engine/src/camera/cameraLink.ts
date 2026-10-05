import type { SavedView } from '../types';

/** What a camera link needs of a stage (EngineStage has it all). */
export interface LinkableStage {
  readonly controls: {
    addEventListener(type: 'change' | 'start', listener: () => void): void;
    removeEventListener(type: 'change' | 'start', listener: () => void): void;
  };
  saveView(): SavedView;
  restoreView(view: SavedView, animate?: boolean): void;
  requestRender(): void;
}

/** True when two views differ by less than `eps` metres in camera position and orbit target. */
export function sameView(a: SavedView, b: SavedView, eps = 1e-6): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs((a.position[i] ?? 0) - (b.position[i] ?? 0)) > eps) return false;
    if (Math.abs((a.target[i] ?? 0) - (b.target[i] ?? 0)) > eps) return false;
  }
  return true;
}

/**
 * Damped orbit controls keep moving after the pointer lets go. When the person starts to move the
 * other view, that leftover motion would pull the two apart, so it is dropped. (OrbitControls
 * keeps it in private fields; a newer three.js without them just keeps its glide.)
 */
function stopGlide(stage: LinkableStage): void {
  const c = stage.controls as unknown as {
    _sphericalDelta?: { set(r: number, phi: number, theta: number): unknown };
    _panOffset?: { set(x: number, y: number, z: number): unknown };
    _scale?: number;
  };
  c._sphericalDelta?.set(0, 0, 0);
  c._panOffset?.set(0, 0, 0);
  if (typeof c._scale === 'number') c._scale = 1;
}

/**
 * Two 3D views of the same site in one frame (two survey dates): orbit, pan and zoom on one
 * moves the other to the same camera position and target. Both stages share the local frame,
 * so the link copies the view as it is; each keeps its own aspect ratio. Unlinked, each view
 * moves on its own; linking again brings the other view to the one moved last.
 */
export class CameraLink {
  private on: boolean;
  private syncing = false;
  /** The stage the person moved last (it wins when the link is turned back on). */
  private leader: LinkableStage;
  private readonly offs: (() => void)[] = [];

  constructor(
    readonly a: LinkableStage,
    readonly b: LinkableStage,
    linked = true,
  ) {
    this.on = linked;
    this.leader = a;
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const change = () => {
        this.follow(self, other);
      };
      const start = () => {
        this.leader = self;
        if (this.on) stopGlide(other);
      };
      self.controls.addEventListener('change', change);
      self.controls.addEventListener('start', start);
      this.offs.push(() => {
        self.controls.removeEventListener('change', change);
        self.controls.removeEventListener('start', start);
      });
    }
    if (linked) this.follow(a, b);
  }

  get linked(): boolean {
    return this.on;
  }

  /** Link or unlink; linking brings the other view to the one moved last (or `from`). */
  setLinked(on: boolean, from?: LinkableStage): void {
    if (from) this.leader = from;
    if (on === this.on) return;
    this.on = on;
    if (on) this.follow(this.leader, this.leader === this.a ? this.b : this.a);
  }

  /** Copy `from`'s view to `to` (no echo back). */
  private follow(from: LinkableStage, to: LinkableStage): void {
    if (!this.on || this.syncing) return;
    const view = from.saveView();
    if (sameView(view, to.saveView())) return;
    this.syncing = true;
    try {
      to.restoreView(view);
      to.requestRender();
    } finally {
      this.syncing = false;
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
