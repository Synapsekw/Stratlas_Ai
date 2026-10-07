// The packaged smoke check's CSP answer (apps/desktop/src/main/smoke.ts, CSP_PROBE): the packaged
// window must load from file://, carry the app policy as a <meta> (apps/desktop/src/main/csp.ts)
// and refuse eval under it. Built pages never get main's CSP header, so the meta is the policy.

/** The script-src the app policy sets: same-origin scripts and WebAssembly only. */
export const APP_SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval'";

/** Why the smoke report's CSP answer is not good enough, or null when it is. */
export function cspProbeProblem(report) {
  const csp = report?.csp;
  if (!csp || typeof csp !== 'object') return 'the smoke report has no CSP answer.';
  if (typeof csp.error === 'string') return `the CSP probe failed: ${csp.error}`;
  if (typeof csp.url !== 'string' || !csp.url.startsWith('file:'))
    return `the window is not the packaged file:// page (${String(csp.url)}).`;
  if (typeof csp.meta !== 'string' || csp.meta === '')
    return 'the window has no Content-Security-Policy <meta>.';
  const directives = csp.meta.split(';').map((d) => d.trim());
  if (!directives.includes(APP_SCRIPT_SRC))
    return `the window policy does not set "${APP_SCRIPT_SRC}": ${csp.meta}`;
  const scripts = directives.filter((d) => /^script-src(-elem|-attr)?\s/.test(d));
  if (scripts.some((d) => /'unsafe-(eval|inline)'/.test(d)))
    return `the window policy allows eval or inline script: ${csp.meta}`;
  if (typeof csp.eval !== 'string' || !/^EvalError: .*Content Security Policy/.test(csp.eval))
    return `eval was not refused in the window (${String(csp.eval)}).`;
  return null;
}
