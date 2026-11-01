import { Icon, Menu, t, useT, type MenuItem } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useRef, useState, type ReactElement } from 'react';
import { setActiveSpace, useActiveSpace } from './activeSpace';

/**
 * The Space crumb of the title bar, between the project and the date: the active space's name and
 * a menu of the project's spaces. Picking one scopes the scene, the Layers column and the
 * findings. Hidden while the project has one space.
 */
export function SpaceSegment(): ReactElement | null {
  useT();
  const projectId = useWorkspace((s) => s.project?.id);
  const { spaceId, spaces } = useActiveSpace();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (projectId === undefined || spaces.length < 2) return null;
  const name = spaces.find((s) => s.id === spaceId)?.name ?? spaceId;
  const items: MenuItem[] = spaces.map((s) => ({
    id: s.id,
    label: s.name,
    checked: s.id === spaceId,
    radio: true,
    testId: `crumb-space-${s.id}`,
    onSelect: () => {
      setActiveSpace(projectId, s.id);
    },
  }));
  return (
    <div className="proj-wrap">
      <button
        ref={button}
        type="button"
        className="proj-switch"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('fly.space.crumb', { name })}
        data-testid="crumb-space"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <b dir="auto">{name}</b>
        <Icon name="chevdown" size={12} className="faint" />
      </button>
      <Menu
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        opener={button}
        label={t('fly.space.menu')}
        items={items}
      />
    </div>
  );
}
