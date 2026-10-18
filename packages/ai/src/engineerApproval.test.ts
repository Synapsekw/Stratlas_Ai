import { expect, it } from 'vitest';
import { approvalScopeKey } from './engineerApproval';
import type { EngineerCall } from './engineer';
import type { ModelRoute } from './routes';
const route: ModelRoute = { task: 'engineer', provider: 'openai', model: 'model-a' };
const call = {
  setup: { detail: 'detailed', sources: { clouds: [{ layer: 'scan' }] } },
  summary: 'measurements',
  images: [{ id: 'img-a', kind: 'photo', dataUrl: 'data:original', bytes: 10 }],
  pass: 1,
} as EngineerCall;
it('binds approval to sources, measurements, provider, budget and frame; permits only derived generated views between passes', () => {
  const key = approvalScopeKey(call, route, 'offset-a');
  expect(
    approvalScopeKey(
      {
        ...call,
        pass: 2,
        images: [
          ...call.images,
          { id: 'gen-top', kind: 'generated', view: 'top', dataUrl: 'data:render', bytes: 10 },
        ],
      },
      route,
      'offset-a',
    ),
  ).toBe(key);
  const first = call.images[0];
  if (!first) throw new Error('missing fixture image');
  expect(
    approvalScopeKey({ ...call, images: [{ ...first, dataUrl: 'changed' }] }, route, 'offset-a'),
  ).not.toBe(key);
  expect(approvalScopeKey(call, { ...route, model: 'model-b' }, 'offset-a')).not.toBe(key);
  expect(approvalScopeKey(call, route, 'offset-b')).not.toBe(key);
  expect(approvalScopeKey({ ...call, summary: 'changed measurement' }, route, 'offset-a')).not.toBe(
    key,
  );
  expect(
    approvalScopeKey({ ...call, setup: { ...call.setup, budgetUsd: 10 } }, route, 'offset-a'),
  ).not.toBe(key);
});
