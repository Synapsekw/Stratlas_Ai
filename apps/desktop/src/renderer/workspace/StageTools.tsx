/**
 * The stage's tool buttons: `Tool`, `PopTool` and the live engine stage. Each group's tools are in
 * `tools/*.tsx` (view, measure, display, cloud, video, annotate).
 */
import { getActiveStage, onActiveScene, type EngineStage } from '@aio/engine';
import {
  ariaKeys,
  Icon,
  shortcutHint,
  useFocusTrap,
  type IconName,
  type ShortcutId,
} from '@aio/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { usePopPlacement } from './popPlacement';

/** The live 3D stage (view presets, tools, section), re-rendering on tool and section changes. */
export function useEngineStage(): EngineStage | null {
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => stage?.onStateChange(bump), [stage]);
  return stage;
}

/** Tooltip text with an optional key hint. */
function Tip({ label, keys, end }: { label: string; keys?: string | undefined; end?: boolean }) {
  return (
    <span className={`tip${end ? ' tip-end' : ''}`}>
      {label}
      {keys && <span className="kbd">{keys}</span>}
    </span>
  );
}

interface ToolProps {
  icon: IconName;
  label: string;
  keys?: string | undefined;
  /** The registry shortcut (Settings, Keyboard) this tool also answers to; names its key. */
  shortcut?: ShortcutId;
  pressed?: boolean;
  disabled?: boolean;
  /** A `data-testid` for the e2e specs. */
  testId?: string;
  onClick: () => void;
}

/** A square stage tool with a tooltip that names its shortcut. */
export function Tool({
  icon,
  label,
  keys,
  shortcut,
  pressed,
  disabled,
  testId,
  onClick,
}: ToolProps) {
  const hint = shortcut ? shortcutHint(shortcut) : keys;
  return (
    <button
      type="button"
      className="tool"
      aria-pressed={pressed}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaKeys(shortcut) : keys}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon name={icon} />
      <Tip label={label} keys={hint} />
    </button>
  );
}

/**
 * A tool button that opens a panel below it; closes on outside click and Escape. Pass `open` and
 * `onOpenChange` to open it from elsewhere (the sidebar, the command palette).
 */
export function PopTool({
  icon,
  label,
  keys,
  shortcut,
  pressed,
  disabled,
  wide,
  open: openProp,
  onOpenChange,
  children,
}: {
  icon: IconName;
  label: string;
  keys?: string | undefined;
  shortcut?: ShortcutId;
  pressed?: boolean;
  disabled?: boolean;
  wide?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const change = useRef(onOpenChange);
  useLayoutEffect(() => {
    change.current = onOpenChange;
  });
  const controlled = openProp !== undefined;
  const setOpen = useCallback(
    (o: boolean) => {
      if (!controlled) setOwn(o);
      change.current?.(o);
    },
    [controlled],
  );
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // on the stage, never under the timeline or the Context panel; it scrolls when the stage is short
  usePopPlacement(open, ref, pop);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open, setOpen]);
  // focus moves into the panel, Tab stays inside, Esc closes and focus returns to the tool
  useFocusTrap(pop, open, {
    onEscape: () => {
      setOpen(false);
    },
    returnTo: () => button.current,
  });
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        ref={button}
        type="button"
        className="tool"
        aria-pressed={pressed ?? open}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        aria-keyshortcuts={shortcut ? ariaKeys(shortcut) : keys}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name={icon} />
        <span className="caret" aria-hidden />
        {!open && <Tip label={label} keys={shortcut ? shortcutHint(shortcut) : keys} />}
      </button>
      {open && (
        <div
          ref={pop}
          className={`stage-pop overlay-box${wide ? ' wide' : ''}`}
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </div>
  );
}
