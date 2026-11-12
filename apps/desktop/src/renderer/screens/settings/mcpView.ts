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
 * The `mcp-remote` release the Claude Desktop setup runs: pinned, so a later release cannot change
 * what the pasted setup starts. The newest release at least two weeks old on 12 Nov 2026.
 */
export const MCP_REMOTE = 'mcp-remote@0.15.2';

/** Shown in a setup in place of the token while the token is hidden. */
export const TOKEN_PLACEHOLDER = '<token>';

/**
 * The `mcpServers` entry for Claude Desktop, which starts local servers as commands: `mcp-remote`
 * bridges it to the HTTP server. Claude Desktop on Windows mangles a command argument that holds
 * a space, so the header argument is `Authorization:${AUTH_HEADER}` (no space) and the value
 * `Bearer <token>` goes in the `AUTH_HEADER` environment variable, which mcp-remote expands
 * itself (the workaround its README gives).
 */
export function claudeDesktopSetup(name: string, url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [name]: {
          command: 'npx',
          args: ['-y', MCP_REMOTE, url, '--header', 'Authorization:${AUTH_HEADER}'],
          env: { AUTH_HEADER: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

export const ACCESS_KEY: Record<McpProjectAccess, MessageKey> = {
  allowed: 'mcp.access.allowed',
  'not-allowed': 'mcp.access.notAllowed',
  policy: 'mcp.access.policy',
  offline: 'mcp.access.offline',
};

export const accessServed = (a: McpProjectAccess) => a === 'allowed';
