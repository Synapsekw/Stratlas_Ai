/**
 * Custom analytics: the run and thread strings. Owned by Task 13 of the plan, so parallel tasks never edit en.ts.
 * No em or en dashes.
 */
export const enAskRun = {
  'askAi.custom.what': '{name}',
  'askAi.custom.busy': 'AI is answering {name}.',
  'askAi.custom.failed': 'The request did not finish: {error}',
  'askAi.custom.untitled': 'Custom request',
  'askAi.thread.draft': 'Draft',
  'askAi.thread.answerLabel': 'AI answer',
} as const satisfies Record<string, string>;
