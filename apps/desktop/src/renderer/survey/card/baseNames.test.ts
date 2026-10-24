import { t } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import { kitBaseName } from './baseNames';

describe('kit base names', () => {
  it('the kit tin base reads "Triangulated toe", as the engine\'s smart base does', () => {
    expect(kitBaseName('tin', t)).toBe('Triangulated toe');
    expect(kitBaseName('tin', t)).toBe(t('base.smart'));
  });

  it('names the other kit bases plainly, and an unknown id as it is', () => {
    expect(kitBaseName('plane', t)).toBe('Best-fit plane');
    expect(kitBaseName('low', t)).toBe('Lowest point');
    expect(kitBaseName('mystery', t)).toBe('mystery');
  });
});
