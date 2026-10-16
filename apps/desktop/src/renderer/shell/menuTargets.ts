import { t, targetCount, type ActionCtx, type MenuTarget, type TreeItem } from '@aio/ui';

/** What a right-click on a row acts on: the marked rows when it is one of them, else the row. */
export function rowTarget(item: TreeItem, marked: ReadonlySet<string>): MenuTarget | null {
  if (!item.layerId && !item.children && (item.id === 'issues' || item.id === 'drafts'))
    return { kind: 'annotations', row: item.id };
  const own = item.children
    ? item.children.flatMap((c) => (c.layerId ? [c.layerId] : []))
    : item.layerId
      ? [item.layerId]
      : [];
  if (own.length === 0) return null;
  const onMarked = marked.size > 1 && own.some((id) => marked.has(id));
  return { kind: 'layers', layerIds: onMarked ? [...marked] : own };
}

/**
 * The heading of a menu. A date folder and a project name come as `name`; a group says how many
 * datasets it holds; one row says "Move to date" when it can be filed; several rows are counted.
 */
export function menuTitle(
  target: MenuTarget,
  ctx: ActionCtx,
  name: string,
  groupLabel?: string,
): string {
  switch (target.kind) {
    case 'group':
      return t('tree.dates.move.group', {
        group: groupLabel ?? name,
        count: target.layerIds.length,
      });
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
    default:
      return name;
  }
}
