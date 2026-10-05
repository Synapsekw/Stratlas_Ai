/**
 * Reduced motion: the OS asks for it (prefers-reduced-motion) or the app set
 * `<html data-motion="reduce">` (Settings, Appearance, Reduce motion). Camera flights then jump.
 */
export function reducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce')
    return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
