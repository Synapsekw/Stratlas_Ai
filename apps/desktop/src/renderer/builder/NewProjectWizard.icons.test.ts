// @vitest-environment jsdom
// The project type cards of the New project wizard: each type has its own icon from the set.
import { ICONS } from '@aio/ui';
import { describe, expect, it } from 'vitest';
import { TYPE_ICON } from './NewProjectWizard';

describe('New project wizard type icons', () => {
  it('draws the Telecom towers card with the tower icon, not the telemetry chart', () => {
    expect(TYPE_ICON.telecom).toBe('tower');
    expect(Object.hasOwn(ICONS, TYPE_ICON.telecom)).toBe(true);
  });

  it('gives every type a different icon', () => {
    const icons = Object.values(TYPE_ICON);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
