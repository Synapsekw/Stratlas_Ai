/**
 * Frame capture for the photo window: the photo the person is looking at, with the kit's mask
 * overlay and every issue drawn on it (boxes, polygons, points, labelled by issue code), composed
 * on a canvas at most MAX_EDGE pixels on its long side. Pure planning is split from drawing so it
 * can be tested without a DOM.
 */
import type { ImageGeom, Issue, ProjectManifest } from '@aio/schema';
import { assetUrl, type WorkspaceState } from '@aio/workspace';

export const MAX_EDGE = 1568;
const DEFAULT_COLOR = '#e8c547';

export interface PhotoShape {
  code: string;
  color: string;
  geom: Exclude<ImageGeom, { type: 'mask' }>;
}

export interface PhotoPlan {
  src: string;
  /** Mask overlay images drawn at 60 % over the photo. */
  overlays: string[];
  shapes: PhotoShape[];
}

/** `p024_mask.png` to `p024_overlay.png`, as the photo viewer does. */
const overlayPath = (mask: string) => mask.replace(/_mask\.png$/i, '_overlay.png');

function severityColor(manifest: ProjectManifest, issue: Issue): string {
  const model = manifest.severityModels.find((m) => m.id === issue.severityModelId);
  if (!model) return DEFAULT_COLOR;
  if (issue.severity === 'uncertain') return model.uncertain?.color ?? DEFAULT_COLOR;
  return model.levels.find((l) => l.value === issue.severity)?.color ?? DEFAULT_COLOR;
}

/** What to draw for the selected photo, or null when no photo is selected. */
export function photoPlan(
  state: Pick<WorkspaceState, 'project' | 'issues' | 'selection'>,
): PhotoPlan | null {
  const project = state.project;
  const sel = state.selection;
  if (!project || sel?.kind !== 'photo') return null;
  const sets = project.manifest.layers.filter(
    (l): l is Extract<typeof l, { kind: 'photos' }> => l.kind === 'photos',
  );
  const layer =
    sets.find((l) => l.id === sel.layer) ?? sets.find((l) => l.items.some((p) => p.id === sel.id));
  const photo = layer?.items.find((p) => p.id === sel.id);
  if (!layer || !photo) return null;
  const overlays: string[] = [];
  const shapes: PhotoShape[] = [];
  for (const issue of state.issues) {
    for (const s of issue.sightings) {
      if (s.on !== 'image' || s.layer !== layer.id || s.photo !== photo.id) continue;
      if (s.geom.type === 'mask') {
        if ('path' in s.geom.src) {
          overlays.push(assetUrl(project.id, { path: overlayPath(s.geom.src.path) }));
        }
        continue;
      }
      shapes.push({
        code: issue.code,
        color: severityColor(project.manifest, issue),
        geom: s.geom,
      });
    }
  }
  return { src: assetUrl(project.id, photo.src), overlays: [...new Set(overlays)], shapes };
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

function drawShape(g: CanvasRenderingContext2D, s: PhotoShape, k: number): void {
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = 3;
  let label: [number, number];
  const geom = s.geom;
  if (geom.type === 'box') {
    g.strokeRect(geom.x * k, geom.y * k, geom.w * k, geom.h * k);
    label = [geom.x * k, geom.y * k];
  } else if (geom.type === 'rotbox') {
    g.save();
    g.translate((geom.x + geom.w / 2) * k, (geom.y + geom.h / 2) * k);
    g.rotate((geom.angleDeg * Math.PI) / 180);
    g.strokeRect((-geom.w / 2) * k, (-geom.h / 2) * k, geom.w * k, geom.h * k);
    g.restore();
    label = [geom.x * k, geom.y * k];
  } else if (geom.type === 'polygon') {
    g.beginPath();
    geom.points.forEach(([x, y], i) => {
      if (i === 0) g.moveTo(x * k, y * k);
      else g.lineTo(x * k, y * k);
    });
    g.closePath();
    g.stroke();
    const top = geom.points.reduce((a, p) => (p[1] < a[1] ? p : a), geom.points[0] ?? [0, 0]);
    label = [top[0] * k, top[1] * k];
  } else {
    g.beginPath();
    g.arc(geom.x * k, geom.y * k, 10, 0, Math.PI * 2);
    g.stroke();
    label = [geom.x * k, geom.y * k];
  }
  const size = 14;
  g.font = `600 ${String(size)}px sans-serif`;
  const w = g.measureText(s.code).width + 8;
  const y = Math.max(0, label[1] - size - 6);
  g.fillRect(label[0], y, w, size + 6);
  g.fillStyle = '#0f1318';
  g.fillText(s.code, label[0] + 4, y + size);
}

/** The selected photo with its overlays as a JPEG data URL, or null. */
export async function capturePhoto(
  state: Pick<WorkspaceState, 'project' | 'issues' | 'selection'>,
): Promise<string | null> {
  const plan = photoPlan(state);
  if (!plan || typeof document === 'undefined') return null;
  const img = await loadImage(plan.src);
  if (!img?.naturalWidth || !img.naturalHeight) return null;
  const k = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * k);
  canvas.height = Math.round(img.naturalHeight * k);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const src of plan.overlays) {
    const o = await loadImage(src);
    if (!o) continue;
    g.globalAlpha = 0.6;
    g.drawImage(o, 0, 0, canvas.width, canvas.height);
    g.globalAlpha = 1;
  }
  for (const s of plan.shapes) drawShape(g, s, k);
  return canvas.toDataURL('image/jpeg', 0.85);
}
