// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { beginIssueEdit, clearIssueEditing } from '../../../issueCard/state';
import { shell } from '../../../shell';
import { antennaStore, openAntennaReview, showAntennaField } from '../../../telecom/antennaStore';
import { drawerStore } from '../drawerStore';
import { createWorkbenchStore } from '../workbenchStore';
import { followAntennaPick } from './antennaFollow';
import { projectListStore } from './projectListStore';

const contract = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
    ),
    'utf8',
  ),
) as { example: unknown };

beforeEach(() => {
  clearIssueEditing();
  shell.getState().setRight(false);
  drawerStore.getState().close();
  projectListStore.setState({ reveal: null, toolsSeq: 0 });
  antennaStore.setState({
    ...antennaStore.getInitialState(),
    projectId: 'p1',
    file: AntennasFile.parse(structuredClone(contract.example)),
  });
});

describe('followAntennaPick', () => {
  it('selects, reveals the row and brings Project forward from Selection', () => {
    const bench = createWorkbenchStore(null);
    bench.getState().show('selection');
    followAntennaPick('ant-d1', bench);
    expect(antennaStore.getState().selected).toBe('ant-d1');
    expect(projectListStore.getState().reveal).toMatchObject({ group: 'antennas', id: 'ant-d1' });
    expect(bench.getState().front).toBe('measure');
  });

  it('shows every unit when the filter would hide the picked one', () => {
    const bench = createWorkbenchStore(null);
    antennaStore.setState({ filter: 'draft' });
    followAntennaPick('ant-a3', bench);
    expect(antennaStore.getState()).toMatchObject({ filter: 'all', selected: 'ant-a3' });
  });

  it('leaves Coverage in front but still selects and reveals', () => {
    const bench = createWorkbenchStore(null);
    bench.getState().open('rf');
    bench.getState().show('rf');
    followAntennaPick('ant-d1', bench);
    expect(bench.getState().front).toBe('rf');
    expect(antennaStore.getState().selected).toBe('ant-d1');
    expect(projectListStore.getState().reveal).toMatchObject({ group: 'antennas', id: 'ant-d1' });
  });

  it('leaves an edited issue in front', () => {
    const bench = createWorkbenchStore(null);
    bench.getState().show('issues');
    const end = beginIssueEdit('issue-1');
    followAntennaPick('ant-o1', bench);
    end();
    expect(bench.getState().front).toBe('issues');
    expect(antennaStore.getState().selected).toBe('ant-o1');
  });
});

describe('openAntennaReview', () => {
  it('brings Project forward over Coverage, an explicit ask', () => {
    const bench = createWorkbenchStore(null);
    bench.getState().open('rf');
    bench.getState().show('rf');
    openAntennaReview(bench);
    expect(bench.getState().front).toBe('measure');
    expect(antennaStore.getState()).toMatchObject({ filter: 'draft', selected: 'ant-d1' });
  });

  it('asks the list for the first draft and brings Project forward', () => {
    const bench = createWorkbenchStore(null);
    bench.getState().show('selection');
    openAntennaReview(bench);
    expect(projectListStore.getState().reveal).toMatchObject({ group: 'antennas', id: 'ant-d1' });
    expect(bench.getState().front).toBe('measure');
  });
});

describe('the drawer of a folded sidebar', () => {
  it('stays folded for a pick, opens for a review link and for an edit', () => {
    const bench = createWorkbenchStore(null);
    bench.getState().show('selection');
    shell.getState().setRight(true);
    followAntennaPick('ant-d1', bench);
    expect(drawerStore.getState().opened).toBeNull();
    openAntennaReview(bench);
    expect(drawerStore.getState().opened).toBe('click');
    drawerStore.getState().close();
    bench.getState().show('selection');
    showAntennaField('ant-d1', 'azimuthGridDeg', bench);
    expect(drawerStore.getState().opened).toBe('click');
    expect(bench.getState().front).toBe('measure');
  });
});

describe('showAntennaField (Edit azimuth)', () => {
  it('brings Project forward also over Coverage, and asks for the field', () => {
    const bench = createWorkbenchStore(null);
    bench.getState().open('rf');
    bench.getState().show('rf');
    showAntennaField('ant-d1', 'downtiltDeg', bench);
    expect(bench.getState().front).toBe('measure');
    expect(antennaStore.getState().focusField).toMatchObject({ id: 'ant-d1', key: 'downtiltDeg' });
    expect(projectListStore.getState().reveal).toMatchObject({ group: 'antennas', id: 'ant-d1' });
  });
});
