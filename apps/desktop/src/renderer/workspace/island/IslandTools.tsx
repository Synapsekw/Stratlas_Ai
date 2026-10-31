/**
 * The open notch under its line (Island.tsx, which draws the line once so it never moves): the
 * labelled mode tabs (UI revision W8: View, Measure, Annotate, Volumes, Compare, Video, Road),
 * Jobs, Keep open and Close, then the shown mode's slim row of its top tools. Hovering or focusing
 * a tab previews its row; clicking it picks the mode and opens its section in the right panel.
 * A mode that cannot be picked here is greyed out with its reason. Left and Right move along a row (mirrored right to left, as the foundation's Tabs do), Up
 * and Down (and Tab) between the rows, the line's among them (`moveFocus`).
 */
import { Button, focusables, Icon, Tip, useT, type ShortcutId } from '@aio/ui';
import { useId, useRef, type Dispatch, type KeyboardEvent, type ReactNode } from 'react';
import { shell } from '../../shell';
import type { StageMode } from '../../store';
import { stageModeAvailable, type IslandModeDef, type ToolCtx } from '../../tools/registry';
import { ModeRow, MODES, type GroupCtx } from './groups';
import type { GroupId, IslandEvent } from './islandModel';

const MODE_KEY: Record<StageMode, ShortcutId> = {
  '3d': 'scene.mode3d',
  map: 'scene.modeMap',
  split: 'scene.modeSplit',
};

/** The 3D / Map / Split switch: always on the notch's line. */
export function IslandModes({ mode, ctx }: { mode: StageMode; ctx: ToolCtx }) {
  const t = useT();
  const id = useId();
  return (
    <div className="seg isl-modes" role="group" aria-label={t('island.stageView')}>
      {MODES.map((m) => {
        const can = stageModeAvailable(m.mode, ctx);
        const reason = can === true ? undefined : t(can.reason);
        return (
          <Tip
            key={m.mode}
            content={reason ?? t(m.label)}
            repeatsName
            {...(reason ? {} : { shortcut: MODE_KEY[m.mode] })}
          >
            <button
              type="button"
              aria-pressed={mode === m.mode}
              aria-keyshortcuts={m.keys}
              aria-label={t(m.label)}
              aria-disabled={reason ? true : undefined}
              aria-describedby={reason ? `${id}-${m.mode}` : undefined}
              onClick={() => {
                if (!reason) shell.getState().setStageMode(m.mode);
              }}
            >
              <Icon name={m.icon} size={14} />
              <span className="isl-ml">{t(m.label)}</span>
              {/* a view that cannot be picked here says why (read with its name) */}
              {reason && (
                <span className="sr-only" id={`${id}-${m.mode}`}>
                  {reason}
                </span>
              )}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** Arrow and Tab keys in the open notch (its rows: `data-isl-row`, the line first); true when used. */
export function moveFocus(root: HTMLElement, e: KeyboardEvent): boolean {
  const rows = [...root.querySelectorAll<HTMLElement>('[data-isl-row]')];
  const at = document.activeElement as HTMLElement | null;
  const r = rows.findIndex((row) => at && row.contains(at));
  if (r < 0) return false;
  const row = rows[r];
  if (!row) return false;
  const items = focusables(row);
  const i = at ? items.indexOf(at) : -1;
  const enter = (to: number) => {
    const target = rows[(to + rows.length) % rows.length];
    if (!target) return;
    const list = focusables(target);
    (list.find((el) => el.getAttribute('aria-selected') === 'true') ?? list[0])?.focus();
  };
  // right to left the next item lies to the left (packages/ui Tabs.tsx)
  const dir = root.closest('[dir]')?.getAttribute('dir') ?? document.documentElement.dir;
  const flip = dir === 'rtl' ? -1 : 1;
  const along = (by: number) => {
    items[Math.min(items.length - 1, Math.max(0, i + by))]?.focus();
  };
  switch (e.key) {
    case 'ArrowRight':
      along(flip);
      return true;
    case 'ArrowLeft':
      along(-flip);
      return true;
    case 'Home':
      items[0]?.focus();
      return true;
    case 'End':
      items[items.length - 1]?.focus();
      return true;
    case 'ArrowDown':
      if (r < rows.length - 1) enter(r + 1);
      return true;
    case 'ArrowUp':
      if (r > 0) enter(r - 1);
      return true;
    case 'Tab':
      enter(r + (e.shiftKey ? -1 : 1));
      return true;
    default:
      return false;
  }
}

export function IslandTools({
  groups,
  group,
  preview,
  ctx,
  dispatch,
  onPick,
  onJobs,
  end,
}: {
  groups: readonly IslandModeDef[];
  /** The picked group (the selected tab). */
  group: GroupId;
  /** The group whose row shows while a tab is hovered or focused. */
  preview: GroupId | null;
  ctx: GroupCtx;
  dispatch: Dispatch<IslandEvent>;
  /** A mode's tab clicked: the mode is picked and its section opens. */
  onPick: (g: GroupId) => void;
  /** Jobs: its section in the right panel. */
  onJobs: () => void;
  /** After Jobs at the tab row's end: Keep open and Close. */
  end: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const shown = preview && groups.some((m) => m.id === preview) ? preview : group;
  // Where the pointer last moved over the tabs. Previewing a tab can widen it (its name shows on
  // a narrow stage), which slides the tabs under a pointer that has not moved; the browser then
  // reports a move at the same spot, and acting on it would bounce the preview between tabs.
  const last = useRef<{ x: number; y: number } | null>(null);
  return (
    <div className="isl-tools">
      <div className="isl-tabs" data-isl-row="">
        <div className="seg isl-groups" role="tablist" aria-label={t('island.tools')}>
          {groups.map((m) => {
            const g = m.id;
            const can = m.available(ctx.tool);
            const reason = can === true ? undefined : t(can.reason);
            return (
              <button
                key={g}
                type="button"
                role="tab"
                id={`${id}-${g}`}
                aria-selected={g === group}
                aria-controls={`${id}-panel`}
                aria-disabled={reason ? true : undefined}
                className={g === shown ? 'isl-shown' : undefined}
                onPointerMove={(event) => {
                  const at = { x: event.clientX, y: event.clientY };
                  const still = last.current?.x === at.x && last.current.y === at.y;
                  last.current = at;
                  if (!still && g !== shown) dispatch({ type: 'hoverGroup', group: g });
                }}
                onFocus={() => {
                  if (g !== shown) dispatch({ type: 'hoverGroup', group: g });
                }}
                onClick={() => {
                  if (!reason) onPick(g);
                }}
              >
                <Icon name={m.icon} size={14} />
                <span className="isl-gl">{t(m.labelKey)}</span>
                {/* a mode that cannot be picked here says why (read with its name) */}
                {reason && <span className="sr-only">{reason}</span>}
              </button>
            );
          })}
        </div>
        {/* Jobs is always reachable (I-R47), from every group: its workbench, with jobs running,
            quiet ones or none (a running job's reading also opens it) */}
        <Button
          variant="quiet"
          className="isl-jobs"
          data-testid="island-jobs"
          aria-label={t('island.tile.jobsName')}
          tip={t('island.tile.jobsName')}
          onClick={onJobs}
        >
          <Icon name="clock" size={14} />
        </Button>
        {end}
      </div>
      <div
        className="isl-r2"
        role="tabpanel"
        id={`${id}-panel`}
        aria-label={t(groups.find((m) => m.id === shown)?.labelKey ?? 'island.tools')}
        data-isl-row=""
        key={shown}
      >
        <ModeRow mode={shown} ctx={ctx} />
      </div>
    </div>
  );
}
