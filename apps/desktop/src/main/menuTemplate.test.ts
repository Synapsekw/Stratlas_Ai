import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { menuTemplate, type MenuAction } from './menuTemplate';

type Item = MenuItemConstructorOptions;
const sub = (item: Item | undefined): Item[] => (item?.submenu as Item[] | undefined) ?? [];
const names = (items: Item[]) => items.map((i) => i.role ?? i.label ?? i.type);
/** Our click handlers ignore Electron's arguments. */
const press = (item: Item | undefined) => (item?.click as (() => void) | undefined)?.();

function mac(dev = false) {
  const send = vi.fn<(a: MenuAction) => void>();
  return { send, menu: menuTemplate({ platform: 'darwin', dev, productName: 'Stratlas', send }) };
}

describe('menuTemplate on macOS', () => {
  it('has the app, File, Edit, View, Window and Help menus in order', () => {
    expect(mac().menu.map((m) => m.role ?? m.label)).toEqual([
      'Stratlas',
      'File',
      'Edit',
      'View',
      'windowMenu',
      'help',
    ]);
  });

  it('puts About, Settings…, Services, Hide and Quit in the app menu', () => {
    const app = sub(mac().menu[0]);
    expect(names(app)).toEqual([
      'about',
      'separator',
      'Settings…',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
  });

  it('opens Settings with Cmd+, through the renderer', () => {
    const { menu, send } = mac();
    const settings = sub(menu[0]).find((i) => i.label === 'Settings…');
    expect(settings?.accelerator).toBe('Command+,');
    press(settings);
    expect(send).toHaveBeenCalledWith('settings');
  });

  it('shows Cmd+K for the palette without stealing it from the renderer', () => {
    const { menu, send } = mac();
    const [search] = sub(menu[5]);
    expect(search).toMatchObject({ accelerator: 'Command+K', registerAccelerator: false });
    press(search);
    expect(send).toHaveBeenCalledWith('palette');
  });

  it('offers Report a problem and Export diagnostics in Help', () => {
    const { menu, send } = mac();
    const help = sub(menu[5]);
    expect(names(help)).toEqual([
      'Search Commands…',
      'separator',
      'Report a problem…',
      'Export diagnostics…',
    ]);
    press(help.find((i) => i.label === 'Report a problem…'));
    press(help.find((i) => i.label === 'Export diagnostics…'));
    expect(send.mock.calls).toEqual([['reportProblem'], ['exportDiagnostics']]);
  });

  it('keeps DevTools out of release builds', () => {
    expect(names(sub(mac(false).menu[3]))).not.toContain('toggleDevTools');
    expect(names(sub(mac(true).menu[3]))).toContain('toggleDevTools');
  });
});

describe('menuTemplate on Windows', () => {
  it('keeps the minimal menu with no app menu', () => {
    const menu = menuTemplate({
      platform: 'win32',
      dev: false,
      productName: 'Stratlas',
      send: () => undefined,
    });
    expect(menu.map((m) => m.role ?? m.label)).toEqual([
      'File',
      'Edit',
      'View',
      'windowMenu',
      'help',
    ]);
    expect(names(sub(menu[0]))).toEqual(['quit']);
  });
});
