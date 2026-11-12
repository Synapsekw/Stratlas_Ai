/**
 * What Settings > AI providers > Outside apps (MCP) shows, as pure functions: the server name an
 * app lists the server under, the setup a person pastes into Claude Code or Claude Desktop, and
 * the sentence for the open project's access.
 */
import type { MessageKey } from '@aio/ui';
import type { McpProjectAccess } from '@aio/schema';

/** The name an MCP app lists the server under: the product name in lower case, dashed. */
export function mcpServerName(product: string): string {
  return (
    product
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'desktop'
  );
}

/** `claude mcp add` for Claude Code (Streamable HTTP with the bearer header). */
export function claudeCodeSetup(name: string, url: string, token: string): string {
  return `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${token}"`;
}

/**
 * The `mcpServers` entry for Claude Desktop, which starts local servers as commands: `mcp-remote`
 * bridges it to the HTTP server. No space after the colon in the header, so Windows keeps the
 * argument whole.
 */
export function claudeDesktopSetup(name: string, url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [name]: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', `Authorization:Bearer ${token}`],
        },
      },
    },
    null,
    2,
  );
}

export const ACCESS_KEY: Record<McpProjectAccess, MessageKey> = {
  cloud: 'mcp.access.cloud',
  allowed: 'mcp.access.allowed',
  policy: 'mcp.access.policy',
  'cloud-off': 'mcp.access.cloudOff',
};

export const accessServed = (a: McpProjectAccess) => a === 'cloud' || a === 'allowed';
