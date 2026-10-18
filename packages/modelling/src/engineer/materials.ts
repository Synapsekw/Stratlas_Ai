/**
 * Default PBR materials of the engineering model. Every material id a builder can emit (its
 * fallback when the assembly names none, and the fixed ids of linings, joints, cages, lenses and
 * sheets) is defined here, so a generated GLB never carries an unresolved material. A model's own
 * `materials` override these by id. Colours are linear RGB (glTF `baseColorFactor`).
 */
import type { Material, ProcModel } from '@aio/schema';

const mat = (
  id: string,
  name: string,
  rgb: [number, number, number],
  metallic: number,
  roughness: number,
  extra: { emissive?: [number, number, number]; doubleSided?: boolean } = {},
): Material => ({ id, name, baseColor: [...rgb, 1], metallic, roughness, ...extra });

export const DEFAULT_MATERIALS: readonly Material[] = [
  mat('concrete-cream', 'Concrete, cream', [0.72, 0.66, 0.55], 0, 0.9),
  mat('concrete-grey', 'Concrete, grey', [0.55, 0.55, 0.53], 0, 0.9),
  mat('paint-red', 'Paint, red', [0.6, 0.05, 0.04], 0, 0.6),
  mat('paint-white', 'Paint, white', [0.85, 0.85, 0.83], 0, 0.55),
  mat('mast-painted', 'Light neutral coated steel (inferred)', [0.74, 0.77, 0.75], 0.28, 0.68),
  mat('paint-black', 'Dark painted metal', [0.045, 0.05, 0.055], 0.15, 0.65),
  mat('steel-galv', 'Galvanised steel', [0.62, 0.64, 0.66], 0.8, 0.45),
  mat('steel-galv-cage', 'Galvanised steel, ladder cage', [0.6, 0.62, 0.64], 0.8, 0.5),
  mat('steel-blue', 'Steel, blue paint', [0.12, 0.22, 0.4], 0.3, 0.5),
  mat('steel-sheet', 'Steel sheet', [0.5, 0.5, 0.52], 0.6, 0.5, { doubleSided: true }),
  mat('stainless', 'Stainless steel', [0.7, 0.7, 0.72], 0.9, 0.3),
  mat('lamp-housing', 'Lamp housing', [0.15, 0.15, 0.15], 0.2, 0.5),
  mat('lamp-lens-red', 'Lamp lens, red', [0.8, 0.05, 0.03], 0, 0.2, { emissive: [1, 0.05, 0.02] }),
  mat('refractory', 'Refractory lining', [0.45, 0.35, 0.28], 0, 0.95),
  mat('insulation-tan', 'Insulation cladding', [0.66, 0.56, 0.4], 0, 0.85),
  mat('grating', 'Steel grating', [0.4, 0.42, 0.44], 0.7, 0.6),
  mat('joint', 'Construction joint', [0.35, 0.35, 0.34], 0, 0.95),
  mat('cable', 'Cable', [0.03, 0.03, 0.03], 0, 0.6),
  mat('cabinet-grey', 'Cabinet, grey', [0.6, 0.62, 0.62], 0.3, 0.5),
  mat('copper', 'Copper', [0.72, 0.45, 0.2], 1, 0.35),
];

/** The defaults with the model's own materials laid over them by id (the model's extras last). */
export function resolveMaterials(model: Pick<ProcModel, 'materials'>): Material[] {
  const own = new Map(model.materials.map((m) => [m.id, m]));
  const out = DEFAULT_MATERIALS.map((d) => own.get(d.id) ?? d);
  const known = new Set(DEFAULT_MATERIALS.map((d) => d.id));
  for (const m of model.materials) if (!known.has(m.id)) out.push(m);
  return out;
}
