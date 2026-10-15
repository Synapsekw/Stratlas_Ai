/**
 * Executors of the placement tools (findings on a model): `place_on_model` and `add_sighting`.
 * The projection lives in @aio/annotate, which this package may not import, so both act through
 * `AppHooks` (registered by the desktop renderer, apps/desktop/src/renderer/placement).
 */
import { targetPoint } from './places';
import { define, plural, ToolError, type SightingAt } from './tool-kit';

const NEEDS_APP = 'Placing findings on a model is only in the desktop app.';

define('place_on_model', async (input, ctx) => {
  const hook = ctx.app?.placeOnModel;
  if (!hook) throw new ToolError(NEEDS_APP);
  const r = await hook({ ids: input.ids, layer: input.layer });
  const placed = r.outcomes.filter((o) => (o.placed?.length ?? 0) > 0).length;
  return {
    result: { layer: r.layer, outcomes: r.outcomes },
    summary: `${String(placed)} of ${plural(r.outcomes.length, 'finding')} placed on ${r.layer.name}`,
    ...(r.undo ? { undo: r.undo } : {}),
  };
});

define('add_sighting', async (input, ctx) => {
  const hook = ctx.app?.addSighting;
  if (!hook) throw new ToolError(NEEDS_APP);
  const where = input.at;
  const at: SightingAt =
    'photo' in where
      ? { kind: 'photo', photo: where.photo, box: where.box }
      : { kind: 'point', p: await targetPoint(ctx, where) };
  const r = await hook({ issue: input.issue, layer: input.layer, at });
  return {
    result: { code: r.code, placed: r.placed, ...(r.reason ? { reason: r.reason } : {}) },
    summary: `${r.code}: ${plural(r.placed.length, 'place')} added${r.reason ? ` (${r.reason})` : ''}`,
    ...(r.undo ? { undo: r.undo } : {}),
  };
});
