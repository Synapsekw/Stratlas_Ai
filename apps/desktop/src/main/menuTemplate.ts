import type { MenuItemConstructorOptions } from 'electron';

/** Menu items the renderer carries out (the `app:menu` event). */
export type MenuAction = 'settings' | 'palette';

export interface MenuOptions {
  platform: NodeJS.Platform;
  /** Development build: reload and DevTools in View. */
  dev: boolean;
  productName: string;
  send: (action: MenuAction) => void;
}

type Item = MenuItemConstructorOptions;

/**
 * The application menu. macOS follows the platform conventions: an app menu (About, Settings…
 * Cmd+,, Services, Hide, Quit), File, Edit, View, Window and Help. Windows and Linux keep the
 * minimal menu (the window has its own title bar). The renderer handles Cmd and Ctrl alike, so
 * shortcuts it owns are only shown in the menu (`registerAccelerator: false`).
 */
export function menuTemplate(o: MenuOptions): Item[] {
  const isMac = o.platform === 'darwin';
  const view: Item = {
    label: 'View',
    submenu: [
      ...(o.dev
        ? ([
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
          ] satisfies Item[])
        : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  if (!isMac) {
    return [
      { label: 'File', submenu: [{ role: 'quit' }] },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      view,
      { role: 'windowMenu' },
    ];
  }
  return [
    {
      label: o.productName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Command+,',
          click: () => {
            o.send('settings');
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'File', submenu: [{ role: 'close' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
      ],
    },
    view,
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Search Commands…',
          accelerator: 'Command+K',
          registerAccelerator: false,
          click: () => {
            o.send('palette');
          },
        },
      ],
    },
  ];
}
