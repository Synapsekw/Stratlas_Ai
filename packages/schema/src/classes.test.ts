import { describe, expect, it } from 'vitest';
import { Detection } from './detections';
import { ipc } from './ipc';
import { LibraryClass } from './severity';

describe('class editing contracts (ANN-7)', () => {
  it('has the four new channels', () => {
    for (const c of [
      'builder:updateClasses',
      'classLibrary:list',
      'classLibrary:save',
      'classLibrary:remove',
    ]) {
      expect(Object.keys(ipc)).toContain(c);
    }
  });

  it('builder:updateClasses takes a project and its catalogues, nothing else', () => {
    const req = ipc['builder:updateClasses'].request;
    const catalogues = [
      {
        id: 'c',
        name: 'Classes',
        assetType: 'asset',
        classes: [{ id: 'crack', label: 'Crack', color: '#e5484d', severityModel: 'm' }],
      },
    ];
    expect(req.safeParse({ projectId: 'p', catalogues }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', catalogues: [] }).success).toBe(true);
    expect(req.safeParse({ projectId: 'p', catalogues: [], extra: 1 }).success).toBe(false);
    expect(req.safeParse({ projectId: '', catalogues: [] }).success).toBe(false);
  });

  it('a library class has a label and a colour; a hotkey is one character', () => {
    expect(LibraryClass.safeParse({ label: 'Spalling', color: '#aabbcc' }).success).toBe(true);
    expect(LibraryClass.safeParse({ label: '   ', color: '#aabbcc' }).success).toBe(false);
    expect(LibraryClass.safeParse({ label: 'X', color: 'red' }).success).toBe(false);
    expect(LibraryClass.safeParse({ label: 'X', color: '#aabbcc', hotkey: 'ab' }).success).toBe(
      false,
    );
    expect(
      LibraryClass.parse({ label: 'X', color: '#aabbcc', severityLevels: ['Minor', 'Severe'] })
        .severityLevels,
    ).toEqual(['Minor', 'Severe']);
  });

  it('library save and remove answer with the whole library', () => {
    const ok = ipc['classLibrary:save'].response.parse({ ok: true, classes: [] });
    expect(ok.ok).toBe(true);
    expect(ipc['classLibrary:remove'].request.safeParse({ label: '' }).success).toBe(false);
  });

  it('a detection may say it suggests a new class', () => {
    const d = Detection.parse({
      photo: 'p1',
      class: 'Spalling',
      label: 'Spalling',
      suggestedNew: true,
      bbox: [0, 0, 10, 10],
    });
    expect(d.suggestedNew).toBe(true);
  });
});
