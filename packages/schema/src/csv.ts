/**
 * CSV formula injection guard, shared by every CSV the app writes: a text cell that a spreadsheet
 * would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a
 * leading apostrophe, so it is shown as the text it is. Use it on text cells only: numbers,
 * negative ones included, are written as they are.
 */
export function csvText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Undo {@link csvText} when a CSV the app wrote is read back in. */
export function csvUntext(v: string): string {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}
