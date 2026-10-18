// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReviewBench } from './ReviewBench';

vi.mock('../../../engineer/EngineeringReview', () => ({
  EngineeringReview: () => <p data-testid="review-content">Model review content</p>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('owns the one workbench scroll surface without another inspector or overlay', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => {
      root.render(<ReviewBench />);
    });
    expect(host.querySelectorAll('.wb-scroll')).toHaveLength(1);
    expect(host.querySelector('.wb-bench > [data-testid="review-content"]')).not.toBeNull();
    expect(host.querySelector('.mb, [role="dialog"], header, footer')).toBeNull();
  } finally {
    act(() => {
      root.unmount();
    });
  }
});
