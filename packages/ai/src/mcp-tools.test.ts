import { describe, expect, it } from 'vitest';
import {
  isMcpTool,
  MCP_TOOL_CLASS,
  mcpOutput,
  mcpToolList,
  mcpToolSpecs,
  parseMcpInput,
} from './mcp-tools';
import { allToolSpecs } from './tools';

describe('MCP tool parity with the agent registry', () => {
  it('classifies every read tool the agent has (add a line to MCP_TOOL_CLASS for a new one)', () => {
    const unclassified = allToolSpecs()
      .filter((s) => s.meta.risk === 'read')
      .map((s) => s.meta.name)
      .filter((n) => !(n in MCP_TOOL_CLASS));
    expect(unclassified).toEqual([]);
  });

  it('classifies only read tools that exist', () => {
    const read = new Set(
      allToolSpecs()
        .filter((s) => s.meta.risk === 'read')
        .map((s) => s.meta.name),
    );
    expect(Object.keys(MCP_TOOL_CLASS).filter((n) => !read.has(n))).toEqual([]);
  });

  it('never exposes a write, navigate or send tool, nor one whose risk depends on input', () => {
    for (const s of allToolSpecs()) {
      if (s.meta.risk !== 'read' || s.riskFor) expect(isMcpTool(s.meta.name)).toBe(false);
    }
    expect(mcpToolSpecs().every((s) => s.meta.risk === 'read' && !s.riskFor)).toBe(true);
    for (const name of ['create_issue_draft', 'run_action', 'capture_frame', 'fly_to', 'nope'])
      expect(isMcpTool(name)).toBe(false);
  });

  it('offers the fact index tools and leaves out the library-wide site list', () => {
    const names = mcpToolList().map((t) => t.name);
    expect(names).toContain('query_facts');
    expect(names).toContain('history_of');
    expect(names).not.toContain('list_sites');
  });
});

describe('mcpToolList', () => {
  it('takes the description and an object JSON schema from the agent spec', () => {
    const list = mcpToolList();
    const facts = list.find((t) => t.name === 'query_facts');
    const spec = allToolSpecs().find((s) => s.meta.name === 'query_facts');
    if (!facts || !spec) throw new Error('query_facts is missing');
    expect(facts.description).toBe(spec.meta.description);
    expect(facts.inputSchema.type).toBe('object');
    expect(Object.keys(facts.inputSchema.properties as object)).toEqual(
      expect.arrayContaining(['text', 'kinds', 'limit']),
    );
    expect(facts.annotations.readOnlyHint).toBe(true);
    for (const t of list) expect(t.inputSchema.type).toBe('object');
  });
});

describe('parseMcpInput', () => {
  it('validates against the spec and fills defaults', () => {
    const r = parseMcpInput('query_facts', { text: 'Stockpile' });
    expect(r).toEqual({ ok: true, input: { text: 'Stockpile', limit: 20 } });
  });
  it('answers a bad input and an unknown or write tool with a message', () => {
    expect(parseMcpInput('query_facts', { limit: 0 }).ok).toBe(false);
    expect(parseMcpInput('query_facts', { nope: 1 }).ok).toBe(false);
    expect(parseMcpInput('create_issue_draft', {})).toEqual({
      ok: false,
      error: 'Unknown tool "create_issue_draft".',
    });
  });
});

describe('mcpOutput', () => {
  it('is the result as JSON, and drops images', () => {
    expect(mcpOutput({ a: 1 }, 's')).toBe('{"a":1}');
    expect(mcpOutput(undefined, '3 issues')).toBe('{"summary":"3 issues"}');
    expect(JSON.parse(mcpOutput({ image: 'data:image/png;base64,AAAA', w: 2 }, ''))).toEqual({
      w: 2,
      image: 'omitted',
    });
  });
});
