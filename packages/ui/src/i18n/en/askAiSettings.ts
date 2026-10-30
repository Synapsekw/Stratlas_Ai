/**
 * Custom analytics: the project privacy switch strings. Owned by Task 7 of the plan, so parallel tasks never edit en.ts.
 * No em or en dashes.
 */
export const enAskSettings = {
  'settings.projectPrivacy.title': 'This project',
  'settings.projectPrivacy.keepLocal': "Keep this project's images on this PC",
  'settings.projectPrivacy.on':
    'Nothing from this project is sent to a cloud AI provider. Ask AI uses the model on this PC.',
  'settings.projectPrivacy.off': 'Cloud runs still ask before anything is sent.',
  'settings.projectPrivacy.package': "A package's AI sharing is set by whoever made it.",
} as const satisfies Record<string, string>;
