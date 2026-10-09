import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { savePath } from './savePath';

describe('savePath', () => {
  it('offers the cleaned name in the downloads folder and answers the chosen path', async () => {
    let offered = '';
    let opts: unknown = null;
    const r = await savePath(
      {
        defaultName: '../pad_site-grid_m.xml',
        title: 'Export',
        filters: [{ name: 'LandXML', extensions: ['xml'] }],
      },
      {
        downloadsDir: 'D:/dl',
        refuse: () => null,
        choose: (defaultPath, o) => {
          offered = defaultPath;
          opts = o;
          return Promise.resolve('E:/out/pad.xml');
        },
      },
    );
    expect(offered).toBe(join('D:/dl', 'pad_site-grid_m.xml'));
    expect(opts).toEqual({ title: 'Export', filters: [{ name: 'LandXML', extensions: ['xml'] }] });
    expect(r).toEqual({ path: 'E:/out/pad.xml' });
  });

  it('answers null when the person cancels', async () => {
    const r = await savePath(
      { defaultName: 'a.dxf' },
      { downloadsDir: 'D:/dl', refuse: () => null, choose: () => Promise.resolve(null) },
    );
    expect(r).toEqual({ path: null });
  });

  it("is refused by an open package's export limits before any dialog", async () => {
    let asked = false;
    const r = await savePath(
      { defaultName: 'a.csv' },
      {
        downloadsDir: 'D:/dl',
        refuse: (name) => `This package does not allow exporting ${name}.`,
        choose: () => {
          asked = true;
          return Promise.resolve('x');
        },
      },
    );
    expect(asked).toBe(false);
    expect(r).toEqual({ path: null, error: 'This package does not allow exporting a.csv.' });
  });
});
