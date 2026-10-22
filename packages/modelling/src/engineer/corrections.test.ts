import { describe, expect, it } from 'vitest';
import { ModelCorrection, type Assembly, type ProcModel } from '@aio/schema';
import { component, engineeringModel } from './fixtures';
import {
  acceptModelCorrection,
  buildCorrectionCandidate,
  createModelCorrection,
  growCorrectionBox,
  modelCorrectionBounds,
  modelCorrectionFingerprint,
  pinTargetRefusal,
  proposeModelCorrection,
  rebaseModelCorrection,
  rejectModelCorrection,
  replyToModelCorrection,
  resendModelCorrection,
} from './corrections';

const NOW = '2026-10-17T00:00:00.000Z';
const LATER = '2026-10-17T01:00:00.000Z';
const radio = (id = 'radio-1', x = 101): Assembly =>
  component('antenna', id, 'Radio', {
    kind: 'rru',
    centre: [x, 28, -201],
    azimuthDeg: 30,
    tiltDeg: 0,
    size: [0.3, 0.5, 0.2],
  });
function model(): ProcModel {
  return {
    ...engineeringModel('synthetic', 'Synthetic model', [radio(), radio('radio-2', 102)]),
    scale: { status: 'measured' },
    georef: {
      schema: 'aio.georef/1',
      crs: { epsg: 32640 },
      anchor: [265000, 2680000, 0],
      axes: 'x-east,y-up,z-south',
      units: 'm',
      modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 265000, 2680000, 0, 1],
      heading: { deg: 0, status: 'measured' },
      scale: { factor: 1, status: 'measured' },
      horizontal: { status: 'from-source' },
      vertical: { datum: 'source', status: 'from-source' },
      provenance: { by: 'engineer', runId: 'run-synthetic' },
    },
  };
}
const partRequest = (m: ProcModel) =>
  createModelCorrection(
    m,
    {
      id: 'correction-1',
      target: { kind: 'part', partId: 'radio-1' },
      comment: 'Rotate this radio.',
    },
    NOW,
  );
const pinRequest = (m: ProcModel) =>
  createModelCorrection(
    m,
    {
      id: 'correction-2',
      target: {
        kind: 'pin',
        position: [103, 28, -201],
        projectPosition: [3, 28, -1],
        radiusM: 2,
        sourceLayerId: 'cloud-layer',
      },
      comment: 'A radio is missing here.',
    },
    NOW,
  );
const modelRequest = (m: ProcModel) =>
  createModelCorrection(
    m,
    { id: 'fix-m', target: { kind: 'model' }, comment: 'remove the radio' },
    NOW,
  );
const small = (id: string, centre: [number, number, number]): Assembly =>
  component('antenna', id, 'Radio', {
    kind: 'rru',
    centre,
    azimuthDeg: 0,
    tiltDeg: 0,
    size: [0.1, 0.1, 0.1],
  });
const rod = (id: string, centre: [number, number, number]): Assembly =>
  component('antenna', id, 'Antenna', {
    kind: 'omni',
    centre,
    azimuthDeg: 0,
    tiltDeg: 0,
    size: [0.02, 2, 0.02],
  });
const changed = (): Assembly => {
  const a = radio();
  if (a.kind === 'antenna') a.params.azimuthDeg = 50;
  return a;
};

describe('model correction transactions', () => {
  it('persists requests and proposed snapshots without copying the whole model', async () => {
    const m = model();
    const request = await partRequest(m);
    const proposal = await proposeModelCorrection(
      m,
      request,
      { explanation: 'Aligned with the photo.', patch: [{ op: 'replace', assembly: changed() }] },
      NOW,
    );
    expect(ModelCorrection.parse(JSON.parse(JSON.stringify(proposal.request)))).toEqual(
      proposal.request,
    );
    expect(proposal.request.proposal?.before).toEqual([m.assemblies[0]]);
    expect(proposal.request.status).toBe('proposed');
    expect(proposal.request).not.toHaveProperty('model');
    expect(m.assemblies[0]).toEqual(radio());
    expect(proposal.candidate.assemblies[1]).toEqual(m.assemblies[1]);
    expect(await buildCorrectionCandidate(m, proposal.request)).toEqual(proposal.candidate);
  });

  it('accepts only reviewed geometry, preserving unrelated parts, ids, frame and scale exactly', async () => {
    const m = model();
    const proposed = await proposeModelCorrection(
      m,
      await partRequest(m),
      { explanation: 'Rotate radio.', patch: [{ op: 'replace', assembly: changed() }] },
      NOW,
    );
    const accepted = await acceptModelCorrection(m, proposed.request, LATER);
    expect(accepted.request.status).toBe('accepted');
    expect(accepted.model.assemblies.map((a) => a.id)).toEqual(m.assemblies.map((a) => a.id));
    expect(accepted.model.assemblies[1]).toEqual(m.assemblies[1]);
    expect(accepted.model.assemblies[0]).toEqual({
      ...changed(),
      status: 'accepted',
      quality: {
        azimuthDeg: { basis: 'user', note: 'Human-reviewed correction proposal' },
      },
    });
    expect(accepted.model.georef).toEqual(m.georef);
    expect(accepted.model.scale).toEqual(m.scale);
    expect(accepted.model.parts).toEqual(m.parts);
    expect(accepted.model.updatedAt).toBe(LATER);
  });

  it('rejects stale model geometry and changed georeference, but ignores timestamp and key ordering', async () => {
    const m = model();
    const request = await partRequest(m);
    const proposed = await proposeModelCorrection(
      m,
      request,
      { explanation: 'Rotate radio.', patch: [{ op: 'replace', assembly: changed() }] },
      NOW,
    );
    expect(await modelCorrectionFingerprint({ ...m, updatedAt: LATER })).toBe(
      request.baseFingerprint,
    );
    expect(
      await modelCorrectionFingerprint(
        Object.fromEntries(Object.entries(m).reverse()) as ProcModel,
      ),
    ).toBe(request.baseFingerprint);
    const moved = structuredClone(m);
    moved.assemblies[1] = radio('radio-2', 105);
    await expect(acceptModelCorrection(moved, proposed.request, LATER)).rejects.toThrow(/stale/i);
    const reframed = structuredClone(m);
    if (reframed.georef) reframed.georef.anchor[0] += 1;
    await expect(buildCorrectionCandidate(reframed, proposed.request)).rejects.toThrow(/stale/i);
  });

  it('refuses empty, identical, out-of-scope and invalid patches', async () => {
    const m = model();
    const request = await partRequest(m);
    await expect(
      proposeModelCorrection(m, request, { explanation: 'Empty.', patch: [] }, NOW),
    ).rejects.toThrow();
    await expect(
      proposeModelCorrection(
        m,
        request,
        { explanation: 'No change.', patch: [{ op: 'replace', assembly: radio() }] },
        NOW,
      ),
    ).rejects.toThrow(/no change|no-op/i);
    await expect(
      proposeModelCorrection(
        m,
        request,
        {
          explanation: 'Other radio.',
          patch: [{ op: 'replace', assembly: radio('radio-2', 106) }],
        },
        NOW,
      ),
    ).rejects.toThrow(/target|scope/i);
    await expect(
      proposeModelCorrection(
        m,
        request,
        {
          explanation: 'Unrequested addition.',
          patch: [{ op: 'add', assembly: radio('radio-3', 103) }],
        },
        NOW,
      ),
    ).rejects.toThrow(/target|scope/i);
    const invalid = changed();
    invalid.parent = 'missing-parent';
    await expect(
      proposeModelCorrection(
        m,
        request,
        { explanation: 'Bad parent.', patch: [{ op: 'replace', assembly: invalid }] },
        NOW,
      ),
    ).rejects.toThrow();
  });

  it('rejects forged snapshots or candidate digest even when persisted schema is valid', async () => {
    const m = model();
    const proposed = await proposeModelCorrection(
      m,
      await partRequest(m),
      { explanation: 'Rotate.', patch: [{ op: 'replace', assembly: changed() }] },
      NOW,
    );
    const forged = structuredClone(proposed.request);
    if (forged.proposal) forged.proposal.before = [];
    await expect(buildCorrectionCandidate(m, forged)).rejects.toThrow(/snapshot/i);
    if (forged.proposal) {
      forged.proposal.before = [radio()];
      forged.proposal.candidateFingerprint = 'sha256:' + 'a'.repeat(64);
    }
    await expect(acceptModelCorrection(m, forged, NOW)).rejects.toThrow(/fingerprint|digest/i);
  });

  it('adds missing equipment near the model-local pin, with distinct project-local position', async () => {
    const m = model();
    const request = await pinRequest(m);
    const proposed = await proposeModelCorrection(
      m,
      request,
      {
        explanation: 'Missing radio in the cloud.',
        patch: [{ op: 'add', assembly: radio('radio-3', 103) }],
      },
      NOW,
    );
    const accepted = await acceptModelCorrection(m, proposed.request, LATER);
    expect(accepted.model.assemblies.slice(0, 2)).toEqual(m.assemblies);
    expect(accepted.model.assemblies[2]).toEqual({
      ...radio('radio-3', 103),
      status: 'accepted',
      quality: Object.fromEntries(
        Object.keys(radio().params).map((key) => [
          key,
          { basis: 'user', note: 'Human-reviewed correction proposal' },
        ]),
      ),
    });
    expect(proposed.request.proposal?.before).toEqual([]);
  });

  it('allows source-aligned local pins when the absolute vertical datum is unknown', async () => {
    const m = model();
    if (!m.georef) throw new Error('Expected frame.');
    m.georef.vertical = { datum: 'unknown', status: 'unknown' };
    const request = await pinRequest(m);
    const proposed = await proposeModelCorrection(
      m,
      request,
      {
        explanation: 'Local cloud and photo evidence.',
        patch: [{ op: 'add', assembly: radio('radio-3', 103) }],
      },
      NOW,
    );
    expect(proposed.candidate.georef).toEqual(m.georef);
    expect(proposed.candidate.georef?.vertical).toEqual({ datum: 'unknown', status: 'unknown' });
    const unplaced = structuredClone(m);
    if (unplaced.georef) unplaced.georef.horizontal = { status: 'unplaced' };
    await expect(pinRequest(unplaced)).rejects.toThrow(/frame|placement/i);
    const invalid = structuredClone(m);
    if (invalid.georef)
      invalid.georef.modelToCrs = Array(16).fill(0) as typeof invalid.georef.modelToCrs;
    await expect(pinRequest(invalid)).rejects.toThrow(/frame|transform/i);
  });

  it('refuses pin additions outside the scoped radius, oversized geometry and unknown frames', async () => {
    const m = model();
    const request = await pinRequest(m);
    await expect(
      proposeModelCorrection(
        m,
        request,
        { explanation: 'Too far.', patch: [{ op: 'add', assembly: radio('radio-3', 108) }] },
        NOW,
      ),
    ).rejects.toThrow(/pin|radius|scope/i);
    const huge = radio('radio-3', 103);
    if (huge.kind === 'antenna') huge.params.size[1] = 20;
    await expect(
      proposeModelCorrection(
        m,
        request,
        { explanation: 'Too large.', patch: [{ op: 'add', assembly: huge }] },
        NOW,
      ),
    ).rejects.toThrow(/pin|radius|scope/i);
    const unplaced = model();
    delete unplaced.georef;
    await expect(pinRequest(unplaced)).rejects.toThrow(/frame|placement/i);
    const provisional = model();
    provisional.scale = { status: 'provisional' };
    await expect(pinRequest(provisional)).rejects.toThrow(/scale|frame/i);
    await expect(
      proposeModelCorrection(
        m,
        request,
        {
          explanation: 'Replace existing via pin.',
          patch: [{ op: 'replace', assembly: changed() }],
        },
        NOW,
      ),
    ).rejects.toThrow(/pin|add|scope/i);
  });

  it('refuses deletion with child references and indirect changes to unrelated shaft geometry', async () => {
    const m = model();
    const child = radio('radio-3');
    child.parent = 'radio-1';
    m.assemblies.push(child);
    await expect(
      proposeModelCorrection(
        m,
        await partRequest(m),
        { explanation: 'Remove.', patch: [{ op: 'remove', id: 'radio-1' }] },
        NOW,
      ),
    ).rejects.toThrow(/parent|reference/i);
    const shaft = component('shaft', 'shaft-1', 'Structure', {
      base: [101, 0, -201],
      profile: [
        { y: 0, r: 1 },
        { y: 30, r: 0.5 },
      ],
      openTop: false,
    });
    m.assemblies.push(
      shaft,
      component('ringPlatform', 'platform-1', 'Platform', {
        y: 26,
        rInner: 0.7,
        rOuter: 2,
        thickness: 0.1,
        shaft: 'shaft-1',
      }),
    );
    const request = await createModelCorrection(
      m,
      { id: 'correction-3', target: { kind: 'part', partId: 'shaft-1' }, comment: 'Move shaft.' },
      NOW,
    );
    if (shaft.kind === 'shaft') shaft.params.base[0] += 1;
    // Make a fresh, unchanged baseline to ensure this exercises indirect geometry, not staleness.
    const baseline = structuredClone(m);
    const baseShaft = baseline.assemblies.find((a) => a.id === 'shaft-1');
    if (baseShaft?.kind === 'shaft') baseShaft.params.base[0] -= 1;
    await expect(
      proposeModelCorrection(
        baseline,
        request,
        { explanation: 'Move shaft.', patch: [{ op: 'replace', assembly: shaft }] },
        NOW,
      ),
    ).rejects.toThrow(/dependent|unrelated/i);
  });

  it('retains rejected proposal history and bounded human replies without mutating the model', async () => {
    const m = model();
    const proposed = await proposeModelCorrection(
      m,
      await partRequest(m),
      { explanation: 'Rotate.', patch: [{ op: 'replace', assembly: changed() }] },
      NOW,
    );
    const rejected = rejectModelCorrection(proposed.request, LATER);
    const replied = replyToModelCorrection(rejected, 'That points in the wrong direction.', LATER);
    expect(replied.status).toBe('rejected');
    expect(replied.proposal).toEqual(proposed.request.proposal);
    expect(replied.replies[0]?.comment).toContain('wrong direction');
    expect(m.assemblies[0]).toEqual(radio());
    await expect(acceptModelCorrection(m, replied, LATER)).rejects.toThrow(/proposed/i);
    expect(() => replyToModelCorrection(replied, ' ', LATER)).toThrow();
    expect(() => replyToModelCorrection(replied, 'x'.repeat(4001), LATER)).toThrow();
  });

  it('explicitly reopens a stale correction against the current model without losing its rejected proposal', async () => {
    const m = model();
    const proposed = await proposeModelCorrection(
      m,
      await partRequest(m),
      { explanation: 'Rotate.', patch: [{ op: 'replace', assembly: changed() }] },
      NOW,
    );
    const rejected = rejectModelCorrection(proposed.request, LATER);
    const moved = structuredClone(m);
    moved.assemblies[1] = radio('radio-2', 106);
    const reopened = await rebaseModelCorrection(moved, rejected, LATER);
    expect(reopened.status).toBe('open');
    expect(reopened.proposal).toBeUndefined();
    expect(reopened.history[0]).toEqual({
      proposal: proposed.request.proposal,
      disposition: 'rejected',
      at: LATER,
    });
    const revised = await proposeModelCorrection(
      moved,
      reopened,
      { explanation: 'Revised.', patch: [{ op: 'replace', assembly: changed() }] },
      LATER,
    );
    expect(revised.candidate.assemblies[1]).toEqual(moved.assemblies[1]);
  });

  it('removes a reviewed leaf component without removing or reordering other components', async () => {
    const m = model();
    const proposed = await proposeModelCorrection(
      m,
      await partRequest(m),
      { explanation: 'This radio is a duplicate.', patch: [{ op: 'remove', id: 'radio-1' }] },
      NOW,
    );
    expect(proposed.request.proposal?.before).toEqual([radio()]);
    const accepted = await acceptModelCorrection(m, proposed.request, LATER);
    expect(accepted.model.assemblies).toEqual([m.assemblies[1]]);
  });

  it('refuses forged pin geometry with huge grating extents before allocating its mesh', async () => {
    const m = model();
    const huge = component('deck', 'deck-1', 'Platform', {
      y: 28,
      outline: [
        [100, -201],
        [1000000, -201],
        [1000000, -200],
      ],
      thickness: 0.1,
      grating: true,
      openings: [],
    });
    await expect(
      proposeModelCorrection(
        m,
        await pinRequest(m),
        { explanation: 'Huge platform.', patch: [{ op: 'add', assembly: huge }] },
        NOW,
      ),
    ).rejects.toThrow(/pin|radius|scope/i);
  });

  it('does not carry stale measured accuracy onto changed or newly proposed parameters', async () => {
    const m = model();
    const original = m.assemblies[0];
    if (original?.kind !== 'antenna') throw new Error('Expected antenna.');
    original.quality = {
      azimuthDeg: { basis: 'measured', residualM: 0.002, support: 80 },
      centre: { basis: 'measured', residualM: 0.003, support: 100 },
    };
    const edited = structuredClone(original);
    edited.params.azimuthDeg += 10;
    edited.quality.centre = { basis: 'inferred', note: 'Should not overwrite unchanged evidence.' };
    const proposed = await proposeModelCorrection(
      m,
      await partRequest(m),
      {
        explanation: 'The photo shows a different direction.',
        patch: [{ op: 'replace', assembly: edited }],
      },
      NOW,
    );
    expect(proposed.candidate.assemblies[0]?.quality.azimuthDeg).toEqual({
      basis: 'inferred',
      note: 'Proposed correction; measurement not revalidated',
    });
    expect(proposed.candidate.assemblies[0]?.quality.centre).toEqual(original.quality.centre);
    expect(await buildCorrectionCandidate(m, proposed.request)).toEqual(proposed.candidate);
    const accepted = await acceptModelCorrection(m, proposed.request, LATER);
    expect(accepted.model.assemblies[0]?.quality.azimuthDeg).toEqual({
      basis: 'user',
      note: 'Human-reviewed correction proposal',
    });
    expect(accepted.model.assemblies[0]?.quality.centre).toEqual(original.quality.centre);

    const added = radio('radio-3', 103);
    added.quality = { centre: { basis: 'measured', residualM: 0, support: 10000 } };
    const addition = await proposeModelCorrection(
      m,
      await pinRequest(m),
      { explanation: 'Add radio.', patch: [{ op: 'add', assembly: added }] },
      NOW,
    );
    expect(addition.candidate.assemblies[2]?.quality.centre?.basis).toBe('inferred');
    expect(addition.candidate.assemblies[2]?.quality.centre).not.toHaveProperty('residualM');
    expect(Object.keys(addition.candidate.assemblies[2]?.quality ?? {})).toEqual(
      Object.keys(added.params),
    );
  });

  it('saves a model-wide request on a provisional, unplaced model', async () => {
    const m = model();
    m.scale = { status: 'provisional' };
    if (m.georef) m.georef.horizontal = { status: 'unplaced' };
    const request = await modelRequest(m);
    expect(request.status).toBe('open');
    expect(request.target).toEqual({ kind: 'model' });
    const message = 'A location pin needs a known model placement and coordinate frame.';
    await expect(pinRequest(m)).rejects.toThrow(message);
    expect(pinTargetRefusal(m)).toBe(message);
    expect(pinTargetRefusal(model())).toBeNull();
  });

  it('lets a model-wide proposal remove, replace and add anywhere inside the grown box', async () => {
    const m = model();
    const other = radio('radio-2', 102);
    if (other.kind === 'antenna') other.params.azimuthDeg = 60;
    const inside = small('radio-3', [101.5, 28, -201]);
    const proposed = await proposeModelCorrection(
      m,
      await modelRequest(m),
      {
        explanation: 'Remove one radio, turn the other, add a third.',
        patch: [
          { op: 'remove', id: 'radio-1' },
          { op: 'replace', assembly: other },
          { op: 'add', assembly: inside },
        ],
      },
      NOW,
    );
    expect(proposed.request.status).toBe('proposed');
    expect(proposed.candidate.assemblies.map((a) => a.id)).toEqual(['radio-2', 'radio-3']);
    const turned = proposed.candidate.assemblies[0];
    expect(turned?.kind === 'antenna' && turned.params.azimuthDeg).toBe(60);
    expect(proposed.request.proposal?.before).toEqual([radio(), radio('radio-2', 102)]);
    expect(await buildCorrectionCandidate(m, proposed.request)).toEqual(proposed.candidate);
  });

  it('refuses more than 20 model-wide operations', async () => {
    const m = model();
    const patch = Array.from({ length: 21 }, (_, i) => ({
      op: 'add' as const,
      assembly: small(`radio-x${i}`, [101.5, 28, -201]),
    }));
    await expect(
      proposeModelCorrection(m, await modelRequest(m), { explanation: 'Many.', patch }, NOW),
    ).rejects.toThrow('at most 20');
  });

  it('refuses a model-wide addition outside the bounding box grown by 10%', async () => {
    const m = model();
    const b = modelCorrectionBounds(m);
    if (!b) throw new Error('Expected bounds.');
    const request = await modelRequest(m);
    const centre: [number, number, number] = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    await expect(
      proposeModelCorrection(
        m,
        request,
        {
          explanation: 'Outside.',
          patch: [
            { op: 'add', assembly: small('radio-3', [b.max[0] + 0.01, centre[1], centre[2]]) },
          ],
        },
        NOW,
      ),
    ).rejects.toThrow('Added geometry lies outside the model bounds.');
    const proposed = await proposeModelCorrection(
      m,
      request,
      { explanation: 'Inside.', patch: [{ op: 'add', assembly: small('radio-3', centre) }] },
      NOW,
    );
    expect(proposed.candidate.assemblies.map((a) => a.id)).toContain('radio-3');
    const empty = model();
    empty.assemblies = [];
    expect(modelCorrectionBounds(empty)).toBeNull();
    await expect(
      proposeModelCorrection(
        empty,
        await modelRequest(empty),
        { explanation: 'Add.', patch: [{ op: 'add', assembly: small('radio-3', centre) }] },
        NOW,
      ),
    ).rejects.toThrow('A model-wide addition needs a model with visible geometry.');
  });

  it('grows each half-extent by 10% with a 5% floor of the longest', () => {
    const half = (b: { min: readonly number[]; max: readonly number[] }) =>
      b.max.map((v, i) => (v - (b.min[i] ?? 0)) / 2);
    const grown = growCorrectionBox([-1, 0, -1], [1, 10, 1]);
    half(grown).forEach((h, i) => {
      expect(h).toBeCloseTo([1.1, 5.5, 1.1][i] ?? NaN, 9);
    });
    expect(grown.min[1] + grown.max[1]).toBeCloseTo(10, 9);
    const flat = growCorrectionBox([-5, 2, -1], [5, 2, 1]);
    expect(half(flat)[1]).toBeCloseTo(0.25, 9);
    expect(half(flat)[0]).toBeCloseTo(5.5, 9);
    // The same rule on built geometry: two thin rods spanning [-1, 0, -1] to [1, 10, 1].
    const m = model();
    m.assemblies = [rod('rod-1', [-0.99, 1, -0.99]), rod('rod-2', [0.99, 9, 0.99])];
    const b = modelCorrectionBounds(m);
    if (!b) throw new Error('Expected bounds.');
    half(b).forEach((h, i) => {
      expect(h).toBeCloseTo([1.1, 5.5, 1.1][i] ?? NaN, 6);
    });
    m.assemblies.push({ ...rod('rod-3', [50, 5, 0]), status: 'rejected' });
    expect(modelCorrectionBounds(m)?.max[0]).toBeCloseTo(1.1, 6);
  });

  it('a model-wide proposal on a changed model is stale', async () => {
    const m = model();
    const request = await modelRequest(m);
    const moved = structuredClone(m);
    moved.assemblies[1] = radio('radio-2', 105);
    await expect(
      proposeModelCorrection(
        moved,
        request,
        { explanation: 'Remove.', patch: [{ op: 'remove', id: 'radio-1' }] },
        NOW,
      ),
    ).rejects.toThrow(/stale/i);
  });

  it('resend reopens a rejected request with a reply and keeps every round', async () => {
    const m = model();
    const first = await proposeModelCorrection(
      m,
      await modelRequest(m),
      { explanation: 'Remove.', patch: [{ op: 'remove', id: 'radio-1' }] },
      NOW,
    );
    const rejected = rejectModelCorrection(first.request, LATER);
    const resent = await resendModelCorrection(m, rejected, 'try the other ladder', LATER);
    expect(resent.status).toBe('open');
    expect(resent.proposal).toBeUndefined();
    expect(resent.history).toHaveLength(1);
    expect(resent.history[0]?.disposition).toBe('rejected');
    expect(resent.replies.at(-1)?.comment).toBe('try the other ladder');
    expect(resent.baseFingerprint).toBe(await modelCorrectionFingerprint(m));
    const second = await proposeModelCorrection(
      m,
      resent,
      { explanation: 'Remove the other.', patch: [{ op: 'remove', id: 'radio-2' }] },
      LATER,
    );
    const again = await resendModelCorrection(m, second.request, undefined, LATER);
    expect(again.history).toHaveLength(2);
    expect(again.history[1]?.disposition).toBe('superseded');
    expect(again.replies).toHaveLength(1);
  });

  it('resend past eight rounds keeps the most recent eight', async () => {
    const m = model();
    let request = await modelRequest(m);
    for (let round = 1; round <= 8; round++) {
      const proposed = await proposeModelCorrection(
        m,
        request,
        { explanation: `Round ${round}.`, patch: [{ op: 'remove', id: 'radio-1' }] },
        NOW,
      );
      request = await rebaseModelCorrection(m, proposed.request, NOW);
    }
    expect(request.history).toHaveLength(8);
    const ninth = await proposeModelCorrection(
      m,
      request,
      { explanation: 'Round 9.', patch: [{ op: 'remove', id: 'radio-1' }] },
      NOW,
    );
    const resent = await resendModelCorrection(m, ninth.request, undefined, LATER);
    expect(resent.history).toHaveLength(8);
    expect(resent.history.map((h) => h.proposal.explanation)).toEqual(
      Array.from({ length: 8 }, (_, i) => `Round ${i + 2}.`),
    );

    let replied = resent;
    for (let i = 1; i <= 32; i++) replied = replyToModelCorrection(replied, `Reply ${i}.`, NOW);
    expect(replied.replies).toHaveLength(32);
    const more = await resendModelCorrection(m, replied, 'Reply 33.', LATER);
    expect(more.replies).toHaveLength(32);
    expect(more.replies[0]?.comment).toBe('Reply 2.');
    expect(more.replies.at(-1)?.comment).toBe('Reply 33.');
    expect(more.history).toHaveLength(8);
  });

  it('resend drops the oldest rounds, then replies, until the record fits its size limit', async () => {
    const m = model();
    const long = (label: string) => `${label} ${'x'.repeat(3980)}`;
    const bigPatch = () =>
      Array.from({ length: 20 }, (_, i) => ({
        op: 'add' as const,
        assembly: { ...small(`radio-x${i}`, [101.5, 28, -201]), description: 'd'.repeat(300) },
      }));
    let request = await modelRequest(m);
    for (let round = 1; round <= 6; round++) {
      const proposed = await proposeModelCorrection(
        m,
        request,
        { explanation: long(`Round ${round}.`), patch: bigPatch() },
        NOW,
      );
      request = await rebaseModelCorrection(m, proposed.request, NOW);
    }
    request = (
      await proposeModelCorrection(
        m,
        request,
        { explanation: long('Round 7.'), patch: bigPatch() },
        NOW,
      )
    ).request;
    // Fill with replies until the record sits just under its 256,000-character limit.
    const size = () => JSON.stringify(request).length;
    while (size() + 4200 < 256_000)
      request = replyToModelCorrection(request, long(`Reply ${request.replies.length + 1}.`), NOW);
    request = replyToModelCorrection(request, 'p'.repeat(255_800 - size() - 60), NOW);
    expect(request.replies.length).toBeLessThan(32);
    expect(size()).toBeGreaterThan(255_000);
    const replies = request.replies.length;
    const resent = await resendModelCorrection(m, request, long('Last reply.'), LATER);
    expect(JSON.stringify(resent).length).toBeLessThanOrEqual(256_000);
    expect(resent.history.map((h) => h.proposal.explanation)).toEqual(
      [2, 3, 4, 5, 6, 7].map((n) => long(`Round ${n}.`)),
    );
    expect(resent.replies).toHaveLength(replies + 1);
    expect(resent.replies.at(-1)?.comment).toBe(long('Last reply.'));
  });

  it('refuses resend on accepted requests', async () => {
    const m = model();
    const proposed = await proposeModelCorrection(
      m,
      await modelRequest(m),
      { explanation: 'Remove.', patch: [{ op: 'remove', id: 'radio-1' }] },
      NOW,
    );
    const accepted = await acceptModelCorrection(m, proposed.request, LATER);
    await expect(resendModelCorrection(m, accepted.request, 'again', LATER)).rejects.toThrow(
      'Create a new request to change an accepted correction.',
    );
  });
});
