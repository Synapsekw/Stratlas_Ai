/** True on macOS. In the renderer the user agent says so; tests pass a string. */
export function isMacPlatform(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return /Macintosh|Mac OS X/.test(userAgent);
}

/** macOS modifier symbols in Apple's order (Option, Shift, Command); Ctrl is Command there. */
const MAC_MODIFIERS: Record<string, { order: number; symbol: string }> = {
  Alt: { order: 0, symbol: '⌥' },
  Shift: { order: 1, symbol: '⇧' },
  Ctrl: { order: 2, symbol: '⌘' },
};

/**
 * A key combo label in the platform's own words (`keyLabel` and `shortcutHint` in shortcuts.ts
 * go through it, so the keyboard map does too). Written the Windows way ("Ctrl K", "Ctrl Alt B",
 * "Ctrl+Shift+F"); on macOS it becomes "⌘K", "⌥⌘B", "⇧⌘F", since every
 * handler in the app accepts Cmd wherever it accepts Ctrl.
 */
export function platformKeys(combo: string, mac: boolean = isMacPlatform()): string {
  if (!mac) return combo;
  const parts = combo.split(/[\s+]+/).filter(Boolean);
  const mods = parts
    .filter((p) => p in MAC_MODIFIERS)
    .sort((a, b) => (MAC_MODIFIERS[a]?.order ?? 0) - (MAC_MODIFIERS[b]?.order ?? 0))
    .map((p) => MAC_MODIFIERS[p]?.symbol ?? p);
  const keys = parts.filter((p) => !(p in MAC_MODIFIERS));
  return mods.join('') + keys.join(' ');
}
