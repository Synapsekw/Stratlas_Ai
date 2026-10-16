// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, t, type ActionCtx, type MenuTarget } from '@aio/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builder } from '../../builder/state';
import { shell } from '../../shell';
import { addDateMenu } from '../AddSurveyDate';
import { registerProjectActions } from './projectActions';

const manifest = {
  captures: [],
  layers: [
    { id: 'a', kind: 'model' },
    { id: 'b', kind: 'legacy' },
    { id: 'c', kind: 'photos' },
  ],
} as unknown as ProjectManifest;
let off: () => void;
beforeEach(() => {
  off = registerProjectActions();
});
afterEach(() => {
  off();
});
const menu = (over: Partial<ActionCtx> = {}, target: MenuTarget = { kind: 'project' }) =>
  actionsFor(target, makeActionCtx({ manifest, ...over }));
const idsOf = (over: Partial<ActionCtx> = {}) => menu(over).map((i) => i.id);

describe('project actions', () => {
  it('lists the project menu by section: view, edit, file, danger', () => {
    expect(idsOf({ hidden: { a: true }, trashEntries: 2 })).toEqual([
      'project.showAll',
      'project.hideAll',
      'project.checkPlacement',
      'project.addData',
      'project.addPanos',
      'project.addDrawing',
      'project.addSurveyDate',
      'project.importFolder',
      'project.import360',
      'project.importTiles',
      'project.exports',
      'project.properties',
      'project.close',
      'project.emptyTrash',
    ]);
  });

  it('Show all and Hide all appear only when they would change something', () => {
    expect(idsOf()).not.toContain('project.showAll');
    expect(idsOf()).toContain('project.hideAll');
    // the retired viewer layer does not count
    expect(idsOf({ hidden: { a: true, c: true } })).not.toContain('project.hideAll');
    expect(idsOf({ hidden: { b: true } })).not.toContain('project.showAll');
  });

  it('a package greys the add and import items and Empty trash with the reason', () => {
    const items = menu({ pkg: true, canEdit: false, trashEntries: 3 });
    const by = (id: string) => items.find((i) => i.id === id);
    for (const id of ['project.addData', 'project.importTiles', 'project.emptyTrash']) {
      expect(by(id)?.disabled).toBe(t('actions.reason.package'));
    }
    expect(by('project.properties')?.disabled).toBe(false);
    expect(by('project.close')?.disabled).toBe(false);
  });

  it('a project that can only be viewed greys them with the view-only reason', () => {
    const items = menu({ canEdit: false });
    expect(items.find((i) => i.id === 'project.addDrawing')?.disabled).toBe(
      t('actions.reason.readOnly'),
    );
  });

  it('Empty trash is greyed when the trash is empty and calls the host otherwise', () => {
    const emptyTrash = vi.fn();
    const host = { ...makeActionCtx({ manifest }).host, emptyTrash };
    const empty = menu({ trashEntries: 0, host }).find((i) => i.id === 'project.emptyTrash');
    expect(empty?.disabled).toBe(t('actions.reason.trashEmpty'));
    empty?.run();
    expect(emptyTrash).not.toHaveBeenCalled();
    const full = menu({ trashEntries: 2, host }).find((i) => i.id === 'project.emptyTrash');
    expect(full?.disabled).toBe(false);
    full?.run();
    expect(emptyTrash).toHaveBeenCalledOnce();
  });

  it('Add drawing shows on the Drawings group only, Add 360 video on Walks', () => {
    const on = (group: 'drawings' | 'walks' | 'models') =>
      menu({}, { kind: 'group', group, layerIds: [] }).map((i) => i.id);
    expect(on('drawings')).toEqual(['group.addDrawing']);
    expect(on('walks')).toEqual(['group.add360']);
    expect(on('models')).toEqual([]);
  });

  it('a package greys the group add items', () => {
    const items = menu({ pkg: true }, { kind: 'group', group: 'drawings', layerIds: [] });
    expect(items[0]?.disabled).toBe(t('actions.reason.package'));
  });

  it('Add data runs the same import as the Add data button', () => {
    const pick = vi.spyOn(builder.getState(), 'pickAndImport').mockResolvedValue();
    menu()
      .find((i) => i.id === 'project.addData')
      ?.run();
    expect(pick).toHaveBeenCalledOnce();
    pick.mockRestore();
  });

  it('Add survey date opens a collapsed sidebar and the popover', () => {
    const toggleSidebar = vi.fn(() => Promise.resolve());
    const before = shell.getState();
    shell.setState({ toggleSidebar, settings: { ...before.settings, sidebarCollapsed: true } });
    menu()
      .find((i) => i.id === 'project.addSurveyDate')
      ?.run();
    expect(toggleSidebar).toHaveBeenCalledOnce();
    expect(addDateMenu.getState().open).toBe(true);
    addDateMenu.getState().set(false);
    shell.setState({ toggleSidebar: before.toggleSidebar, settings: before.settings });
  });

  it('Add survey date leaves an open sidebar alone', () => {
    const toggleSidebar = vi.fn(() => Promise.resolve());
    const before = shell.getState();
    shell.setState({ toggleSidebar, settings: { ...before.settings, sidebarCollapsed: false } });
    menu()
      .find((i) => i.id === 'project.addSurveyDate')
      ?.run();
    expect(toggleSidebar).not.toHaveBeenCalled();
    expect(addDateMenu.getState().open).toBe(true);
    addDateMenu.getState().set(false);
    shell.setState({ toggleSidebar: before.toggleSidebar });
  });

  it('Close project closes the project', () => {
    const closeProject = vi.fn();
    const before = shell.getState().closeProject;
    shell.setState({ closeProject });
    menu()
      .find((i) => i.id === 'project.close')
      ?.run();
    expect(closeProject).toHaveBeenCalledOnce();
    shell.setState({ closeProject: before });
  });
});
