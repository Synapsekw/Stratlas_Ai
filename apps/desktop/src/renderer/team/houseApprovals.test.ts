import { describe, expect, it } from 'vitest';
import { parseSignOff, signOffHtml } from './houseApprovals';

const block = {
  shared: true,
  prepared: { actor: 'a_r', name: 'Rana Example', initials: 'RE', date: '2026-10-07' },
  reviewed: [{ actor: 'a_o', name: 'Omar Sample', initials: 'OS', date: '2026-10-07' }],
  approved: [{ actor: 'a_l', name: 'Lina <Test>', initials: 'LT', date: '2026-10-08' }],
  accepted: [],
  outOfDate: [],
  findings: { approved: 1, total: 2 },
  required: 1,
};

describe('house report sign-off', () => {
  it('reads the block from the query and refuses anything else', () => {
    expect(parseSignOff(JSON.stringify(block))?.approved[0]?.initials).toBe('LT');
    expect(parseSignOff(null)).toBeNull();
    expect(parseSignOff('not json')).toBeNull();
    expect(parseSignOff(JSON.stringify({ ...block, shared: false }))).toBeNull();
  });

  it('lists prepared, reviewed and approved with names, initials and dates, escaped', () => {
    const html = signOffHtml(block);
    expect(html).toContain('Prepared by');
    expect(html).toContain('<b>Rana Example</b> (RE), 2026-10-07');
    expect(html).toContain('<b>Omar Sample</b> (OS), 2026-10-07');
    expect(html).toContain('Lina &lt;Test&gt;');
    expect(html).toContain('1 of 2 findings approved');
    expect(html).not.toContain('Accepted by the client');
  });
});
