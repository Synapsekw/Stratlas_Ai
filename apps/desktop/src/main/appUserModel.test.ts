import { describe, expect, it } from 'vitest';
import { appUserModelId } from './appUserModel';

describe('appUserModelId', () => {
  it('sets the brand app id for the installers and the portable exe', () => {
    expect(appUserModelId('ai.example.app', undefined)).toBe('ai.example.app');
    expect(appUserModelId('ai.example.app', false)).toBe('ai.example.app');
  });

  it('leaves the id to the MSIX package, which supplies its own', () => {
    expect(appUserModelId('ai.example.app', true)).toBeNull();
  });
});
