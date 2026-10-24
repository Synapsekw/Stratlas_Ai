import type { Layer, ProjectManifest } from '@aio/schema';
import { t as translate } from '../i18n';
import { shortcutHint } from '../shortcuts';
import {
  NO_HOST,
  SECTION_ORDER,
  type Action,
  type ActionCtx,
  type MenuTarget,
  type ResolvedItem,
} from './types';

const registered: Action[] = [];

/** Add actions (an id registered before is replaced in place); returns the unregister. */
export function registerActions(actions: readonly Action[]): () => void {
  for (const a of actions) {
    const at = registered.findIndex((r) => r.id === a.id);
    if (at >= 0) registered.splice(at, 1, a);
    else registered.push(a);
  }
  return () => {
    for (const a of actions) {
      const at = registered.indexOf(a);
      if (at >= 0) registered.splice(at, 1);
    }
  };
}

/** Type an action against the target kinds it names; the registry holds it as a plain `Action`. */
export function defineAction<K extends MenuTarget['kind']>(
  a: Action<Extract<MenuTarget, { kind: K }>> & { targets: readonly K[] },
): Action {
  return a as unknown as Action;
}

/** How many items a target holds: layers, distinct photos; one for anything else. */
export function targetCount(t: MenuTarget): number {
  if (t.kind === 'layers') return t.layerIds.length;
  if (t.kind === 'measurements' || t.kind === 'antennas') return t.ids.length;
  if (t.kind === 'photos') return new Set(t.picks.map((p) => `${p.layerId}\n${p.photoId}`)).size;
  if (t.kind === 'media')
    return new Set(
      t.picks.map(
        (p) => `${p.layerId}
${p.itemId}`,
      ),
    ).size;
  return 1;
}

/** The manifest layers a target names (a photos target: the sets its photos belong to). */
export function targetLayers(t: MenuTarget, ctx: ActionCtx): Layer[] {
  const ids =
    t.kind === 'layers' || t.kind === 'group'
      ? t.layerIds
      : t.kind === 'photos' || t.kind === 'media'
        ? [...new Set(t.picks.map((p) => p.layerId))]
        : [];
  return ids.flatMap((id) => {
    const l = ctx.manifest.layers.find((x) => x.id === id);
    return l ? [l] : [];
  });
}

/** True when the target names layers and `pred` holds for every one of them. */
export function everyLayer(t: MenuTarget, ctx: ActionCtx, pred: (l: Layer) => boolean): boolean {
  const ls = targetLayers(t, ctx);
  return ls.length > 0 && ls.every(pred);
}

/** The items of a menu on `target`: sorted by section, then by registration order. */
export function actionsFor(target: MenuTarget, ctx: ActionCtx): ResolvedItem[] {
  const many = targetCount(target) > 1;
  const order = new Map<ResolvedItem, number>();
  const out: ResolvedItem[] = [];
  registered.forEach((a, i) => {
    if (!a.targets.includes(target.kind)) return;
    if (many && a.multi !== true) return;
    if (a.appliesTo && !a.appliesTo(target, ctx)) return;
    const disabled = a.disabled?.(target, ctx) ?? false;
    const item: ResolvedItem = {
      id: a.id,
      label: typeof a.label === 'function' ? a.label(target, ctx) : translate(a.label),
      ...(a.icon ? { icon: a.icon } : {}),
      section: a.section,
      disabled,
      shortcut: a.shortcut ? shortcutHint(a.shortcut) : null,
      testId: a.testId ?? `ctx-item-${a.id}`,
      present: a.submenu ? (a.present ?? 'submenu') : 'action',
      sub: a.submenu?.(target, ctx) ?? [],
      subTitle: a.submenuTitle?.(target, ctx) ?? null,
      run: (sub) => {
        if (disabled !== false) return;
        const fail = (e: unknown) => {
          ctx.host.note(e instanceof Error ? e.message : String(e), true);
        };
        try {
          const r = a.run(target, ctx, sub);
          if (r instanceof Promise) r.catch(fail);
        } catch (e) {
          fail(e);
        }
      },
    };
    order.set(item, i);
    out.push(item);
  });
  const rank = (x: ResolvedItem) => SECTION_ORDER.indexOf(x.section);
  return out.sort((x, y) => rank(x) - rank(y) || (order.get(x) ?? 0) - (order.get(y) ?? 0));
}

/** A full context from the fields a caller knows; the rest take neutral defaults. */
export function makeActionCtx(
  input: { manifest: ProjectManifest } & Partial<ActionCtx>,
): ActionCtx {
  return {
    hidden: {},
    canEdit: true,
    pkg: false,
    datesOn: true,
    focus: null,
    tags: {},
    folderLayers: {},
    trashEntries: 0,
    drafts: 0,
    host: NO_HOST,
    ...input,
  };
}
