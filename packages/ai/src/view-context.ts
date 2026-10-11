/**
 * What the person is looking at, for the agent: the screen that shows, the filters that are on and
 * the selected asset's findings. Text and numbers only, no photos, positions or notes. The hooks
 * belong to the host app and may be absent or fail, so this never throws.
 */
import { assetIndex, severityLabel } from './asset-index';
import { assetRef, severityRank, type RendererToolContext, type ViewFilters } from './tool-kit';

interface SelectedAsset {
  name: string;
  findings: number;
  open: number;
  /** The level name of the worst open finding; null when none is open. */
  worst: string | null;
}

/** The selected asset, once the model's bounds are known (before that nothing is said). */
function selectedAsset(ctx: RendererToolContext): SelectedAsset | null {
  const state = ctx.workspace.getState();
  const sel = state.selection;
  if (!state.project || sel?.kind !== 'asset') return null;
  const index = assetIndex(ctx);
  if (index.status !== 'ready') return null;
  // the selection carries the tag, or the model node the tag sits on
  const ref = assetRef(ctx, sel.id);
  const name = ref?.layer.tags?.find((t) => t.node === ref.node)?.tag;
  if (!name || !index.boxes.some((b) => b.tag === name)) return null;
  const here = state.issues.filter((i) => index.links.get(i.id)?.asset === name);
  const open = here.filter((i) => i.status !== 'closed');
  let worst = open[0] ?? null;
  for (const i of open)
    if (worst && severityRank(i.severity) > severityRank(worst.severity)) worst = i;
  return {
    name,
    findings: here.length,
    open: open.length,
    worst: worst ? severityLabel(ctx, worst) : null,
  };
}

/** The filters as they are, minus the words typed into the search: only that a search is on. */
function filtersOf(f: ViewFilters) {
  const { text, ...issues } = f.issues;
  return { ...f, issues: { ...issues, textFilter: text !== '' } };
}

export function viewContext(ctx: RendererToolContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // the app's hooks and the asset index fail apart: one failing keeps what the other gave
  try {
    const screen = ctx.app?.screen?.();
    if (screen) out.screen = screen;
    const filters = ctx.app?.viewFilters?.();
    if (filters) out.filters = filtersOf(filters);
  } catch {
    // the screen and the filters are optional context
  }
  try {
    const asset = selectedAsset(ctx);
    if (asset) out.selectedAsset = asset;
  } catch {
    // so is the selected asset
  }
  return out;
}
