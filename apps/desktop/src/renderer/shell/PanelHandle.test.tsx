// @vitest-environment jsdom
import { t } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_ID, PanelHandle, panelHandleLabel, type PanelSide } from './PanelHandle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

function render(side: PanelSide, collapsed: boolean, onToggle: () => void = () => undefined) {
  root ??= createRoot(host);
  act(() =>
    root?.render(
      <PanelHandle
        side={side}
        collapsed={collapsed}
        shortcut={side === 'left' ? 'global.sidebar' : 'global.rightPanel'}
        onToggle={onToggle}
      />,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="panel-handle-${side}"]`);
  if (!button) throw new Error(`no ${side} handle`);
  return button;
}

describe('panelHandleLabel', () => {
  it('says which side and what the handle does next', () => {
    expect(t(panelHandleLabel('left', false))).toBe('Collapse left sidebar');
    expect(t(panelHandleLabel('left', true))).toBe('Expand left sidebar');
    expect(t(panelHandleLabel('right', false))).toBe('Collapse right sidebar');
    expect(t(panelHandleLabel('right', true))).toBe('Expand right sidebar');
  });
});

describe('PanelHandle', () => {
  it('is a real button that names its side, its panel and its state', () => {
    const left = render('left', false);
    expect(left.tagName).toBe('BUTTON');
    expect(left.type).toBe('button');
    expect(left.getAttribute('aria-label')).toBe('Collapse left sidebar');
    expect(left.getAttribute('aria-expanded')).toBe('true');
    expect(left.getAttribute('aria-controls')).toBe(PANEL_ID.left);
    expect(left.dataset.side).toBe('left');
    expect(left.getAttribute('aria-keyshortcuts')).toMatch(/^(Control|Meta)\+B$/);
  });

  it('mirrors on the right with the right panel and its own shortcut', () => {
    const right = render('right', false);
    expect(right.getAttribute('aria-label')).toBe('Collapse right sidebar');
    expect(right.getAttribute('aria-controls')).toBe(PANEL_ID.right);
    expect(right.dataset.side).toBe('right');
    expect(right.getAttribute('aria-keyshortcuts')).toMatch(/^(Control|Meta)\+Alt\+B$/);
    expect(PANEL_ID.right).not.toBe(PANEL_ID.left);
  });

  it('stays in place when its panel is folded, and offers to bring it back', () => {
    const open = render('right', false);
    const folded = render('right', true);
    expect(folded).toBe(open);
    expect(folded.getAttribute('aria-expanded')).toBe('false');
    expect(folded.getAttribute('aria-label')).toBe('Expand right sidebar');
  });

  it('shows the action and its shortcut in the tool tip', () => {
    const tip = render('left', true).querySelector('.tip');
    expect(tip?.textContent).toContain('Expand left sidebar');
    expect(tip?.querySelector('.kbd')?.textContent).toMatch(/B$/);
  });

  it('draws one chevron in the tab, hidden from assistive technology', () => {
    const button = render('left', false);
    const icons = button.querySelectorAll('.ph-tab svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(icons[0]?.classList.contains('ph-chev')).toBe(true);
  });

  it('toggles on click, once per click', () => {
    const onToggle = vi.fn();
    const button = render('left', false, onToggle);
    act(() => {
      button.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    act(() => {
      button.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
