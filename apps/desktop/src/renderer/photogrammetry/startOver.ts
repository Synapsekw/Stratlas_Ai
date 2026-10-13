import { PhotoProduct } from '@aio/schema';
import type { Layer, PhotoPreset, PhotoRun, PhotoSource, RemovalPlan } from '@aio/schema';
import { removeText, t } from '@aio/ui';
import { defaultProducts } from './estimate';

/*
 * Start over (delete and start over, spec "Processing drawer"): the process wizard filled in from
 * a failed or cancelled run's `run.json`; the old run goes to the trash only once the new run's
 * first job started (founder decision 3, spec decision 6), and a refused removal is a note, never a
 * stop. English inline, as the rest of the photogrammetry renderer.
 */

export type Gnss = 'auto' | 'rtk' | 'standard' | 'ignore';

/** What Start over fills the wizard with. */
export interface WizardInitial {
  /** null: the photos are gone (`missing` says why); the photos step starts empty. */
  source: PhotoSource | null;
  missing?: string;
  preset: PhotoPreset;
  gnss: Gnss;
  crs?: { epsg: number };
  products: PhotoProduct[];
  capture?: string;
  /** The run this one replaces: it goes to the trash once the new run has started. */
  replaces: string;
}

/** Start over is offered on these statuses only. */
export const START_OVER: ReadonlySet<PhotoRun['status']> = new Set(['failed', 'cancelled']);

const GNSS: ReadonlySet<string> = new Set(['auto', 'rtk', 'standard', 'ignore']);

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The products a run's settings name: an array, or `{ products: [] }`; unknown names dropped. */
function productsOf(settings: Record<string, unknown>): PhotoProduct[] {
  const raw = settings.products;
  const listed = Array.isArray(raw) ? (raw as unknown[]) : record(raw)?.products;
  if (!Array.isArray(listed)) return [];
  const out: PhotoProduct[] = [];
  for (const p of listed as unknown[]) {
    const parsed = PhotoProduct.safeParse(p);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

export function wizardInitialOf(
  run: Pick<PhotoRun, 'id' | 'photos' | 'preset' | 'crs' | 'settings' | 'capture'>,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
  missingFolders: readonly string[] = [],
): WizardInitial {
  const s = run.settings ?? {};
  const gnss = typeof s.gnss === 'string' && GNSS.has(s.gnss) ? (s.gnss as Gnss) : 'auto';
  const products = productsOf(s);
  let source: PhotoSource | null = run.photos.source;
  let missing: string | undefined;
  if ('layer' in source) {
    const layer = source.layer;
    if (!layers.some((l) => l.id === layer && l.kind === 'photos')) {
      source = null;
      missing = `The photos of run ${run.id} were removed from the project. Choose the photos again.`;
    }
  } else {
    const gone = source.folders.filter((f) => missingFolders.includes(f));
    const left = source.folders.filter((f) => !missingFolders.includes(f));
    if (left.length === 0) {
      source = null;
      missing = `The photo folders of run ${run.id} are not there any more (${gone.join(', ')}). Choose the photos again.`;
    } else if (gone.length > 0) {
      source = { folders: left };
      missing = `Some photo folders of run ${run.id} are not there any more: ${gone.join(', ')}.`;
    }
  }
  return {
    source,
    ...(missing !== undefined ? { missing } : {}),
    preset: run.preset,
    gnss,
    ...('epsg' in run.crs ? { crs: { epsg: run.crs.epsg } } : {}),
    products: products.length > 0 ? products : defaultProducts(run.preset),
    ...(run.capture !== undefined ? { capture: run.capture } : {}),
    replaces: run.id,
  };
}

/** What goes with the run Start over replaces, as main planned it when the wizard opened. */
export type OldRunPlan = { plan: RemovalPlan } | { error: string };

/**
 * The one line under the wizard's title: the old run and what it made go to the project trash
 * when the new run starts, plus anything else that goes with it (a comparison made from its maps);
 * or why it stays. The dialog's own words (`removeText`) name the extras.
 */
export function startOverLine(
  run: string,
  old: OldRunPlan,
  dateLabel: (captureId: string) => string,
): string {
  if ('error' in old) return `Run ${run} stays when this run starts: ${old.error}`;
  const { plan } = old;
  if (plan.refused !== undefined) return `Run ${run} stays when this run starts: ${plan.refused}`;
  // the run's own map layers and job folders are "what it made"; only the rest is named
  const own = plan.layers.filter(
    (l) => !(typeof l.why === 'object' && 'madeBy' in l.why && l.why.madeBy === run),
  );
  const extra = removeText([{ run }], { ...plan, layers: own, jobs: [] }, t, {
    dateLabel,
  }).also;
  const line = `Run ${run} and what it made go to the project trash when this run starts.`;
  return extra.length > 0 ? `${line} Also removes: ${extra.join(', ')}.` : line;
}

/** After **Start**: remove the replaced run when the start went through; a note when it could not. */
export async function replaceAfterStart(
  started: boolean,
  initial: WizardInitial | undefined,
  remove: (run: string) => Promise<string | null>,
): Promise<string | null> {
  if (!started || initial === undefined) return null;
  let error: string | null;
  try {
    error = await remove(initial.replaces);
  } catch (e) {
    // a removal that throws (the channel to main failed) is a note too, never a stop
    error = e instanceof Error ? e.message : String(e);
  }
  return error === null ? null : `Run ${initial.replaces} is still there: ${error}`;
}
