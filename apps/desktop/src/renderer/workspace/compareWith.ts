import type { Layer } from '@aio/schema';
import { t, type MessageKey } from '@aio/ui';
import { captureIndex, workspace, type CaptureIndex } from '@aio/workspace';
import type { ReactNode } from 'react';
import { graphics, type GpuTier } from '../graphics';
import { shell } from '../shell';
import type { StageMode } from '../store';
import { compareNotice } from './compare';
import { framesState, splitWithFrames, type FramesSource } from './framesModel';
import { findPano, panoKey, panosOf } from './panoPair';
import { compareSplit, PER_CAPTURE, type PaneKind, type SplitPref } from './splitModel';
import { stagePrefs } from './stagePrefs';

/**
 * "Compare with": one entry point that puts a survey date, or a layer of one, beside the same on
 * another date. The tree menus and the progress report call it; nothing else opens a comparison
 * from a request. `planCompare` and `compareTargets` are pure; `compareWith` reads the stores.
 */

/** A date (no layers) or a layer or a group's layers of it, and the date to compare with. */
export interface CompareRequest {
  from: string;
  to: string;
  layers?: readonly string[];
}

export interface CompareContext {
  layers: readonly Layer[];
  index: CaptureIndex;
  stageMode: StageMode;
  split: SplitPref;
  tier: GpuTier;
}

export type CompareKind = PaneKind | 'frames';

/** The pane that compares a layer across dates, null for layers that do not compare. */
export function compareKindFor(layer: Layer): CompareKind | null {
  switch (layer.kind) {
    case 'mesh':
    case 'pointcloud':
      return '3d';
    case 'raster':
      return 'raster';
    case 'panoramas':
      return 'pano';
    case 'vector':
      return 'map';
    case 'video':
    case 'photos':
      return 'frames';
    default:
      return null;
  }
}

export interface ComparePlan {
  split: SplitPref;
  /** The Frames pane's view of the first date and the other date. */
  frames?: { source: FramesSource; other: string };
  notice?: 'lowTierMaps';
}

/** The first layer of the request that compares, in the request's order. */
function firstComparable(
  ids: readonly string[],
  layers: readonly Layer[],
): { layer: Layer; kind: CompareKind } | null {
  for (const id of ids) {
    const layer = layers.find((l) => l.id === id);
    const kind = layer ? compareKindFor(layer) : null;
    if (layer && kind) return { layer, kind };
  }
  return null;
}

const NEEDS: Partial<Record<CompareKind, { kinds: readonly Layer['kind'][]; reason: MessageKey }>> =
  {
    pano: { kinds: ['panoramas'], reason: 'compare.with.noPanoramas' },
    raster: { kinds: ['raster'], reason: 'compare.with.noRaster' },
    frames: { kinds: ['video', 'photos'], reason: 'compare.with.noMedia' },
  };

/** Why `to` cannot take the comparison of `kind` (null: it can). 3D and map never disable. */
function missing(kind: CompareKind, to: string, ctx: CompareContext): MessageKey | null {
  const need = NEEDS[kind];
  if (!need) return null;
  const here = (ctx.index.layers[to] ?? []).some((id) => {
    const l = ctx.layers.find((x) => x.id === id);
    return l !== undefined && need.kinds.includes(l.kind);
  });
  const common = ctx.layers.some(
    (l) => need.kinds.includes(l.kind) && ctx.index.of[l.id] === undefined,
  );
  return here || common ? null : need.reason;
}

export function planCompare(req: CompareRequest, ctx: CompareContext): ComparePlan | null {
  const { from, to } = req;
  const ids = ctx.index.captures.map((c) => c.id);
  if (from === to || !ids.includes(from) || !ids.includes(to)) return null;
  const dates = { captures: [from, to] };
  const picked = req.layers ? firstComparable(req.layers, ctx.layers) : null;
  if (req.layers && !picked) return null;

  let kind: CompareKind;
  if (picked) {
    kind = picked.kind;
    if (missing(kind, to, ctx)) return null;
  } else {
    kind =
      ctx.stageMode === 'map'
        ? 'map'
        : ctx.stageMode === 'split' && PER_CAPTURE.includes(ctx.split.left)
          ? ctx.split.left
          : '3d';
  }

  if (kind === 'frames') {
    const layer = picked?.layer;
    let source: FramesSource | null = null;
    if (layer?.kind === 'video') source = { kind: 'video', layer: layer.id };
    else if (layer?.kind === 'photos') {
      const photo = layer.items.find((p) => p.pos && p.q);
      if (photo) source = { kind: 'photo', layer: layer.id, photo: photo.id };
    }
    if (!source) return null;
    return { split: splitWithFrames(ctx.split), frames: { source, other: to } };
  }

  if (kind === '3d' && ctx.tier === 'low') {
    return { split: compareSplit(ctx.split, 'map', dates), notice: 'lowTierMaps' };
  }
  const split: SplitPref = compareSplit(ctx.split, kind, dates);
  if (kind === 'raster' && picked) split.raster = picked.layer.id;
  if (kind === 'pano' && picked) {
    const list = panosOf(ctx.layers, ctx.index, from).filter((a) => a.layer === picked.layer.id);
    const first = findPano(list, ctx.split.pano) ?? list[0];
    if (first) split.pano = panoKey(first);
    else delete split.pano;
  }
  return { split };
}

export interface CompareTarget {
  capture: string;
  /** Set: the date is listed but disabled, with this reason. */
  reason: MessageKey | null;
}

/** The dates to compare `from` with, newest first, each enabled or disabled with a reason. */
export function compareTargets(
  from: string,
  layers: readonly string[] | undefined,
  ctx: CompareContext,
): CompareTarget[] {
  const picked = layers ? firstComparable(layers, ctx.layers) : null;
  return ctx.index.captures
    .map((c) => c.id)
    .filter((id) => id !== from)
    .reverse()
    .map((capture) => ({
      capture,
      reason: !layers ? null : picked ? missing(picked.kind, capture, ctx) : 'compare.with.nothing',
    }));
}

/** Reads the stores, applies the plan and opens the split. False when there is nothing to open. */
export function compareWith(req: CompareRequest): boolean {
  const project = workspace.getState().project;
  if (!project) return false;
  const sh = shell.getState();
  const plan = planCompare(req, {
    layers: project.manifest.layers,
    index: captureIndex(project.manifest),
    stageMode: sh.stageMode,
    split: stagePrefs.getState().byProject[project.id]?.split ?? { left: '3d', right: 'map' },
    tier: graphics().getState().tier,
  });
  if (!plan) return false;
  stagePrefs.getState().update(project.id, { split: plan.split });
  if (plan.frames) {
    framesState.getState().setSource(plan.frames.source);
    framesState.getState().setOther(plan.frames.other);
  }
  if (plan.notice) compareNotice.getState().show(t('stage.compare.lowTierMaps'));
  else compareNotice.getState().clear();
  sh.setStageMode('split');
  return true;
}

/** Extra rows of the Compare with menu (the progress report adds its own with one push). */
export const COMPARE_WITH_ACTIONS: ((p: {
  request: CompareRequest;
  close: () => void;
}) => ReactNode)[] = [];
