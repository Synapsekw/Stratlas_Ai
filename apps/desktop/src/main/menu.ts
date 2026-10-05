import { brand } from '@aio/brand';
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

/** Minimal app menu. DevTools and reload exist only in development builds. */
export function buildMenu(dev: boolean): Menu {
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
    {
      role: 'help',
      submenu: [
        {
          label: 'User guide',
          accelerator: 'F1',
          // The renderer opens the guide on F1 (also where the menu bar is hidden).
          click: (_item, win) => {
            if (win instanceof BrowserWindow) {
              win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F1' });
              win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F1' });
            }
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
