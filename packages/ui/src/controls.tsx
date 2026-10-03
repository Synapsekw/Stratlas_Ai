import type { CSSProperties, ReactNode } from 'react';

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
