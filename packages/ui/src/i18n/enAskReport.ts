/**
 * Custom analytics: the report field table strings. Owned by Task 9 of the plan, so parallel tasks never edit en.ts.
 * No em or en dashes.
 */
export const enAskReport = {
  'house.fields.title': 'Recorded values',
  'house.fields.code': 'Code',
  'house.fields.finding': 'Finding',
  'report.fields.yes': 'Yes',
  'report.fields.no': 'No',
  'report.fields.unknown': 'Unknown',
  'report.fields.none': 'Not read',
} as const satisfies Record<string, string>;
