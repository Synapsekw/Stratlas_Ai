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

/** A dialog, a modal or a scrim: the app's dialogs sit on scrims between 80 and 110. */
const MODAL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="scrim"]';

export interface PortalRootProps {
  opener: Element | null;
  children: ReactNode;
  className?: string;
  /** 'top' always renders above every dialog (tips); otherwise only when the opener is in one. */
  layer?: 'top' | undefined;
}

/**
 * Renders floating UI into document.body, wearing the opener's surface attributes. Under body it
 * competes with the dialogs' layers, so an opener inside a dialog lifts it to the top layer
 * (`data-layer="top"`, `--z-top`); elsewhere it keeps its own layer (`--z-pop`).
 */
export function PortalRoot({ opener, children, className, layer }: PortalRootProps): ReactPortal {
  const top = layer === 'top' || opener?.closest(MODAL) != null;
  return createPortal(
    createElement(
      'div',
      { className, 'data-layer': top ? 'top' : undefined, ...portalSurfaceAttrs(opener) },
      children,
    ),
    document.body,
  );
}
