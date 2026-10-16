import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from 'react';
import { Icon } from './icons/Icon';
import type { IconName } from './icons/paths';
import { ariaKeys, type ShortcutId } from './shortcuts';

export interface SevChipProps {
  /** Level colour from the project's severity model. */
  color: string | undefined;
  children: ReactNode;
  title?: string;
}

/** Severity chip tinted with the model colour. */
export function SevChip({ color, children, title }: SevChipProps) {
  const style = color
    ? ({
        '--sev': color,
        '--sev-a': `color-mix(in oklch, ${color} 18%, transparent)`,
      } as CSSProperties)
    : undefined;
  return (
    <span className="sev" style={style} title={title}>
      <i />
      {children}
    </span>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'icon' | 'link';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  size?: ButtonSize; // default 'sm'
  variant?: ButtonVariant; // default 'secondary'
  pressed?: boolean; // a toggle: sets aria-pressed
  busy?: boolean;
  disabled?: boolean; // no reason: native disabled
  disabledReason?: string; // aria-disabled, click ignored, reason in the tooltip
  icon?: IconName;
  shortcut?: ShortcutId;
  tip?: string;
}

const ICON_PX = { sm: 12, md: 14, lg: 16 } as const;

/**
 * The one button. `disabledReason` keeps the button focusable (aria-disabled,
 * clicks ignored) and describes why; `busy` swaps the icon for a spinner and
 * locks the width so the label does not jump.
 */
export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>> =
  forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
      size = 'sm',
      variant = 'secondary',
      pressed,
      busy,
      disabled,
      disabledReason,
      icon,
      shortcut,
      // Kept out of the DOM; rendered through Tip once the tooltip lands (integration task).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      tip,
      className,
      children,
      onClick,
      onKeyDown,
      onMouseDown,
      onPointerDown,
      style,
      type = 'button',
      'aria-describedby': describedBy,
      ...rest
    },
    ref,
  ) {
    const inner = useRef<HTMLButtonElement | null>(null);
    const reasonId = useId();
    const [lock, setLock] = useState<number | undefined>(undefined);
    const setRefs = useCallback(
      (node: HTMLButtonElement | null) => {
        inner.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    // Width lock: the last settled (non-busy) width, applied as min-width while busy.
    // Busy renders already swapped the icon for the spinner, so measuring then is too late.
    const settledWidth = useRef<number | undefined>(undefined);
    useLayoutEffect(() => {
      if (!busy) settledWidth.current = inner.current?.offsetWidth;
    });
    useLayoutEffect(() => {
      setLock(busy ? settledWidth.current : undefined);
    }, [busy]);

    const inert = Boolean(busy) || Boolean(disabledReason);
    const describe = [describedBy, disabledReason ? reasonId : undefined].filter(Boolean).join(' ');
    const cls = ['btn', size, variant, className].filter(Boolean).join(' ');
    return (
      <button
        {...rest}
        ref={setRefs}
        type={type}
        className={cls}
        style={lock ? { ...style, minWidth: lock } : style}
        disabled={disabled && !disabledReason ? true : undefined}
        aria-disabled={disabledReason ? true : undefined}
        aria-busy={busy ? true : undefined}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut ? ariaKeys(shortcut) : undefined}
        aria-describedby={describe || undefined}
        onKeyDown={inert ? undefined : onKeyDown}
        onMouseDown={inert ? undefined : onMouseDown}
        onPointerDown={inert ? undefined : onPointerDown}
        onClick={(e) => {
          if (inert) {
            // Inert: no caller handler, and no default action (a submit button must not submit).
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
      >
        {busy ? <span className="spin" aria-hidden="true" /> : null}
        {icon && !busy ? <Icon name={icon} size={ICON_PX[size]} /> : null}
        {children}
        {disabledReason ? (
          <span id={reasonId} className="sr-only">
            {disabledReason}
          </span>
        ) : null}
      </button>
    );
  });

export interface IconButtonProps extends Omit<ButtonProps, 'variant' | 'children' | 'icon'> {
  icon: IconName;
  label: string; // the accessible name and the tooltip
}

/** A square, icon-only button; `label` is its accessible name. */
export const IconButton: ForwardRefExoticComponent<
  IconButtonProps & RefAttributes<HTMLButtonElement>
> = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, ...rest },
  ref,
) {
  return <Button {...rest} ref={ref} variant="icon" icon={icon} aria-label={label} />;
});
