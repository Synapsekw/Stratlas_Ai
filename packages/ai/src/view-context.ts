/**
 * What the person is looking at, for the agent: the screen that shows, the filters that are on and
 * the selected asset's findings. Text and numbers only, no photos, positions or notes. The hooks
 * belong to the host app and may be absent or fail, so this never throws.
 */
import { assetIndex, severityLabel } from './asset-index';
import { project, severityRank, type RendererToolContext } from './tool-kit';

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
  const tags = project(ctx).manifest.layers.flatMap((l) =>
    l.kind === 'mesh' ? (l.tags ?? []) : [],
  );
  const name = tags.find((t) => t.tag === sel.id || t.node === sel.id)?.tag ?? sel.id;
  if (!index.boxes.some((b) => b.tag === name)) return null;
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

export function viewContext(ctx: RendererToolContext): Record<string, unknown> {
  try {
    const out: Record<string, unknown> = {};
    const screen = ctx.app?.screen?.();
    if (screen) out.screen = screen;
    const filters = ctx.app?.viewFilters?.();
    if (filters) out.filters = filters;
    const asset = selectedAsset(ctx);
    if (asset) out.selectedAsset = asset;
    return out;
  } catch {
    return {};
  }
}
