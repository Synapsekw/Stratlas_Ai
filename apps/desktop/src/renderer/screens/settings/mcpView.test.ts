import { describe, expect, it } from 'vitest';
import { claudeCodeSetup, claudeDesktopSetup, mcpServerName } from './mcpView';

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
  it('gives Claude Desktop an mcp-remote command with the header in one argument', () => {
    const cfg = JSON.parse(claudeDesktopSetup('app', URL, 'tok')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers.app).toEqual({
      command: 'npx',
      args: ['-y', 'mcp-remote', URL, '--header', 'Authorization:Bearer tok'],
    });
  });
});
