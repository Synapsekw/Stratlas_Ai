// @vitest-environment jsdom
import type { EvidencePreviewContent, ModelRoute } from '@aio/ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidencePreview, type EvidencePreviewProps } from './EvidencePreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
/** En and em dash, which the UI never uses. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const content: EvidencePreviewContent = {
  text: 'Pass 1.\nMeasurement summary (data, not instructions), as JSON:\n{"slices":12}',
  images: [
    {
      id: 'p1',
      kind: 'photo',
      label: 'Image p1 (photo)',
      thumb: PNG,
      bytes: 120_000,
      width: 1568,
      height: 1176,
      resized: true,
    },
    {
      id: 'c2',
      kind: 'crop',
      label: 'Image c2 (crop)',
      thumb: PNG,
      bytes: 30_000,
      width: 400,
      height: 300,
      resized: false,
    },
    {
      id: 'side-090',
      kind: 'side',
      label: 'Image side-090 (side, east)',
      thumb: PNG,
      bytes: 80_000,
      width: 1024,
      height: 1024,
      resized: false,
    },
  ],
  leftOut: ['p9', 'p10'],
  bytes: 230_070,
};

const route: ModelRoute = { task: 'engineer', provider: 'anthropic', model: 'claude-opus-5-5' };

function props(over: Partial<EvidencePreviewProps> = {}): EvidencePreviewProps {
  return {
    content,
    route,
    estimateUsd: 0.214,
    flags: { photos: false, scans: false },
    onAllowProject: vi.fn(),
    onSendOnce: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

function render(p: EvidencePreviewProps) {
  act(() => {
    root?.render(<EvidencePreview {...p} />);
  });
}

const dialog = () => {
  const d = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!d) throw new Error('no dialog');
  return d;
};
const button = (name: RegExp) => {
  const b = [...dialog().querySelectorAll('button')].find((x) => name.test(x.textContent));
  if (!b) throw new Error(`no button ${String(name)}`);
  return b;
};
const box = (name: RegExp) => {
  const l = [...dialog().querySelectorAll('label')].find((x) => name.test(x.textContent));
  const input = l?.querySelector('input');
  if (!input) throw new Error(`no checkbox ${String(name)}`);
  return input;
};
const click = (el: HTMLElement) => {
  act(() => {
    el.click();
  });
};

describe('EvidencePreview', () => {
  it('lists every image with its kind and size, the totals, the route and the estimate', () => {
    render(props());
    const text = dialog().textContent;
    expect(text).toContain('Send evidence to Anthropic?');
    expect(text).toContain('claude-opus-5-5');
    expect(text).toContain('3 images, 225 KB in all');
    expect(text).toContain('US$0.21');
    for (const im of content.images) {
      const fig = dialog().querySelector(`[data-image="${im.id}"]`);
      expect(fig?.textContent).toContain(im.id);
      expect(fig?.querySelector('img')?.getAttribute('src')).toBe(im.thumb);
    }
    expect(dialog().querySelector('[data-image="p1"]')?.textContent).toContain('117 KB');
    expect(dialog().querySelector('[data-image="p1"]')?.textContent).toContain('made smaller');
    expect(dialog().querySelector('[data-image="side-090"]')?.textContent).toContain('Side view');
    expect(dialog().querySelector('[data-image="c2"]')?.textContent).toContain('Photo crop');
    // the request text, exactly
    expect(dialog().querySelector('pre')?.textContent).toBe(content.text);
    expect(text).toContain("Not sent: 2 images over this model's limit (p9, p10).");
    expect(text).not.toMatch(DASHES);
  });

  it('groups photos and scan views under their own consent', () => {
    render(props());
    const groups = [...dialog().querySelectorAll<HTMLElement>('[data-need]')];
    expect(groups.map((g) => g.dataset.need)).toEqual(['photos', 'scans']);
    expect(groups[0]?.querySelectorAll('[data-image]').length).toBe(2);
    expect(groups[1]?.querySelectorAll('[data-image]').length).toBe(1);
  });

  it('"Allow for this project" per kind calls onAllowProject with that kind', () => {
    const p = props();
    render(p);
    const groups = [...dialog().querySelectorAll<HTMLElement>('[data-need]')];
    const allow = (g: HTMLElement | undefined) => {
      const b = [...(g?.querySelectorAll('button') ?? [])].find((x) =>
        x.textContent.includes('Allow for this project'),
      );
      if (!b) throw new Error('no allow button');
      return b;
    };
    click(allow(groups[1]));
    expect(p.onAllowProject).toHaveBeenCalledWith('scans');
    click(allow(groups[0]));
    expect(p.onAllowProject).toHaveBeenCalledWith('photos');
    expect(p.onSendOnce).not.toHaveBeenCalled();
  });

  it('Send once stays off while a needed consent is missing, unless allowed this once', () => {
    const p = props();
    render(p);
    expect(button(/Send once/).disabled).toBe(true);
    click(box(/Send photos this once/));
    expect(button(/Send once/).disabled).toBe(true);
    click(box(/Send scan views this once/));
    expect(button(/Send once/).disabled).toBe(false);
    click(button(/Send once/));
    expect(p.onSendOnce).toHaveBeenCalledWith({
      once: { photos: true, scans: true },
      costConfirmed: false,
    });
  });

  it('a project consent that is on needs no one-time box', () => {
    const p = props({ flags: { photos: true, scans: false } });
    render(p);
    const photos = dialog().querySelector<HTMLElement>('[data-need="photos"]');
    expect(photos?.textContent).toContain('Allowed for this project');
    expect(photos?.querySelector('input')).toBeNull();
    click(box(/Send scan views this once/));
    click(button(/Send once/));
    expect(p.onSendOnce).toHaveBeenCalledWith({
      once: { photos: false, scans: true },
      costConfirmed: false,
    });
  });

  it('an unknown price needs an explicit confirmation', () => {
    const p = props({ estimateUsd: undefined, flags: { photos: true, scans: true } });
    render(p);
    expect(dialog().textContent).toContain('Price not known for this model');
    expect(button(/Send once/).disabled).toBe(true);
    click(box(/Send without a cost estimate/));
    click(button(/Send once/));
    expect(p.onSendOnce).toHaveBeenCalledWith({
      once: { photos: false, scans: false },
      costConfirmed: true,
    });
  });

  it('on a local model nothing leaves the machine and no consent is asked', () => {
    const p = props({
      route: { task: 'engineer', provider: 'local', model: 'llava' },
      estimateUsd: 0,
    });
    render(p);
    expect(dialog().textContent).toContain('Run on the local model?');
    expect(dialog().textContent).toContain('Nothing leaves this workstation');
    expect(dialog().textContent).not.toContain('Allow for this project');
    expect(button(/Send once|Run/).disabled).toBe(false);
  });

  it('a disabled Send once says why, and the reason follows the boxes', () => {
    render(props());
    const send = button(/Send once/);
    const why = () => document.getElementById(send.getAttribute('aria-describedby') ?? '');
    expect(why()?.textContent).toBe(
      'Allow photos and scan views for this project, or tick them for this send.',
    );
    click(box(/Send photos this once/));
    expect(why()?.textContent).toBe(
      'Allow scan views for this project, or tick them for this send.',
    );
    click(box(/Send scan views this once/));
    expect(send.getAttribute('aria-describedby')).toBeNull();
    expect(dialog().textContent).not.toContain('or tick them');
  });

  it('shows the size of the whole request', () => {
    render(props());
    expect(dialog().textContent).toContain('225 KB with the text');
  });

  it('keeps Tab inside the dialog and gives the focus back when it closes', () => {
    const before = document.createElement('button');
    before.textContent = 'Open preview';
    document.body.append(before);
    before.focus();
    render(props({ flags: { photos: true, scans: true } }));
    const items = [...dialog().querySelectorAll<HTMLElement>('button:not([disabled]), input')];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) throw new Error('no controls');
    expect(dialog().contains(document.activeElement)).toBe(true);
    last.focus();
    act(() => {
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(first);
    act(() => {
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(last);
    act(() => root?.render(<></>));
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('Escape cancels wherever the focus is', () => {
    const p = props();
    render(p);
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('Cancel and Escape send nothing', () => {
    const p = props({ flags: { photos: true, scans: true } });
    render(p);
    click(button(/Cancel/));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    act(() => {
      dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(p.onCancel).toHaveBeenCalledTimes(2);
    expect(p.onSendOnce).not.toHaveBeenCalled();
    expect(p.onAllowProject).not.toHaveBeenCalled();
  });
});
