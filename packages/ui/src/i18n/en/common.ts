/**
 * English UI strings: everything else. Prefixes: `dialog`, `toast`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enCommon = {
  'dialog.close': 'Close',
  // the toast host's count of toasts waiting behind the one it shows
  'toast.waiting': '{count} more',
} as const satisfies Record<string, string>;
