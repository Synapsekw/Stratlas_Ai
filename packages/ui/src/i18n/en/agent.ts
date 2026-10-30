/**
 * English UI strings: agent and the AI status. Prefixes: `agent`, `aiStatus`.
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
  'agent.dock.name': 'Ask AI',
  'agent.dock.label': 'Ask AI',
  'agent.dock.tip': 'Show or hide Ask AI',
  'agent.offRow': '{state} · Turn on',
  'agent.askAbout': 'Ask about {context}',
  'agent.maximise': 'Maximise',
  'agent.restore': 'Restore',
  'agent.minimise': 'Minimise',
  // The one AI status (shell/aiStatus.ts, shell/AiStatusChip.tsx)
  'aiStatus.ready': 'AI ready',
  'aiStatus.readyTip': 'Ask AI can answer now. Click to open it.',
  'aiStatus.local': 'Offline AI',
  'aiStatus.localTip':
    'Ask AI runs on the model on this computer, so nothing leaves it. Click to open Ask AI.',
  'aiStatus.noKey': 'AI off: no key',
  'aiStatus.noKeyTip': 'Ask AI needs an API key. Click to add one in Settings, AI providers.',
  'aiStatus.offline': 'AI off: offline',
  'aiStatus.offlineTip':
    'This workstation is offline only, so Ask AI sends nothing. Click to change it in Settings, Privacy and cloud.',
  'aiStatus.projectOff': 'AI off for this project',
  'aiStatus.projectOffTip':
    'This project keeps its data on this computer, so Ask AI sends nothing from it. Click for Settings, Privacy and cloud.',
  'aiStatus.cloudOff': 'AI off',
  'aiStatus.cloudOffTip': 'AI is turned off. Click to turn it on in Settings, Privacy and cloud.',
  'aiStatus.checking': 'Checking AI',
  'aiStatus.checkingTip': 'Checking whether Ask AI can answer.',
} as const satisfies Record<string, string>;
