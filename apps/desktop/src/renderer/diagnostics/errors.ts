/**
 * Uncaught errors and rejected promises of the window go to the console, which main writes to
 * `renderer.log` (diagnostics). Returns a function that removes the listeners.
 */
export function captureRendererErrors(target: Window = window): () => void {
  const onError = (e: ErrorEvent) => {
    const err: unknown = e.error;
    const text = err instanceof Error ? (err.stack ?? err.message) : e.message;
    console.error(`Uncaught error: ${text}`);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const reason: unknown = e.reason;
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`Unhandled promise rejection: ${text}`);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
