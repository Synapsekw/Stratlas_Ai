import { brand } from '@aio/brand';
import { Menu, type MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  /** Help, Report a problem: the renderer opens its dialog. */
  reportProblem?: () => void;
}

/** Minimal app menu. DevTools and reload exist only in development builds. */
export function buildMenu(dev: boolean, actions: MenuActions = {}): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: brand.productName,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [{ label: 'File', submenu: [{ role: 'quit' }] } satisfies MenuItemConstructorOptions]),
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
    {
      label: 'View',
      submenu: [
        ...(dev
          ? ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    ...(actions.reportProblem
      ? [
          {
            role: 'help',
            submenu: [{ label: 'Report a problem…', click: actions.reportProblem }],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
  ];
  return Menu.buildFromTemplate(template);
}
