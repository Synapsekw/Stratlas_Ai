import { formatDate, t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import { dateLabel, editBlocked, inPackage, readOnly } from './reasons';

describe('menu reasons', () => {
  it('says why a change is greyed: the package first, then a reviewer who may only look', () => {
    expect(editBlocked({ pkg: true, canEdit: false })).toBe(t('actions.reason.package'));
    expect(editBlocked({ pkg: false, canEdit: false })).toBe(t('actions.reason.readOnly'));
    expect(editBlocked({ pkg: false, canEdit: true })).toBe(false);
    expect(readOnly({ pkg: true, canEdit: true })).toBe(false);
    expect(readOnly({ pkg: false, canEdit: false })).toBe(t('actions.reason.readOnly'));
    expect(inPackage({ pkg: true, canEdit: true })).toBe(t('actions.reason.package'));
    expect(inPackage({ pkg: false, canEdit: false })).toBe(false);
  });

  it('labels a date by its day, with its name when it has one', () => {
    expect(dateLabel({ id: 'a', label: '2026-09-01', date: '2026-09-01' })).toBe(
      formatDate('2026-09-01'),
    );
    expect(dateLabel({ id: 'b', label: 'After rain', date: '2026-10-01' })).toBe(
      `${formatDate('2026-10-01')} · After rain`,
    );
  });
});
