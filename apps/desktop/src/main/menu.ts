import { brand } from '@aio/brand';
import { app, Menu } from 'electron';
import { menuTemplate, type MenuAction } from './menuTemplate';

/**
 * Install the application menu (and, on macOS, the About panel). `send` forwards a menu action
 * (Settings…, Search commands…) to the renderer.
 */
export function installMenu(dev: boolean, send: (action: MenuAction) => void): void {
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: brand.productName,
      applicationVersion: app.getVersion(),
      copyright: `© ${new Date().getFullYear()} ${brand.company}`,
    });
  }
  const template = menuTemplate({
    platform: process.platform,
    dev,
    productName: brand.productName,
    send,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
