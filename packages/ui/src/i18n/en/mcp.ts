/**
 * English UI strings: the local MCP server (intelligence review Wave 3, X1), Settings > AI
 * providers > Outside apps (MCP). Prefixes: `mcp`. Part of the `en` catalogue (see `../en.ts`).
 * No em or en dashes.
 */
export const enMcp = {
  'mcp.title': 'Outside apps (MCP)',
  'mcp.sub': 'Other AI apps on this computer can read the open project',
  'mcp.intro':
    'Claude Code, Claude Desktop and other MCP apps on this computer can ask the open project what the agent can read: issues, measurements, volumes, survey dates, detections and the project search. They cannot change anything, move the view or see photos. Only apps on this computer that have the token can connect.',
  'mcp.switch': 'Outside apps server',
  'mcp.on': 'On, {count} read-only tools',
  'mcp.off': 'Off',
  'mcp.address': 'Address',
  'mcp.token': 'Token',
  'mcp.tokenHidden': 'Hidden',
  'mcp.show': 'Show',
  'mcp.hide': 'Hide',
  'mcp.copy': 'Copy',
  'mcp.copied': 'Copied',
  'mcp.copyLabel': 'Copy the {what}',
  'mcp.newToken': 'New token',
  'mcp.newTokenDone': 'New token made. Every app was disconnected: paste the new setup into each.',
  'mcp.setup': 'Set up an app',
  'mcp.setup.code': 'Claude Code: run in a terminal',
  'mcp.setup.desktop': 'Claude Desktop: add to claude_desktop_config.json (needs Node.js)',
  'mcp.clients': 'Connected apps',
  'mcp.none': 'No app is connected.',
  'mcp.since': 'Connected {time}',
  'mcp.calls_one': '{count} call',
  'mcp.calls_other': '{count} calls',
  'mcp.disconnect': 'Disconnect',
  'mcp.disconnectLabel': 'Disconnect {name}',
  'mcp.project': 'This project',
  'mcp.allow': 'Let outside apps read this project',
  'mcp.noProject': 'Open a project to choose whether outside apps may read it.',
  'mcp.access.cloud': 'Served: cloud AI may read this project, so outside apps may too.',
  'mcp.access.allowed': 'Served: you let outside apps read this project.',
  'mcp.access.policy': 'Not served: this project forbids AI outside the app.',
  'mcp.access.cloudOff':
    'Not served: cloud AI is off for this project, and outside apps are treated like cloud AI. Turn on the switch above to let them read it anyway.',
} as const satisfies Record<string, string>;
