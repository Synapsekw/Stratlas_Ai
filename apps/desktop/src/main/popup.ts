/** What to do when a page asks for a new window (window.open, `<a target="_blank">`). */
export type PopupAction =
  | { kind: 'external'; url: string }
  | { kind: 'viewer'; url: string; title: string }
  | { kind: 'deny' };

/**
 * Decide a popup request. Legacy viewers open their PDF report and photos with
 * `target="_blank"`; files of an open project get an app viewer window. https links go to
 * the system browser, as everywhere else in the app. Everything else is refused.
 */
export function popupAction(raw: string, isOpenProject: (id: string) => boolean): PopupAction {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'deny' };
  }
  if (url.protocol === 'https:') return { kind: 'external', url: raw };
  if (url.protocol !== 'aio:' || url.host !== 'project') return { kind: 'deny' };
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const [id, ...rest] = segments;
  if (id === undefined || rest.length === 0) return { kind: 'deny' };
  let title: string;
  let projectId: string;
  try {
    projectId = decodeURIComponent(id);
    title = decodeURIComponent(rest.at(-1) ?? '');
  } catch {
    return { kind: 'deny' };
  }
  if (!isOpenProject(projectId)) return { kind: 'deny' };
  return { kind: 'viewer', url: raw, title };
}
