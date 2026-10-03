import { ICONS, type IconName } from './paths';

export type IconSize = 12 | 14 | 16 | 20;

export interface IconProps {
  name: IconName;
  size?: IconSize;
  className?: string;
  /** Accessible label; without it the icon is decorative. */
  label?: string;
}

/** One icon from the Mission set, drawn inline so it inherits `currentColor`. */
export function Icon({ name, size = 16, className, label }: IconProps) {
  return (
    <svg
      className={className ? `i ${className}` : 'i'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

export { ICONS, type IconName };
