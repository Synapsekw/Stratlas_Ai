// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CorrectionPanel } from './CorrectionPanel';
import { correctionDraftKey, setCorrectionDraftKey, useCorrectionDraft } from './correctionDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof useCorrectionDraft>;
let save = vi.fn<() => Promise<void>>();
const key = correctionDraftKey('project-a', 'run-a');
function Harness({ context = key }: { context?: string | null }) {
  const draft = useCorrectionDraft(context);
  useEffect(() => {
    api = draft;
  });
  return (
    <CorrectionPanel
      parts={[{ id: 'part-a', label: 'Mount' }]}
      selectedPartId="part-a"
      pinMode={false}
      pinRadiusM={draft.pinRadiusM}
      {...(draft.pin ? { pin: { position: draft.pin.point, layerId: draft.pin.layerId } } : {})}
      draft={draft.composer}
      onDraftChange={draft.setComposer}
      onDiscardDraft={draft.discard}
      evidenceOptions={[{ id: 'photo-a', label: 'Source photo' }]}
      requests={[]}
      busy={draft.working}
      view="before"
      onSelectPart={vi.fn()}
      onPinModeChange={vi.fn()}
      onClearPin={() => {
        draft.setPin(undefined);
      }}
      onSubmit={async () => {
        if (!draft.begin()) return;
        try {
          await save();
          draft.setPin(undefined);
        } finally {
          draft.setWorking(false);
        }
      }}
      onSelectRequest={vi.fn()}
      onSend={vi.fn()}
      onViewChange={vi.fn()}
      onFocusTarget={vi.fn()}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      onReply={vi.fn()}
      onResend={vi.fn()}
    />
  );
}
function render(context = key) {
  act(() => {
    root.render(<Harness context={context} />);
  });
}
function away() {
  act(() => {
    root.render(<p>Another workbench</p>);
  });
}
function button(label: string) {
  const result = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}
function comment() {
  const result = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Describe the discrepancy"]',
  );
  if (!result) throw new Error('Missing comment');
  return result;
}
function write(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      comment(),
      text,
    );
    comment().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  setCorrectionDraftKey(null);
  save = vi.fn(() => Promise.resolve());
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  setCorrectionDraftKey(null);
});

it('keeps unsaved text, exact pin and evidence when the workbench unmounts and returns', () => {
  render();
  act(() => {
    api.setPin({
      point: [1.234567, 2, 3],
      modelPoint: [1, 2, 3],
      layerId: 'cloud',
      camera: { position: [5, 5, 5], target: [1, 2, 3] },
    });
    api.setComposer({ targetMode: 'pin', evidenceIds: ['photo-a'] });
    api.setRequestId('saved-request');
    api.setView('after');
  });
  write('This mount connection is missing.');
  away();
  render();
  expect(comment().value).toBe('This mount connection is missing.');
  expect(api.pin?.point).toEqual([1.234567, 2, 3]);
  expect(api.requestId).toBe('saved-request');
  expect(api.view).toBe('after');
  expect(host.textContent).toContain('X 1.235');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  act(() => {
    button('Discard draft').click();
  });
  expect(comment().value).toBe('');
  expect(api.pin).toBeUndefined();
  expect(api.composer.evidenceIds).toEqual([]);
});

it('offers a Place pin action after returning to an unfinished location pick', () => {
  render();
  act(() => {
    api.setComposer({ targetMode: 'pin' });
  });
  away();
  render();
  expect(button('Place pin').disabled).toBe(false);
  expect(host.textContent).toContain('Choose Place pin');
  expect(host.textContent).not.toContain('Click a surface on the model');
});

it('keeps the in-flight save locked across remount and clears the saved draft once', async () => {
  let finish: () => void = () => {
    throw new Error('Save has not started');
  };
  save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render();
  write('Move the radio to its measured mount.');
  act(() => {
    button('Save without sending').click();
  });
  away();
  render();
  expect(button('Save without sending').disabled).toBe(true);
  act(() => {
    button('Save without sending').click();
  });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(comment().value).toBe('');
  expect(api.working).toBe(false);
});

it('clears drafts on a project/run change and ignores old async completions even after returning', async () => {
  let finish: () => void = () => {
    throw new Error('Save has not started');
  };
  save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render();
  write('Old project comment');
  act(() => {
    button('Save without sending').click();
  });
  away();
  setCorrectionDraftKey(correctionDraftKey('project-b', 'run-a'));
  render(correctionDraftKey('project-b', 'run-a'));
  expect(comment().value).toBe('');
  away();
  render();
  write('New draft after returning');
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(comment().value).toBe('New draft after returning');
  away();
  render(correctionDraftKey('project-a', 'run-b'));
  expect(comment().value).toBe('');
});
