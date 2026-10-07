import { describe, expect, it } from 'vitest';
import { cspProbeProblem } from './csp-probe.mjs';

const POLICY =
  "default-src 'self' aio:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'";
const REFUSED =
  "EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script";
const good = {
  csp: {
    url: 'file:///C:/app/resources/app.asar/out/renderer/index.html',
    meta: POLICY,
    eval: REFUSED,
  },
};

describe('cspProbeProblem', () => {
  it('passes a file:// window whose policy refuses eval', () => {
    expect(cspProbeProblem(good)).toBeNull();
  });

  it.each([
    [{}, 'no CSP answer'],
    [{ csp: { error: 'Script failed to execute' } }, 'CSP probe failed'],
    [{ csp: { ...good.csp, url: 'http://localhost:5173/' } }, 'not the packaged file://'],
    [{ csp: { ...good.csp, meta: null } }, 'no Content-Security-Policy <meta>'],
    [{ csp: { ...good.csp, meta: "default-src 'self'" } }, 'does not set'],
    [
      { csp: { ...good.csp, meta: `${POLICY}; script-src 'self' 'unsafe-eval'` } },
      'allows eval or inline script',
    ],
    [{ csp: { ...good.csp, eval: 'allowed' } }, 'eval was not refused'],
  ])('fails %j', (report, why) => {
    expect(cspProbeProblem(report)).toContain(why);
  });
});
