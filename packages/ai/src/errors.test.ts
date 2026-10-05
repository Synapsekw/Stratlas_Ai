import { APICallError, generateText, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { describeError, isWorkspaceError, sanitize } from './errors';
import { createScriptedProvider, WORKSPACE_REQUIRED_BODY } from './scripted';

const KEY = 'sk-ant-api03-NOT-A-REAL-KEY-0123456789abcdef';

function apiError(status: number, body: unknown, message = 'Bad Request'): APICallError {
  const responseBody = typeof body === 'string' ? body : JSON.stringify(body);
  return new APICallError({
    message,
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: status,
    responseBody,
    ...(typeof body === 'object' ? { data: body } : {}),
  });
}

/** The 400 the installed app logged on 2026-10-04 (main.log), body as the Messages API sends it. */
const WORKSPACE_400 = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.',
  },
};

const anthropic = { label: 'Anthropic', model: 'claude-sonnet-5-5', secrets: [KEY] };

describe('describeError', () => {
  it('shows the provider text of a 400 and says how to fix a workspace error', () => {
    const d = describeError(apiError(400, WORKSPACE_400), anthropic);
    expect(d.message).toBe(
      'Anthropic: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace. (HTTP 400) Enter the workspace ID under Anthropic in Settings, AI providers, or use an API key that belongs to a workspace.',
    );
    expect(d.message).not.toContain('could not handle this request');
    expect(d.status).toBe(400);
    expect(d.log).toMatch(
      /^APICallError 400 invalid_request_error \(Anthropic claude-sonnet-5-5\): This API key is not scoped/,
    );
  });

  it('tags the workspace error so the agent panel and Settings can offer the fix in place', () => {
    expect(describeError(apiError(400, WORKSPACE_400), anthropic).code).toBe('anthropic-workspace');
    // The scripted test model answers with the same body.
    expect(JSON.parse(WORKSPACE_REQUIRED_BODY)).toEqual(WORKSPACE_400);
    const other = describeError(
      apiError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }),
      anthropic,
    );
    expect(other.code).toBeUndefined();
    expect(isWorkspaceError(500, 'not scoped to a workspace')).toBe(false);
  });

  it('names the model when it is not found', () => {
    const d = describeError(
      apiError(404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'model: claude-sonnet-9' },
      }),
      { ...anthropic, model: 'claude-sonnet-9' },
    );
    expect(d.message).toBe(
      'Anthropic: model not found: claude-sonnet-9. (HTTP 404) Choose another model in Settings, AI providers.',
    );
  });

  it('quotes a rejected key without the key', () => {
    const d = describeError(
      apiError(401, {
        type: 'error',
        error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` },
      }),
      anthropic,
    );
    expect(d.message).toContain('Anthropic did not accept the API key: invalid x-api-key');
    expect(d.message).toContain('Check the key in Settings, AI providers.');
    expect(d.message).not.toContain(KEY);
    expect(d.log).not.toContain(KEY);
  });

  it('reads OpenAI and Gemini error bodies', () => {
    const openai = describeError(
      apiError(400, {
        error: {
          message: "Invalid schema for function 'fly_to'.",
          type: 'invalid_request_error',
          code: 'invalid_function_parameters',
        },
      }),
      { label: 'OpenAI', model: 'gpt-6-luna' },
    );
    expect(openai.message).toMatch(/^OpenAI: Invalid schema for function 'fly_to'\. \(HTTP 400\)/);
    const gemini = describeError(
      apiError(400, {
        error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' },
      }),
      { label: 'Google Gemini', model: 'gemini-3.5-flash' },
    );
    expect(gemini.message).toMatch(/^Google Gemini: API key not valid\. \(HTTP 400\)/);
    expect(gemini.log).toContain('APICallError 400 INVALID_ARGUMENT');
  });

  it('falls back to the raw body or the error message when the body is not JSON', () => {
    const d = describeError(apiError(400, '<html>bad gateway</html>', 'Bad Request'), anthropic);
    expect(d.message).toMatch(/^Anthropic: Bad Request\. \(HTTP 400\)/);
  });

  it('unwraps retries and keeps rate limit and server wording', () => {
    const last = apiError(529, {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    const retry = new RetryError({
      message: 'failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [last],
    });
    expect(describeError(retry, anthropic).message).toBe(
      'Anthropic is busy or rate limited: Overloaded. (HTTP 529) Wait a moment and try again.',
    );
    expect(
      describeError(
        apiError(500, { type: 'error', error: { type: 'api_error', message: 'Internal' } }),
        anthropic,
      ).message,
    ).toBe('Anthropic had a server error: Internal. (HTTP 500) Try again in a moment.');
  });

  it('says the provider cannot be reached on a network failure', () => {
    expect(describeError(new TypeError('fetch failed'), anthropic).message).toBe(
      'Cannot reach Anthropic. Check the internet connection, or keep working offline.',
    );
  });

  it('describes other failures with their sanitised message', () => {
    const d = describeError(new Error(`boom ${KEY}`), anthropic);
    expect(d.message).toBe('Something went wrong in the agent: boom [key]. Try again.');
  });
});

describe('sanitize', () => {
  it('removes keys of every provider and bearer tokens', () => {
    const out = sanitize(
      'a sk-proj-abcdefghijkl b AIzaSyA1234567890abcdefgh c Bearer abc.def-ghi "x-api-key": "secretvalue"',
    );
    expect(out).toBe('a [key] b [key] c [key] "x-api-key": "[key]"');
  });

  it('replaces em and en dashes and caps the length', () => {
    expect(sanitize('a — b – c')).toBe('a - b - c');
    const long = sanitize('x'.repeat(1000));
    expect(long.length).toBe(400);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('scripted workspace mode (end-to-end tests)', () => {
  it('answers the workspace 400 until a workspace ID is set', async () => {
    let id = '';
    const provider = createScriptedProvider('anthropic', true, { workspaceId: () => id });
    const ask = () =>
      generateText({
        model: provider.languageModel('claude-sonnet-5-5', null),
        prompt: 'Reply with OK.',
        maxRetries: 0,
      });
    const failure = await ask().then(
      () => null,
      (e: unknown) => e,
    );
    const d = describeError(failure, { label: 'Anthropic', model: 'claude-sonnet-5-5' });
    expect(d).toMatchObject({ status: 400, code: 'anthropic-workspace' });
    expect(d.log).toMatch(/^APICallError 400 invalid_request_error/);
    id = 'wrkspc_01Test';
    expect((await ask()).text).toBe('OK');
  });
});
