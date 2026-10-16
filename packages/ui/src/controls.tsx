import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from 'react';
import type { IconName } from './icons/Icon';
import type { ShortcutId } from './shortcuts';

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

/** Stub: built in the button task. */
export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>> =
  forwardRef<HTMLButtonElement, ButtonProps>(() => {
    throw new Error('not built');
  });

export interface IconButtonProps extends Omit<ButtonProps, 'variant' | 'children' | 'icon'> {
  icon: IconName;
  label: string; // the accessible name and the tooltip
}

/** Stub: built in the button task. */
export const IconButton: ForwardRefExoticComponent<
  IconButtonProps & RefAttributes<HTMLButtonElement>
> = forwardRef<HTMLButtonElement, IconButtonProps>(() => {
  throw new Error('not built');
});
