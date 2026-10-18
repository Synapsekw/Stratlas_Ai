// @vitest-environment jsdom
import { act } from 'react';
import { setLocale } from '@aio/ui';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CorrectionPanel, type CorrectionPanelProps } from './CorrectionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  setLocale('en');
});

function props(over: Partial<CorrectionPanelProps> = {}): CorrectionPanelProps {
  return {
    parts: [
      { id: 'part-a', label: 'Upper radio' },
      { id: 'part-b', label: 'Mount' },
    ],
    selectedPartId: 'part-a',
    pinMode: false,
    evidenceOptions: [{ id: 'img-12', label: 'North photo', kind: 'photo' }],
    requests: [],
    view: 'before',
    onSelectPart: vi.fn(),
    onPinModeChange: vi.fn(),
    onClearPin: vi.fn(),
    onCreate: vi.fn(),
    onSelectRequest: vi.fn(),
    onSend: vi.fn(),
    onViewChange: vi.fn(),
    onFocusTarget: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onReply: vi.fn(),
    ...over,
  };
}
function render(p: CorrectionPanelProps) {
  act(() => {
    root.render(<CorrectionPanel {...p} />);
  });
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function area(name: string) {
  const found = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${name}"]`);
  if (!found) throw new Error(`Missing field: ${name}`);
  return found;
}
function write(element: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      element,
      text,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await Promise.resolve();
  });
}
const request = {
  id: 'r1',
  target: { kind: 'part' as const, partId: 'part-a', label: 'Upper radio' },
  comment: 'Raise this radio to its mount.',
  evidenceIds: ['img-12'],
  status: 'open' as const,
};
const proposal = {
  id: 'p1',
  requestId: 'r1',
  explanation: 'Raised the radio by 0.2 m to the supported mounting point.',
  changes: [
    { partId: 'part-a', label: 'Upper radio', kind: 'changed' as const, detail: 'Height +0.2 m' },
  ],
};

it('updates correction controls, statuses and plural counts when the language changes', () => {
  render(
    props({
      requests: [request, { ...request, id: 'r2' }],
      sourceVisible: false,
      onSourceVisibleChange: vi.fn(),
    }),
  );
  act(() => {
    setLocale('fr', {
      'eng.correction.label': 'Corrections du modèle',
      'eng.correction.source.show': 'Afficher le nuage source',
      'eng.correction.comment': 'Décrire la différence',
      'eng.correction.commentPlaceholder': 'Que faut-il modifier ?',
      'eng.correction.status.open': 'En attente',
      'eng.correction.send_one': 'Envoyer {count} demande',
      'eng.correction.send_other': 'Envoyer {count} demandes',
    });
  });
  expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Corrections du modèle');
  expect(button('Afficher le nuage source')).toBeDefined();
  expect(area('Décrire la différence').placeholder).toBe('Que faut-il modifier ?');
  expect(host.textContent).toContain('En attente');
  expect(button('Envoyer 2 demandes')).toBeDefined();
  render(props({ requests: [request] }));
  expect(button('Envoyer 1 demande')).toBeDefined();
});

it('formats coordinates with shared metric grouping and removes rounded negative zero', () => {
  setLocale('fr', {
    'eng.correction.position': 'Mètres locaux : X {x}, Y {y}, Z {z}',
  });
  render(
    props({
      requests: [
        {
          ...request,
          target: {
            kind: 'pin',
            position: [1234.123456, -0.0001, 3],
          },
        },
      ],
      selectedRequestId: 'r1',
    }),
  );
  expect(host.textContent).toContain('Mètres locaux : X 1 234.123, Y 0.000, Z 3.000');
});

it('saves a selected-part request and explicit evidence only after a useful comment', async () => {
  const p = props();
  render(p);
  expect(button('Save request').disabled).toBe(true);
  write(area('Describe the discrepancy'), '  Raise this radio to its mount.  ');
  const evidence = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(evidence).not.toBeNull();
  act(() => evidence?.click());
  await click('Save request');
  expect(p.onCreate).toHaveBeenCalledWith({
    target: request.target,
    comment: request.comment,
    evidenceIds: ['img-12'],
  });
  expect(area('Describe the discrepancy').value).toBe('');
  expect(p.onSend).not.toHaveBeenCalled();
});

it('retains the correction text and displays a failed-save error for retry', async () => {
  const p = props({
    onCreate: vi.fn().mockRejectedValue(new Error('Project could not be saved.')),
  });
  render(p);
  write(area('Describe the discrepancy'), request.comment);
  await click('Save request');
  expect(area('Describe the discrepancy').value).toBe(request.comment);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Project could not be saved.',
  );
  expect(button('Save request').disabled).toBe(false);
});

it('offers location picking and sends the exact pin coordinates without rounding them', async () => {
  const p = props();
  render(p);
  await click('Location pin');
  expect(p.onPinModeChange).toHaveBeenLastCalledWith(true);
  render({ ...p, pinMode: true });
  expect(host.textContent).toContain('Click a surface on the model or point cloud');
  expect(button('Save request').disabled).toBe(true);
  const pin = {
    position: [102.123456, 31.25, -400.45678] as [number, number, number],
    layerId: 'cloud-a',
  };
  render({ ...p, pin, pinMode: false });
  write(area('Describe the discrepancy'), 'Add the missing radio at this point.');
  expect(host.textContent).toContain('X 102.123, Y 31.250, Z -400.457');
  expect(host.textContent).not.toContain('102.123456');
  await click('Save request');
  expect(p.onCreate).toHaveBeenCalledWith({
    target: { kind: 'pin', ...pin, radiusM: 2 },
    comment: 'Add the missing radio at this point.',
    evidenceIds: [],
  });
});

it('keeps the source cloud visibility switch available while the composer is folded', async () => {
  const onSourceVisibleChange = vi.fn();
  const p = props({
    requests: [{ ...request, status: 'proposed' }],
    selectedRequestId: 'r1',
    proposal,
    sourceVisible: false,
    onSourceVisibleChange,
  });
  render(p);
  const show = button('Show source cloud');
  expect(show.closest('details')).toBeNull();
  expect(show.getAttribute('aria-pressed')).toBe('false');
  await click('Show source cloud');
  expect(onSourceVisibleChange).toHaveBeenLastCalledWith(true);
  render({ ...p, sourceVisible: true });
  expect(button('Hide source cloud').getAttribute('aria-pressed')).toBe('true');
  await click('Hide source cloud');
  expect(onSourceVisibleChange).toHaveBeenLastCalledWith(false);
  expect(p.onViewChange).not.toHaveBeenCalled();
});

it('shows and enforces the permitted correction radius around a location pin', async () => {
  const onPinRadiusChange = vi.fn();
  const p = props({ pin: { position: [100, 30, -20] }, onPinRadiusChange });
  render(p);
  await click('Location pin');
  const radius = host.querySelector<HTMLInputElement>('input[aria-label="Correction radius (m)"]');
  expect(radius?.value).toBe('2');
  expect(host.textContent).toContain('Changes must stay within this distance of the pin.');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(radius, '0.5');
    radius?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(onPinRadiusChange).toHaveBeenCalledWith(0.5);
  render({ ...p, pinRadiusM: 0.5 });
  write(area('Describe the discrepancy'), request.comment);
  await click('Save request');
  expect(p.onCreate).toHaveBeenCalledWith({
    target: { kind: 'pin', position: [100, 30, -20], radiusM: 0.5 },
    comment: request.comment,
    evidenceIds: [],
  });
  render({ ...p, pinRadiusM: 6 });
  write(area('Describe the discrepancy'), request.comment);
  expect(button('Save request').disabled).toBe(true);
});

it('sends only queued requests and retains accepted history', async () => {
  const p = props({ requests: [request, { ...request, id: 'r2', status: 'accepted' }] });
  render(p);
  await click('Send 1 request to AI');
  expect(p.onSend).toHaveBeenCalledWith(['r1']);
  expect(host.textContent).toContain('Accepted');
  await click('Upper radio');
  expect(p.onSelectRequest).toHaveBeenCalledWith('r1');
});

it('switches the real comparison, focuses changed parts and accepts only the selected proposal', async () => {
  const p = props({
    requests: [{ ...request, status: 'proposed' }],
    selectedRequestId: 'r1',
    proposal,
  });
  render(p);
  expect(button('Before').getAttribute('aria-pressed')).toBe('true');
  await click('After');
  expect(p.onViewChange).toHaveBeenCalledWith('after');
  expect(host.textContent).toContain(proposal.explanation);
  await click('Upper radio: Height +0.2 m');
  expect(p.onFocusTarget).toHaveBeenCalledWith(request.target);
  render({ ...p, view: 'after' });
  await click('Accept correction');
  expect(p.onAccept).toHaveBeenCalledWith('p1');
});

it('requires the proposed After view to be displayed before accepting', () => {
  const p = props({
    requests: [{ ...request, status: 'proposed' }],
    selectedRequestId: 'r1',
    proposal,
  });
  render(p);
  expect(button('Accept correction').disabled).toBe(true);
  expect(host.textContent).toContain('View After to review the change before accepting.');
  render({ ...p, view: 'after' });
  expect(button('Accept correction').disabled).toBe(false);
});

it('keeps the comparison prominent by folding the new-request form while reviewing', () => {
  const p = props();
  render(p);
  expect(
    host.querySelector<HTMLDetailsElement>('details[aria-label="New correction request"]')?.open,
  ).toBe(true);
  render({ ...p, requests: [request], selectedRequestId: 'r1' });
  expect(
    host.querySelector<HTMLDetailsElement>('details[aria-label="New correction request"]')?.open,
  ).toBe(false);
});

it('blocks stale or unloaded proposals while preserving the Before view', () => {
  const p = props({
    requests: [{ ...request, status: 'proposed' }],
    selectedRequestId: 'r1',
    proposal: { ...proposal, stale: true },
  });
  render(p);
  expect(button('Accept correction').disabled).toBe(true);
  expect(button('Reject correction').disabled).toBe(true);
  expect(host.textContent).toContain('The model has changed');
  render({ ...p, proposal, proposalReady: false });
  expect(button('Accept correction').disabled).toBe(true);
  expect(button('After').disabled).toBe(true);
  expect(button('Before').disabled).toBe(false);
});

it('supports replies and rejection without replacing a saved request', async () => {
  const p = props({
    requests: [{ ...request, status: 'proposed' }],
    selectedRequestId: 'r1',
    proposal,
  });
  render(p);
  write(area('Reply to this request'), 'The height is right, but the bracket still has a gap.');
  await click('Save reply');
  expect(p.onReply).toHaveBeenCalledWith(
    'r1',
    'The height is right, but the bracket still has a gap.',
  );
  await click('Reject correction');
  expect(p.onReject).toHaveBeenCalledWith('p1');
  expect(p.onCreate).not.toHaveBeenCalled();
});

it('keeps inspection available but locks mutations on an accepted model', () => {
  const p = props({
    readOnly: true,
    requests: [{ ...request, status: 'proposed' }],
    selectedRequestId: 'r1',
    proposal,
  });
  render(p);
  expect(button('Save request').disabled).toBe(true);
  expect(area('Describe the discrepancy').disabled).toBe(true);
  expect(button('Accept correction').disabled).toBe(true);
  expect(button('After').disabled).toBe(false);
  expect(host.textContent).toContain('read-only');
});

it('submits once and keeps the draft visible until persistence completes', async () => {
  let resolveSave: (() => void) | undefined;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  render(props({ onCreate }));
  write(area('Describe the discrepancy'), request.comment);
  await click('Save request');
  await click('Save request');
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(area('Describe the discrepancy').value).toBe(request.comment);
  expect(button('Save request').disabled).toBe(true);
  await act(async () => {
    resolveSave?.();
    await Promise.resolve();
  });
  expect(area('Describe the discrepancy').value).toBe('');
});

it('keeps reply drafts attached to their own request when selection changes', async () => {
  const p = props({ requests: [request, { ...request, id: 'r2' }], selectedRequestId: 'r1' });
  render(p);
  write(area('Reply to this request'), 'A reply for the first request.');
  render({ ...p, selectedRequestId: 'r2' });
  expect(area('Reply to this request').value).toBe('');
  write(area('Reply to this request'), 'A reply for the second request.');
  render(p);
  expect(area('Reply to this request').value).toBe('A reply for the first request.');
  await click('Save reply');
  expect(p.onReply).toHaveBeenCalledWith('r1', 'A reply for the first request.');
});

it('never shows controls for a proposal belonging to a different request', () => {
  render(
    props({
      requests: [request],
      selectedRequestId: 'r1',
      proposal: { ...proposal, requestId: 'r2' },
    }),
  );
  expect(host.textContent).not.toContain(proposal.explanation);
  expect(
    [...host.querySelectorAll('button')].some((b) => b.textContent === 'Accept correction'),
  ).toBe(false);
});

it('requires finite pin coordinates and a comment within the storage limit', async () => {
  const p = props();
  render(p);
  await click('Location pin');
  render({ ...p, pin: { position: [NaN, 30, 20] } });
  write(area('Describe the discrepancy'), request.comment);
  expect(button('Save request').disabled).toBe(true);
  render({ ...p, pin: { position: [0, 30, 20] } });
  write(area('Describe the discrepancy'), 'x'.repeat(4001));
  expect(button('Save request').disabled).toBe(true);
  expect(p.onCreate).not.toHaveBeenCalled();
});
