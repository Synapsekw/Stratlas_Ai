/**
 * English UI strings: the site digest (intelligence review I2). Prefixes: `insights`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enInsights = {
  // The digest at the top of the Project tab: what is worth a look on the site now
  'insights.title': 'Site digest',
  'insights.hint':
    'Read from survey QA, changes and volumes. Suggestions only: nothing is changed until you act.',
  'insights.clear': 'Nothing needs a look on this site right now.',
  'insights.more_one': 'Show 1 more',
  'insights.more_other': 'Show {count} more',
  'insights.less': 'Show fewer',
  'insights.severity.critical': 'Needs action',
  'insights.severity.warning': 'Check',
  'insights.severity.info': 'Note',
  // What each rule says (dates are formatted by the digest)
  'insights.held': 'Survey of {date} is on hold after a failed QA check',
  'insights.rmseOver': 'Checkpoint error on {date} is {rmse} cm, over the {limit} cm limit',
  'insights.unchecked': 'Survey of {date} has not been checked yet',
  'insights.noVerdict': 'Survey of {date} has no QA verdict: the site QA level is Off',
  'insights.noCheckpoints': 'Survey of {date} passed QA without checkpoints',
  'insights.changeStale': 'Changes from {from} to {to} are out of date after a line-up',
  'insights.changeReview_one': '1 change from {from} to {to} to review',
  'insights.changeReview_other': '{count} changes from {from} to {to} to review',
  'insights.pileDeparts': '{name} broke from its trend on {date}',
  'insights.pileGrew': '{name} grew {change} m³ ({pct}%) since {from}',
  'insights.pileShrank': '{name} shrank {change} m³ ({pct}%) since {from}',
  'insights.pileEmpties_one': '{name} runs out in about 1 day at {rate} m³ a day',
  'insights.pileEmpties_other': '{name} runs out in about {count} days ({date}) at {rate} m³ a day',
  // What the evidence holds, under the line
  'insights.evidence.figures_one': '1 figure measured on that date',
  'insights.evidence.figures_other': '{count} figures measured on that date',
  // The actions
  'insights.action.openQa': 'Open survey QA',
  'insights.action.openChanges': 'Review changes',
  'insights.action.flyTo': 'Fly to',
  'insights.action.compare': 'Compare dates',
  'insights.action.show': 'Show',
  'insights.notFound': 'That item is no longer in the project.',
} as const satisfies Record<string, string>;
