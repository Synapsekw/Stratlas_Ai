import { createElement, type ReactNode, type ReactPortal } from 'react';
import { createPortal } from 'react-dom';

const ATTRS = ['data-surface', 'data-theme', 'data-contrast', 'data-motion', 'dir'] as const;
type SurfaceAttr = (typeof ATTRS)[number];

export type PortalSurfaceAttrs = Partial<Record<SurfaceAttr, string>>;

/**
 * The theme and surface a floating layer must wear to match the element that opened it: the
 * nearest value walking up from the opener, falling back to <html>. Portals render under <body>,
 * so without these a tip opened inside a dark map would pick up the page theme instead.
 */
export function portalSurfaceAttrs(opener: Element | null): PortalSurfaceAttrs {
  if (!opener) return {};
  const out: PortalSurfaceAttrs = {};
  for (const name of ATTRS) {
    const value =
      opener.closest(`[${name}]`)?.getAttribute(name) ??
      document.documentElement.getAttribute(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

export interface PortalRootProps {
  opener: Element | null;
  children: ReactNode;
  className?: string;
}

/** Renders floating UI into document.body, wearing the opener's surface attributes. */
export function PortalRoot({ opener, children, className }: PortalRootProps): ReactPortal {
  return createPortal(
    createElement('div', { className, ...portalSurfaceAttrs(opener) }, children),
    document.body,
  );
}
