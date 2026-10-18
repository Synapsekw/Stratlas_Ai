import {
  measureIdOf,
  t,
  targetCount,
  type ActionCtx,
  type MenuTarget,
  type TreeItem,
} from '@aio/ui';

/**
 * What a right-click on a row acts on: the marked rows when it is one of them, else the row.
 * Marked measurements are not layers: a layer row's menu leaves them out.
 */
export function rowTarget(item: TreeItem, marked: ReadonlySet<string>): MenuTarget | null {
  if (!item.layerId && !item.children && (item.id === 'issues' || item.id === 'drafts'))
    return { kind: 'annotations', row: item.id };
  const own = item.children
    ? item.children.flatMap((c) => (c.layerId ? [c.layerId] : []))
    : item.layerId
      ? [item.layerId]
      : [];
  if (own.length === 0) return null;
  const layers = [...marked].filter((id) => measureIdOf(id) === null);
  const onMarked = layers.length > 1 && own.some((id) => marked.has(id));
  return { kind: 'layers', layerIds: onMarked ? layers : own };
}

/**
 * What a right-click on a measurement row acts on: the marked measurements when it is one of two
 * or more, else the row; `clicked` is the row (Rename and Fly to act on it alone).
 */
export function measureTarget(
  id: string,
  marked: ReadonlySet<string>,
): Extract<MenuTarget, { kind: 'measurements' }> {
  const ids = [...marked].flatMap((m) => {
    const mid = measureIdOf(m);
    return mid === null ? [] : [mid];
  });
  return {
    kind: 'measurements',
    ids: ids.length > 1 && ids.includes(id) ? ids : [id],
    clicked: id,
  };
}

/**
 * The heading of a menu. A date folder, a group and a project come with their title as `name`;
 * one row says "Move to date" when it can be filed; several rows are counted.
 */
export function menuTitle(target: MenuTarget, ctx: ActionCtx, name: string): string {
  switch (target.kind) {
    case 'layers': {
      if (target.layerIds.length > 1)
        return t('actions.header.layers', { count: target.layerIds.length });
      const layer = ctx.manifest.layers.find((l) => l.id === target.layerIds[0]);
      const filed =
        ctx.datesOn &&
        ctx.canEdit &&
        layer !== undefined &&
        layer.kind !== 'basemap' &&
        layer.kind !== 'legacy';
      return filed ? `${t('tree.dates.move.title')} · ${name}` : name;
    }
    case 'photos':
      return t('actions.header.photos', { count: targetCount(target) });
    case 'measurements':
      return target.ids.length > 1
        ? t('actions.header.measurements', { count: target.ids.length })
        : name;
    default:
      return name;
  }
}
