import { useT } from '@aio/ui';
import { useEffect, useRef } from 'react';

export interface IssueRowMenuProps {
  /** Client pixels of the right-click. */
  x: number;
  y: number;
  /** How many issues the menu acts on. */
  count: number;
  onPlace: () => void;
  onClose: () => void;
}

const MENU_W = 220;
const MENU_H = 44;

/** The issue list's right-click menu: actions the app set with `setIssueListActions`. */
export function IssueRowMenu({ x, y, count, onPlace, onClose }: IssueRowMenuProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || !ref.current?.contains(target)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8));
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="issue-row-menu"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 70,
        minWidth: 180,
        padding: 4,
        background: 'var(--bg-1, #12161c)',
        border: '1px solid var(--line-strong, #39424e)',
        borderRadius: 6,
        boxShadow: '0 12px 32px rgba(0,0,0,.45)',
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="ann-btn ghost"
        data-testid="issue-place-on-model"
        style={{ width: '100%', justifyContent: 'flex-start' }}
        onClick={() => {
          onPlace();
          onClose();
        }}
      >
        {t('place.menu', { count })}
      </button>
    </div>
  );
}
