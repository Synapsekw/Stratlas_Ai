import { describe, expect, it } from 'vitest';
import { candidates, manifest, setupModeller as setup } from './testing';

describe('model builder store', () => {
  it('adds the parts of an imported drawing as drafts, into a new site model', async () => {
    const { modeller, files } = setup();
    await modeller.getState().show();
    expect(
      modeller
        .getState()
        .drawings()
        .map((d) => d.stem),
    ).toEqual(['plot']);
    const r = await modeller.getState().addFromDrawing(undefined, { classes: ['tank'] });
    expect('added' in r && r.added.map((p) => p.tag)).toEqual(['T-101', 'T-102']);
    const saved = files.get('site-model');
    expect(saved?.parts.every((p) => p.status === 'draft')).toBe(true);
    expect(saved?.sources).toEqual([{ kind: 'drawing', ref: 'drawings/plot.dxf' }]);
    // adding the same drawing again does not double it
    const again = await modeller.getState().addFromDrawing('plot.dxf');
    expect('added' in again && again.added.map((p) => p.id)).toEqual(['dxf-2C']);
    expect(files.get('site-model')?.parts).toHaveLength(3);
  });

  it('finds parts by tag, and says when nothing matches', async () => {
    const { modeller } = setup();
    const r = await modeller.getState().addFromDrawing(undefined, { tags: ['t-102'] });
    expect('added' in r && r.added.map((p) => p.tag)).toEqual(['T-102']);
    expect(await modeller.getState().addFromDrawing(undefined, { tags: ['X-1'] })).toEqual({
      error: 'The drawing plot.dxf has no parts that match.',
    });
    expect(await modeller.getState().addFromDrawing('other')).toEqual({
      error: 'No drawing "other". Imported drawings: plot.dxf.',
    });
  });

  it('accepts, edits and rejects parts, saving each change', async () => {
    const { modeller, files } = setup();
    await modeller.getState().addFromDrawing();
    await modeller.getState().setStatus('all', 'accepted');
    await modeller.getState().editDimension('dxf-1A', 'height', 14);
    await modeller.getState().setStatus(['dxf-2C'], 'rejected');
    const m = files.get('site-model');
    expect(m?.parts.map((p) => p.status)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(m?.parts[0]).toMatchObject({ height: 14 });
    expect(await modeller.getState().editDimension('dxf-1A', 'radius', -1)).toBe(
      'Radius must be more than 0.',
    );
  });

  it('adds the agent parts as drafts with an agent origin', async () => {
    const { modeller, files } = setup();
    const r = await modeller
      .getState()
      .addAgentParts([{ kind: 'box', base: [0, 0, 0], size: [2, 2, 2], class: 'skid' }], 'run-1');
    expect('added' in r && r.added[0]).toMatchObject({
      id: 'agent-1',
      status: 'draft',
      origin: { by: 'agent', runId: 'run-1' },
    });
    expect(files.get('site-model')?.parts).toHaveLength(1);
  });

  it('fits a cloud into the open model through a job and reports the new drafts', async () => {
    const { modeller, files, started, finish } = setup();
    await modeller.getState().ensureModel();
    const running = modeller.getState().fitCloud({ layer: 'scan' });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([
      { pipeline: 'model.fit_cloud', params: { layer: 'scan', model: 'site-model' } },
    ]);
    expect(modeller.getState().busy).toBe('Fitting parts to the point cloud');
    // the pipeline appended two drafts
    const m = files.get('site-model');
    if (!m) throw new Error('no model');
    files.set('site-model', { ...m, parts: [...candidates.parts.slice(0, 2)] });
    finish('done');
    expect(await running).toBeNull();
    expect(modeller.getState().notice).toBe('2 draft parts fitted. Accept or reject them.');
    expect(modeller.getState().busy).toBeNull();
  });

  it('shows the job error when an import fails', async () => {
    const { modeller, finish } = setup();
    const running = modeller.getState().importDrawing({ src: 'C:/x/plot.dxf' });
    await Promise.resolve();
    finish('failed', '"plot.dxf" has no drawing units. Set the drawing units and import again.');
    expect(await running).toMatch(/Set the drawing units/);
    expect(modeller.getState().error).toMatch(/Set the drawing units/);
  });

  it('builds the model and reloads the manifest', async () => {
    const { modeller, workspace, calls } = setup();
    await modeller.getState().addFromDrawing();
    expect(await modeller.getState().build()).toEqual({ layer: 'model-site-model' });
    expect(calls.some((c) => c.channel === 'project:open')).toBe(true);
    expect(workspace.getState().project?.manifest.aiCloudDrawings).toBe(true);
  });

  it('forgets the model when another project opens', async () => {
    const { modeller, workspace } = setup();
    await modeller.getState().addFromDrawing();
    workspace.getState().openProject({ id: 'other', root: 'C:/p/other', manifest });
    expect(modeller.getState().model).toBeNull();
  });
});
