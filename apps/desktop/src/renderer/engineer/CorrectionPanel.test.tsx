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
    onSubmit: vi.fn(),
    onResend: vi.fn(),
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
/** The accessible name: aria-labelledby text, else aria-label. */
function accessibleName(element: Element) {
  const ids = element.getAttribute('aria-labelledby');
  if (ids)
    return ids
      .split(/\s+/)
      .map((ref) => document.getElementById(ref)?.textContent.trim() ?? '')
      .join(' ');
  return element.getAttribute('aria-label') ?? '';
}
function area(name: string) {
  const found = [...host.querySelectorAll('textarea')].find((a) => accessibleName(a) === name);
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
const BOX = "Tell the AI what's wrong";
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
      'eng.correction.request': 'Dites à l’IA ce qui ne va pas',
      'eng.correction.commentPlaceholder': 'Que faut-il modifier ?',
      'eng.correction.status.open': 'En attente',
      'eng.correction.send_one': 'Envoyer {count} demande',
      'eng.correction.send_other': 'Envoyer {count} demandes',
    });
  });
  expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Corrections du modèle');
  expect(button('Afficher le nuage source')).toBeDefined();
  expect(area('Dites à l’IA ce qui ne va pas').placeholder).toBe('Que faut-il modifier ?');
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
  expect(button('Save without sending').disabled).toBe(true);
  write(area(BOX), '  Raise this radio to its mount.  ');
  const evidence = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(evidence).not.toBeNull();
  act(() => evidence?.click());
  await click('Save without sending');
  expect(p.onSubmit).toHaveBeenCalledWith({
    target: request.target,
    comment: request.comment,
    evidenceIds: ['img-12'],
    send: false,
  });
  expect(area(BOX).value).toBe('');
  expect(p.onSend).not.toHaveBeenCalled();
});

it('retains the correction text and displays a failed-save error for retry', async () => {
  const p = props({
    onSubmit: vi.fn().mockRejectedValue(new Error('Project could not be saved.')),
  });
  render(p);
  write(area(BOX), request.comment);
  await click('Save without sending');
  expect(area(BOX).value).toBe(request.comment);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Project could not be saved.',
  );
  expect(button('Save without sending').disabled).toBe(false);
});

it('offers location picking and sends the exact pin coordinates without rounding them', async () => {
  const p = props();
  render(p);
  await click('Location pin');
  expect(p.onPinModeChange).toHaveBeenLastCalledWith(true);
  render({ ...p, pinMode: true });
  expect(host.textContent).toContain('Click a surface on the model or point cloud');
  expect(button('Save without sending').disabled).toBe(true);
  const pin = {
    position: [102.123456, 31.25, -400.45678] as [number, number, number],
    layerId: 'cloud-a',
  };
  render({ ...p, pin, pinMode: false });
  write(area(BOX), 'Add the missing radio at this point.');
  expect(host.textContent).toContain('X 102.123, Y 31.250, Z -400.457');
  expect(host.textContent).not.toContain('102.123456');
  await click('Save without sending');
  expect(p.onSubmit).toHaveBeenCalledWith({
    target: { kind: 'pin', ...pin, radiusM: 2 },
    comment: 'Add the missing radio at this point.',
    evidenceIds: [],
    send: false,
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
  write(area(BOX), request.comment);
  await click('Save without sending');
  expect(p.onSubmit).toHaveBeenCalledWith({
    target: { kind: 'pin', position: [100, 30, -20], radiusM: 0.5 },
    comment: request.comment,
    evidenceIds: [],
    send: false,
  });
  render({ ...p, pinRadiusM: 6 });
  write(area(BOX), request.comment);
  expect(button('Save without sending').disabled).toBe(true);
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
  expect(p.onSubmit).not.toHaveBeenCalled();
});

it('keeps inspection available but locks mutations on an accepted model', () => {
  const p = props({
    readOnly: true,
    requests: [{ ...request, status: 'proposed' }],
    selectedRequestId: 'r1',
    proposal,
  });
  render(p);
  expect(button('Save without sending').disabled).toBe(true);
  expect(area(BOX).disabled).toBe(true);
  expect(button('Accept correction').disabled).toBe(true);
  expect(button('After').disabled).toBe(false);
  expect(host.textContent).toContain('read-only');
});

it('submits once and keeps the draft visible until persistence completes', async () => {
  let resolveSave: (() => void) | undefined;
  const onSubmit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  render(props({ onSubmit }));
  write(area(BOX), request.comment);
  await click('Save without sending');
  await click('Save without sending');
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(area(BOX).value).toBe(request.comment);
  expect(button('Save without sending').disabled).toBe(true);
  await act(async () => {
    resolveSave?.();
    await Promise.resolve();
  });
  expect(area(BOX).value).toBe('');
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

it('drops a non-finite pin to a model-wide request and enforces the storage limit', async () => {
  const p = props();
  render(p);
  await click('Location pin');
  render({ ...p, pin: { position: [NaN, 30, 20] } });
  write(area(BOX), request.comment);
  expect(host.textContent).not.toContain('NaN');
  await click('Save without sending');
  expect(p.onSubmit).toHaveBeenLastCalledWith({
    comment: request.comment,
    evidenceIds: [],
    send: false,
  });
  render({ ...p, pin: { position: [0, 30, 20] } });
  write(area(BOX), 'x'.repeat(4001));
  expect(button('Save without sending').disabled).toBe(true);
  expect(button('Send').disabled).toBe(true);
  expect(p.onSubmit).toHaveBeenCalledTimes(1);
});

function description(element: Element) {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((ref) => document.getElementById(ref)?.textContent.trim() ?? '')
    .join(' ');
}
function modelWide(over: Partial<CorrectionPanelProps> = {}): CorrectionPanelProps {
  const p = props(over);
  delete p.selectedPartId;
  return p;
}

it('enables Send with text and no target, and submits a model-wide request that is sent', async () => {
  const p = modelWide();
  render(p);
  expect(host.textContent).toContain("Tell the AI what's wrong");
  write(area(BOX), 'remove the ladder');
  expect(button('Send').disabled).toBe(false);
  await click('Send');
  expect(p.onSubmit).toHaveBeenCalledWith({
    comment: 'remove the ladder',
    evidenceIds: [],
    send: true,
  });
  const [submitted] = vi.mocked(p.onSubmit).mock.calls[0] ?? [];
  expect(submitted?.target).toBeUndefined();
  expect(area(BOX).value).toBe('');
  expect(host.textContent).toContain(
    'Sent. The proposal appears here for Before and After review.',
  );
});

it('collapses the optional target pickers under Point at something', () => {
  render(modelWide());
  const group = [...host.querySelectorAll('details')].find((d) =>
    d.querySelector('summary')?.textContent.includes('Point at something (optional)'),
  );
  expect(group?.open).toBe(false);
  expect(group?.textContent).toContain('Whole model');
});

it.each([
  [
    'busy',
    { busy: true, busyReason: 'modelling' as const },
    'The model is being built or saved. Send is available when it finishes.',
  ],
  [
    'readOnly',
    { readOnly: true },
    'This model is read-only. Open an editable modelling run to request changes.',
  ],
  [
    'blocker',
    { blocker: { message: 'Checking the AI connection…' } },
    'Checking the AI connection…',
  ],
  ['empty', {}, 'Type a correction to send.'],
  [
    'blocker with an empty box',
    { blocker: { message: 'Checking the AI connection…' } },
    'Checking the AI connection…',
  ],
] as const)('a disabled Send names its reason on screen: %s', (kind, over, reason) => {
  render(modelWide(over));
  if (kind === 'blocker') write(area(BOX), 'remove the ladder');
  const send = button('Send');
  expect(send.disabled).toBe(true);
  expect(description(send)).toBe(reason);
  const save = button('Save without sending');
  if (save.disabled) expect(description(save)).not.toBe('');
  if (kind === 'blocker with an empty box')
    expect(description(save)).toBe('Type a correction to send.');
  expect(host.textContent).toContain(reason);
});

it('shows the blocker fix and calls it', async () => {
  const onClick = vi.fn();
  render(
    modelWide({
      blocker: {
        message: 'Finish or cancel the current AI conversation first.',
        fix: { label: 'Open AI settings', onClick },
      },
    }),
  );
  await click('Open AI settings');
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('does not count rejected or proposed requests as waiting', () => {
  render(
    modelWide({
      requests: [
        request,
        { ...request, id: 'r2', status: 'rejected' },
        { ...request, id: 'r3', status: 'proposed' },
      ],
    }),
  );
  expect(button('Send 1 request to AI').disabled).toBe(false);
});

it('counts typed text together with the waiting requests', () => {
  render(modelWide({ requests: [request] }));
  write(area(BOX), 'remove the ladder');
  expect(button('Send 2 requests to AI').disabled).toBe(false);
});

it('resends a rejected request with its reply in one step', async () => {
  const p = props({
    requests: [{ ...request, id: 'fix-1', status: 'rejected' }],
    selectedRequestId: 'fix-1',
  });
  render(p);
  write(area('Reply to this request'), 'try the other ladder');
  await click('Send again');
  expect(p.onResend).toHaveBeenLastCalledWith('fix-1', 'try the other ladder');
  expect(area('Reply to this request').value).toBe('');
  await click('Send again');
  expect(p.onResend).toHaveBeenLastCalledWith('fix-1', undefined);
  render({ ...p, blocker: { message: 'Checking the AI connection…' } });
  expect(button('Send again').disabled).toBe(true);
  expect(description(button('Send again'))).toBe('Checking the AI connection…');
});

it('says a pin is only a view hint when pinNote is set', async () => {
  const note =
    'This model has no known scale or placement yet: the pin is kept as a view hint and the request goes to the whole model.';
  render(props({ pin: { position: [1, 2, 3] }, pinNote: note }));
  await click('Location pin');
  expect(host.textContent).toContain(note);
});

it('notes a provisional scale in the review', () => {
  render(
    props({
      requests: [{ ...request, status: 'proposed' }],
      selectedRequestId: 'r1',
      proposal,
      scaleProvisional: true,
    }),
  );
  expect(host.textContent).toContain(
    'The scale is provisional: sizes in this proposal are model units, not measured metres.',
  );
});

it('keeps the text when submit fails', async () => {
  const p = modelWide({
    onSubmit: vi.fn().mockRejectedValue(new Error('The AI could not be reached.')),
  });
  render(p);
  write(area(BOX), 'remove the ladder');
  await click('Send');
  expect(area(BOX).value).toBe('remove the ladder');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'The AI could not be reached.',
  );
});

it('clears the box and shows the error when the request is saved but sending fails', async () => {
  const p = modelWide({
    onSubmit: vi.fn().mockResolvedValue({ sendError: 'The AI did not answer in time…' }),
  });
  render(p);
  write(area(BOX), 'remove the ladder');
  await click('Send');
  expect(area(BOX).value).toBe('');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'The AI did not answer in time…',
  );
  expect(host.textContent).not.toContain('Sent. The proposal appears here');
});

it('clears the reply and shows the error when a resend is saved but not sent', async () => {
  const p = props({
    requests: [{ ...request, id: 'fix-1', status: 'rejected' }],
    selectedRequestId: 'fix-1',
    onResend: vi.fn().mockResolvedValue({ sendError: 'The AI did not answer in time…' }),
  });
  render(p);
  write(area('Reply to this request'), 'try the other ladder');
  await click('Send again');
  expect(area('Reply to this request').value).toBe('');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'The AI did not answer in time…',
  );
  expect(host.textContent).not.toContain('Sent. The proposal appears here');
});
