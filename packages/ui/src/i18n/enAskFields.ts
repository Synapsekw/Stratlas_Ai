/**
 * Custom analytics: the field value form strings. Owned by Task 14 of the plan, so parallel tasks never edit en.ts.
 * No em or en dashes.
 */
export const enAskFields = {
  'fields.title': 'Values',
  'fields.yes': 'Yes',
  'fields.no': 'No',
  'fields.unknown': 'Unknown',
  'fields.none': 'Not read',
  'fields.edit': 'Fix the values before you accept',
  'fields.pick': 'Pick one',
  'fields.change.new': 'New',
  'fields.change.removed': 'Removed',
  'fields.change.moved': 'Moved',
  'fields.change.progress': 'Progress',
  'fields.change.damage': 'Damage',
} as const satisfies Record<string, string>;
