/**
 * The open island: the 3D / Map / Split switch and the group tabs on top, the shown group's quick
 * row under them. Hovering or focusing a tab previews its row; clicking it picks the group and
 * opens its workbench in the right sidebar (D4). Left and Right move along a row (mirrored right
 * to left, as the foundation's Tabs do), Up and Down (and Tab) between the rows.
 */
import { Button, focusables, Icon, Tip, useT, type ShortcutId } from '@aio/ui';
import { useId, type Dispatch, type KeyboardEvent } from 'react';
import { shell } from '../../shell';
import type { StageMode } from '../../store';
import { GROUP_ICON, GROUP_NAME, MODES, quickRow, type GroupCtx } from './groups';
import type { GroupId, IslandEvent } from './islandModel';

const MODE_KEY: Record<StageMode, ShortcutId> = {
  '3d': 'scene.mode3d',
  map: 'scene.modeMap',
  split: 'scene.modeSplit',
};

/** Arrow and Tab keys in the open island; true when used. */
function moveFocus(root: HTMLElement, e: KeyboardEvent): boolean {
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
  mode,
  groups,
  group,
  preview,
  ctx,
  dispatch,
  onPick,
  onClose,
}: {
  mode: StageMode;
  groups: readonly GroupId[];
  /** The picked group (the selected tab). */
  group: GroupId;
  /** The group whose row shows while a tab is hovered or focused. */
  preview: GroupId | null;
  ctx: GroupCtx;
  dispatch: Dispatch<IslandEvent>;
  /** A group's tab clicked: the group is picked and its workbench opens. */
  onPick: (g: GroupId) => void;
  /** Close the tools and give focus back to the island. */
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const shown = preview && groups.includes(preview) ? preview : group;
  return (
    <div
      className="isl-tools"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest('.surface-pop')) return;
        if (moveFocus(e.currentTarget, e)) e.preventDefault();
      }}
    >
      <div className="isl-r1" data-isl-row="">
        <div className="seg isl-modes" role="group" aria-label={t('island.stageView')}>
          {MODES.map((m) => (
            <Tip key={m.mode} content={t(m.label)} shortcut={MODE_KEY[m.mode]} repeatsName>
              <button
                type="button"
                aria-pressed={mode === m.mode}
                aria-keyshortcuts={m.keys}
                aria-label={t(m.label)}
                onClick={() => {
                  shell.getState().setStageMode(m.mode);
                }}
              >
                <Icon name={m.icon} size={14} />
                <span className="isl-ml">{t(m.label)}</span>
              </button>
            </Tip>
          ))}
        </div>
        <span className="isl-vsep" aria-hidden="true" />
        <div className="seg isl-groups" role="tablist" aria-label={t('island.tools')}>
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              id={`${id}-${g}`}
              aria-selected={g === group}
              aria-controls={`${id}-panel`}
              className={g === shown ? 'isl-shown' : undefined}
              onPointerOver={() => {
                if (g !== shown) dispatch({ type: 'hoverGroup', group: g });
              }}
              onFocus={() => {
                if (g !== shown) dispatch({ type: 'hoverGroup', group: g });
              }}
              onClick={() => {
                onPick(g);
              }}
            >
              <Icon name={GROUP_ICON[g]} size={14} />
              <span className="isl-gl">{t(GROUP_NAME[g])}</span>
            </button>
          ))}
        </div>
        {/* Jobs is always reachable (I-R47), from every group: its workbench, with jobs running,
            quiet ones or none (a running job's reading also opens it) */}
        <Button
          variant="quiet"
          className="isl-jobs"
          data-testid="island-jobs"
          aria-label={t('island.tile.jobsName')}
          tip={t('island.tile.jobsName')}
          onClick={() => {
            ctx.openBench('jobs');
          }}
        >
          <Icon name="clock" size={14} />
        </Button>
        <Button
          variant="quiet"
          className="isl-x"
          aria-label={t('dialog.close')}
          tip={t('dialog.close')}
          onClick={onClose}
        >
          <span className="kbd">Esc</span>
          <Icon name="chevup" size={14} />
        </Button>
      </div>
      <div
        className="isl-r2"
        role="tabpanel"
        id={`${id}-panel`}
        aria-label={t(GROUP_NAME[shown])}
        data-isl-row=""
        key={shown}
      >
        {quickRow(shown, ctx)}
      </div>
    </div>
  );
}
