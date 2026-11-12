/**
 * English UI strings: the local MCP server (intelligence review Wave 3, X1), Settings > AI
 * providers > Outside apps (MCP). Prefixes: `mcp`. Part of the `en` catalogue (see `../en.ts`).
 * No em or en dashes.
 */
export const enMcp = {
  'mcp.title': 'Outside apps (MCP)',
  'mcp.sub': 'Other AI apps on this computer can read the open project',
  'mcp.intro':
    'Claude Code, Claude Desktop and other MCP apps on this computer can ask the open project what Ask AI can read: issues, measurements, volumes, survey dates, detections and the project search. They cannot change anything, move the view or see photos. Only apps on this computer that have the token can connect.',
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
  'mcp.newPort': 'Use a new port',
  'mcp.newPortDone':
    'The server moved to a new port with a new token: paste the new setup into each app.',
  'mcp.offline':
    'Offline only is on, so the server answers no app: outside apps usually pass what they read to a cloud model.',
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
  'mcp.access.allowed': 'Served: you let outside apps read this project.',
  'mcp.access.notAllowed':
    'Not served: outside apps read a project only once you turn on the switch above for it.',
  'mcp.access.policy': 'Not served: this project forbids AI outside the app.',
  'mcp.access.offline': 'Not served: offline only is on.',
} as const satisfies Record<string, string>;
