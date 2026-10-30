/**
 * English UI strings: agent. Prefixes: `agent`.
 * Part of the `en` catalogue (see `../en.ts`). No em or en dashes.
 */
export const enAgent = {
  // Agent panel: provider errors fixed in place
  'agent.fix.workspace.title': 'Workspace ID needed',
  'agent.fix.workspace.text':
    'This Anthropic API key is not tied to a workspace, so every request must name one: enter the workspace ID from the Anthropic Console.',
  'agent.fix.workspace.label': 'Anthropic workspace ID',
  'agent.fix.workspace.placeholder': 'wrkspc_01...',
  'agent.fix.workspace.empty': 'Enter the workspace ID first.',
  'agent.fix.retry': 'Test and retry',
  'agent.fix.testing': 'Testing',
  'agent.fix.openSettings': 'Open AI settings',
  'agent.fix.dismiss': 'Dismiss',
  // The agent column of Issues, Media, Detections and Reports, and its title bar button
  'agent.dock.name': 'Agent',
  'agent.dock.label': 'Agent',
  'agent.dock.tip': 'Show or hide the agent',
  'agent.offRow': 'Agent off · Turn on',
  'agent.askAbout': 'Ask about {context}',
  'agent.maximise': 'Maximise',
  'agent.restore': 'Restore',
  'agent.minimise': 'Minimise',
} as const satisfies Record<string, string>;
