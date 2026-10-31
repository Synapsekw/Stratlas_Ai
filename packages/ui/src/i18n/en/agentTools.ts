/**
 * English UI strings: what the agent's tool steps show in the panel (summaries, approval cards,
 * undo refusals) for the survey read tools and the menu actions (A2). Prefix: `agentTool`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes. Errors sent to the model stay
 * in the tools, in English, like every other tool's.
 */
export const enAgentTools = {
  // step summaries
  'agentTool.summary.measurements_one': '{count} measurement',
  'agentTool.summary.measurements_other': '{count} measurements',
  'agentTool.summary.piles_one': '{count} pile',
  'agentTool.summary.piles_other': '{count} piles',
  'agentTool.summary.locations_one': '{count} location',
  'agentTool.summary.locations_other': '{count} locations',
  'agentTool.summary.dates_one': '{count} survey date',
  'agentTool.summary.dates_other': '{count} survey dates',
  'agentTool.summary.inView': '{date} in view',
  'agentTool.summary.detections_one': '{count} detection',
  'agentTool.summary.detections_other': '{count} detections',
  'agentTool.summary.accepted_one': '{count} detection accepted as a draft issue',
  'agentTool.summary.accepted_other': '{count} detections accepted as draft issues',
  'agentTool.summary.rejected_one': '{count} detection rejected',
  'agentTool.summary.rejected_other': '{count} detections rejected',
  'agentTool.summary.reopened_one': '{count} detection reopened',
  'agentTool.summary.reopened_other': '{count} detections reopened',
  'agentTool.summary.jobs_one': '{count} job',
  'agentTool.summary.jobs_other': '{count} jobs',
  'agentTool.summary.hotSpots_one': '{count} hot spot',
  'agentTool.summary.hotSpots_other': '{count} hot spots',
  'agentTool.summary.walks_one': '{count} walk',
  'agentTool.summary.walks_other': '{count} walks',
  'agentTool.summary.actions_one': '{count} action',
  'agentTool.summary.actions_other': '{count} actions',
  'agentTool.summary.ran': '{action}',
  'agentTool.summary.confirm': '{action}: waiting for you to confirm in the app',
  'agentTool.summary.finish': '{action}: opened for you to finish',
  'agentTool.summary.kept_one': '{action}: {count} layer kept its date (its name carries one)',
  'agentTool.summary.kept_other':
    '{action}: {count} layers kept their date (their names carry one)',
  // approval cards
  'agentTool.card.run': '{action}: {target}',
  'agentTool.card.accept_one': 'Accept {count} detection as a draft issue',
  'agentTool.card.accept_other': 'Accept {count} detections as draft issues',
  'agentTool.card.reject_one': 'Reject {count} detection',
  'agentTool.card.reject_other': 'Reject {count} detections',
  'agentTool.card.reopen_one': 'Reopen {count} detection',
  'agentTool.card.reopen_other': 'Reopen {count} detections',
  // what an action acts on, on the card
  'agentTool.target.project': 'the project',
  'agentTool.target.everyDate': 'Every date',
  'agentTool.target.layerOn': '{name} ({date})',
  'agentTool.target.more': '{names} and {count} more',
  'agentTool.target.photos_one': '{count} photo in {layer}',
  'agentTool.target.photos_other': '{count} photos in {layer}',
  'agentTool.target.antennas_one': '{count} antenna',
  'agentTool.target.antennas_other': '{count} antennas',
  'agentTool.target.issues': 'the Issues rows',
  'agentTool.target.drafts': 'the Drafts rows',
  // undo refused
  'agentTool.undo.reviewedSince': 'Not undone: the detections were reviewed again since.',
  'agentTool.undo.reviewBlocked': 'Not undone: the review could not step back.',
  'agentTool.undo.otherProject': 'Not undone: another project is open.',
  'agentTool.undo.dateMovedSince': 'Not undone: the survey date in view changed since.',
} as const;
