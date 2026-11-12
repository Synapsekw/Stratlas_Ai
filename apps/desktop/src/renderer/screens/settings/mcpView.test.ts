import { describe, expect, it } from 'vitest';
import { claudeCodeSetup, claudeDesktopSetup, MCP_REMOTE, mcpServerName } from './mcpView';

const URL = 'http://127.0.0.1:41234/mcp';

describe('MCP setup snippets', () => {
  it('names the server after the product', () => {
    expect(mcpServerName('Acme Survey AI')).toBe('acme-survey-ai');
    expect(mcpServerName('!!')).toBe('desktop');
  });
  it('gives Claude Code an HTTP server with the bearer header', () => {
    expect(claudeCodeSetup('app', URL, 'tok')).toBe(
      'claude mcp add --transport http app http://127.0.0.1:41234/mcp --header "Authorization: Bearer tok"',
    );
  });
  it('gives Claude Desktop a pinned mcp-remote with no space in any argument', () => {
    const cfg = JSON.parse(claudeDesktopSetup('app', URL, 'tok')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(cfg.mcpServers.app).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-remote@0.15.2', URL, '--header', 'Authorization:${AUTH_HEADER}'],
      env: { AUTH_HEADER: 'Bearer tok' },
    });
    for (const a of cfg.mcpServers.app?.args ?? []) expect(a).not.toContain(' ');
    // an exact version, never a range or latest
    expect(MCP_REMOTE).toMatch(/^mcp-remote@\d+\.\d+\.\d+$/);
  });
});
