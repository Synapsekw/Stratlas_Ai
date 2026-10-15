/**
 * The engineering model export bundle (spec section 5.6): the GLB with `asset.extras.aioGeoref`
 * and one node per accepted component (component record in the node extras), the model itself
 * (`aio.procmodel/2`), the component register and the georeference sidecar. Pure: it returns the
 * bytes and texts, and the caller writes them (all at once, through a staging folder).
 *
 * Vertex buffers stay relative to their node anchors (float32 safe); the full-precision geographic
 * values live only in the JSON (`aioGeoref`, the sidecar and the model's `georef`).
 */
import {
  Georef,
  type AssemblyKind,
  type Detail,
  type EvidenceRef,
  type ProcModel,
  type ValueBasis,
} from '@aio/schema';
import { readGlb } from '../glb';
import { buildEngineeringGlb } from './meshAssemblies';

export interface EngineeringBundle {
  glb: Uint8Array;
  procmodel: string;
  components: string;
  /** The `aio.georef/1` sidecar, or null when the model has no georeference. */
  georeference: string | null;
  /** How the GLB was built: what was coarsened for the budget, what could not be built. */
  build: BundleBuild;
}

/** The meshing outcome of a bundle's GLB, for the caller to report. */
export interface BundleBuild {
  triangles: number;
  overBudget: boolean;
  /** The coarsest detail level used. */
  detail: Detail;
  simplified: { id: string; detail: Detail }[];
  /** Components whose geometry could not be built (not in the GLB), with the reason. */
  failed: { id: string; reason: string }[];
  notes: string[];
}

/** One row of the component register (`components.json`). */
export interface ComponentRow {
  id: string;
  name: string;
  category: string;
  type?: string;
  description: string;
  tag?: string;
  parent?: string;
  kind: AssemblyKind;
  /** Scalar parameters (lengths in metres, angles in degrees, flags as "yes" or "no"). */
  dimensions: Record<string, number | string>;
  units: 'm';
  material?: string;
  status: string;
  /** How each recorded parameter is known. */
  basis: Record<string, ValueBasis>;
  /** The worst fit residual over the measured parameters. */
  residualM?: number;
  /** The least point coverage over the parameters that record one. */
  coverage?: number;
  sources: EvidenceRef[];
  unobserved?: string[];
}

/** The register: one row per accepted component, in model order. */
export function componentRegister(model: ProcModel): ComponentRow[] {
  return model.assemblies
    .filter((a) => a.status === 'accepted')
    .map((a): ComponentRow => {
      const dimensions: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) dimensions[k] = v;
        else if (typeof v === 'string') dimensions[k] = v;
        else if (typeof v === 'boolean') dimensions[k] = v ? 'yes' : 'no';
      }
      const basis: Record<string, ValueBasis> = {};
      let residualM: number | undefined;
      let coverage: number | undefined;
      for (const [k, q] of Object.entries(a.quality)) {
        basis[k] = q.basis;
        if (q.residualM !== undefined) residualM = Math.max(residualM ?? 0, q.residualM);
        if (q.coverage !== undefined) coverage = Math.min(coverage ?? 1, q.coverage);
      }
      return {
        id: a.id,
        name: a.name,
        category: a.category,
        ...(a.type === undefined ? {} : { type: a.type }),
        description: a.description,
        ...(a.tag === undefined ? {} : { tag: a.tag }),
        ...(a.parent === undefined ? {} : { parent: a.parent }),
        kind: a.kind,
        dimensions,
        units: 'm',
        ...(a.material === undefined ? {} : { material: a.material }),
        status: a.status,
        basis,
        ...(residualM === undefined ? {} : { residualM }),
        ...(coverage === undefined ? {} : { coverage }),
        sources: a.sources.map((s) => ({ ...s })),
        ...(a.unobserved === undefined ? {} : { unobserved: [...a.unobserved] }),
      };
    });
}

/**
 * A GLB with `extras` merged into `asset.extras`: the JSON chunk is rewritten, the BIN chunk is
 * copied byte for byte.
 */
function withAssetExtras(glb: Uint8Array, extras: Record<string, unknown>): Uint8Array {
  const { json, bin } = readGlb(glb);
  const asset = (json.asset ?? {}) as Record<string, unknown>;
  const before = (asset.extras ?? {}) as Record<string, unknown>;
  const next = { ...json, asset: { ...asset, extras: { ...before, ...extras } } };
  const text = new TextEncoder().encode(JSON.stringify(next));
  const jsonLen = text.length + ((4 - (text.length % 4)) % 4);
  const total = 12 + 8 + jsonLen + (bin.byteLength ? 8 + bin.byteLength : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (bin.byteLength) {
    const at = 20 + jsonLen;
    dv.setUint32(at, bin.byteLength, true);
    dv.setUint32(at + 4, 0x004e4942, true); // BIN
    out.set(bin, at + 8);
  }
  return out;
}

/**
 * The export bundle of a model: accepted components only (drafts and rejected ones are never
 * exported). A georeference is checked against `aio.georef/1` first; an invalid one throws.
 */
export function exportBundle(
  model: ProcModel,
  o: { detail: Detail; generator: string; georef: Georef | null },
): EngineeringBundle {
  const georef = o.georef === null ? null : Georef.parse(o.georef);
  const built = buildEngineeringGlb(model, {
    detail: o.detail,
    drafts: false,
    generator: o.generator,
  });
  const glb = georef ? withAssetExtras(built.glb, { aioGeoref: georef }) : built.glb;
  // the written model carries exactly the georeference exported with it, or none
  const out: ProcModel = { ...model };
  if (georef) out.georef = georef;
  else delete out.georef;
  return {
    glb,
    procmodel: `${JSON.stringify(out, null, 2)}\n`,
    components: `${JSON.stringify(componentRegister(model), null, 2)}\n`,
    georeference: georef ? `${JSON.stringify(georef, null, 2)}\n` : null,
    build: {
      triangles: built.triangles,
      overBudget: built.overBudget,
      detail: built.detail,
      simplified: built.simplified,
      failed: built.failed,
      notes: built.notes,
    },
  };
}
