import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSecrets,
  maskId,
  REDACTED,
  redactSettings,
  redactText,
  redactValue,
  registerSecret,
} from './redact';

// Fake credentials, assembled at runtime so no scanner mistakes this file for a leak.
const ANTHROPIC = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
const OPENAI = `sk-proj-${'Zz9Yy8Xx'.repeat(5)}`;
const GOOGLE = ['AIza', 'Sy0123456789abcdefghijkl'].join('');
const JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'SflKxwRJSMeKKF2QT4fwpMeJf36P',
].join('.');
const WORKSPACE = 'wrkspc_01AbCdEfGhIjKlMnOp';
const ODD_KEY = 'my-own-gateway-key-0000-1111-2222';
const PASSWORD = 'correct horse battery';

const SECRETS = [ANTHROPIC, OPENAI, GOOGLE, JWT, ODD_KEY, 'hunter2!!', 'tok-123456789'];

function expectClean(text: string) {
  for (const s of SECRETS) expect(text).not.toContain(s);
  expect(text).not.toContain(WORKSPACE);
}

afterEach(() => {
  clearSecrets();
});

describe('redactText', () => {
  it('removes provider keys, bearer tokens and JWTs from a log line', () => {
    const line = `2026-10-05T08:00:00.000Z ERROR Anthropic 401 for ${ANTHROPIC}; OpenAI ${OPENAI}; Google ${GOOGLE}; Authorization: Bearer ${JWT}`;
    const out = redactText(line);
    expectClean(out);
    expect(out).toContain('Anthropic 401 for');
    expect(out).toContain(REDACTED);
  });

  it('removes values of secret-named pairs in JSON, query strings and key=value text', () => {
    const out = redactText(
      `{"apiKey":"tok-123456789","model":"claude"} https://feed.example.com/latest.yml?token=tok-123456789&channel=beta password=hunter2!! x-api-key: tok-123456789`,
    );
    expectClean(out);
    expect(out).toContain('"model":"claude"');
    expect(out).toContain('channel=beta');
  });

  it('removes credentials from URLs', () => {
    const out = redactText('Feed at https://admin:hunter2!!@updates.example.com/stratlas/');
    expectClean(out);
    expect(out).toContain('updates.example.com/stratlas/');
  });

  it('masks workspace IDs partly', () => {
    const out = redactText(`workspace ${WORKSPACE} and anthropic-workspace-id: ${WORKSPACE}`);
    expect(out).not.toContain(WORKSPACE);
    expect(out).toContain(maskId(WORKSPACE));
    expect(maskId(WORKSPACE).startsWith('wrks')).toBe(true);
    expect(maskId(WORKSPACE).endsWith('Op')).toBe(true);
  });

  it('removes a registered secret of any shape', () => {
    registerSecret(ODD_KEY);
    expectClean(redactText(`Gateway rejected ${ODD_KEY} (401)`));
  });

  it('leaves ordinary text alone and is idempotent', () => {
    const text = 'Opened project hcl-tower in 1.2 s; 3 layers, key frames ready.';
    expect(redactText(text)).toBe(text);
    const once = redactText(`token=tok-123456789 ${WORKSPACE}`);
    expect(redactText(once)).toBe(once);
  });
});

describe('redactValue', () => {
  it('removes secrets nested in objects and arrays', () => {
    const value = {
      provider: 'anthropic',
      auth: { apiKey: ANTHROPIC, headers: { Authorization: `Bearer ${JWT}` } },
      attempts: [{ key: ODD_KEY }, { note: `retry with ${OPENAI}` }],
      deep: { a: { b: { c: { password: PASSWORD, clientSecret: 'hunter2!!' } } } },
      workspaceId: WORKSPACE,
    };
    const out = JSON.stringify(redactValue(value));
    expectClean(out);
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain('"provider":"anthropic"');
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(JSON.stringify(redactValue(a))).toContain('[cut]');
  });
});

describe('redactSettings', () => {
  const settings = {
    cloudAi: true,
    theme: 'dark',
    sidebarCollapsed: false,
    dataRoot: 'D:\\Stratlas Data',
    routes: [{ task: 'chat', provider: 'anthropic', model: 'claude-sonnet' }],
    localModel: {
      enabled: true,
      baseUrl: 'http://user:hunter2!!@127.0.0.1:11434/v1?token=tok-123456789',
      model: 'llama',
    },
    updateUrl: 'https://updates.example.com/stratlas/?sig=tok-123456789',
    anthropicWorkspaceId: WORKSPACE,
    reportBranding: { companyName: 'Client Co', accent: '#112233', logo: 'logo-abcdef12.png' },
    // Not in the allow-list: dropped, only its name is listed.
    anthropicApiKey: ANTHROPIC,
    futureToken: 'tok-123456789',
  };

  it('keeps allow-listed fields and drops everything else', () => {
    const out = redactSettings(settings);
    const text = JSON.stringify(out);
    expectClean(text);
    expect(out.cloudAi).toBe(true);
    expect(out.dataRoot).toBe('D:\\Stratlas Data');
    expect(out.anthropicWorkspaceId).toBe(maskId(WORKSPACE));
    expect(out.updateUrl).toBe('https://updates.example.com/stratlas/');
    expect(out.localModel).toEqual({
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama',
    });
    expect(out.reportBranding).toEqual({ companyName: 'set', accent: '#112233', logo: 'set' });
    expect(out._omitted).toEqual(['anthropicApiKey', 'futureToken']);
    expect(text).not.toContain('Client Co');
  });

  it('returns an empty object for something that is not settings', () => {
    expect(redactSettings(null)).toEqual({});
    expect(redactSettings('x')).toEqual({});
  });
});
