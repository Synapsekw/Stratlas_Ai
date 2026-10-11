/** What to do when a page asks for a new window (window.open, `<a target="_blank">`). */
export type PopupAction = { kind: 'external'; url: string } | { kind: 'deny' };

/**
 * Decide a popup request. https links go to the system browser, as everywhere else in the app.
 * Everything else is refused, project files included: nothing in the app opens a window of its
 * own.
 */
export function popupAction(raw: string): PopupAction {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'deny' };
  }
  return url.protocol === 'https:' ? { kind: 'external', url: raw } : { kind: 'deny' };
}
