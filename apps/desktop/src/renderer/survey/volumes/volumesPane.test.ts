// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { stageShow } from '../../workspace/StageShow';
import { workbench } from '../../workspace/workbench/workbenchStore';
import { openMaterialsPane, volumesPane as fromDraft } from './materialsDraft';
import { volumesPane } from './volumesPane';

afterEach(() => {
  stageShow.getState().reset();
});

describe('one store for the Volumes tab pane', () => {
  it('materialsDraft re-exports the same store', () => {
    expect(fromDraft).toBe(volumesPane);
  });

  it('the stage Show control reads what the segments write', () => {
    volumesPane.getState().setPane('cutFill');
    expect(stageShow.getState().pane).toBe('cutFill');
  });

  it('stageShow.setPane writes the one store', () => {
    stageShow.getState().setPane('materials');
    expect(volumesPane.getState().pane).toBe('materials');
    expect(stageShow.getState().pane).toBe('materials');
  });

  it('openMaterialsPane moves every reader to Materials', () => {
    workbench.getState().reset();
    openMaterialsPane();
    expect(volumesPane.getState().pane).toBe('materials');
    expect(stageShow.getState().pane).toBe('materials');
  });

  it('reset goes back to Inventory in both', () => {
    volumesPane.getState().setPane('materials');
    stageShow.getState().reset();
    expect(volumesPane.getState().pane).toBe('inventory');
    expect(stageShow.getState().pane).toBe('inventory');
  });
});
