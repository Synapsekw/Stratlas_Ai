import { DEFAULT_HOSTING, HostingModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  addressProblem,
  groupFingerprint,
  normaliseAddress,
  previewLabelShown,
  teamServerShown,
} from './teamServerView';

describe('Settings, Team server', () => {
  it('shows the preview label from the one hosting flag', () => {
    expect(teamServerShown(DEFAULT_HOSTING)).toBe(true);
    expect(previewLabelShown(DEFAULT_HOSTING)).toBe(true);
    const ga = HostingModel.parse({ server: 'ga' });
    expect(teamServerShown(ga)).toBe(true);
    expect(previewLabelShown(ga)).toBe(false);
    expect(teamServerShown(HostingModel.parse({ server: 'off' }))).toBe(false);
    expect(teamServerShown(HostingModel.parse({ modes: ['off', 'exchange', 'hub'] }))).toBe(false);
  });

  it('groups a fingerprint for reading aloud', () => {
    expect(groupFingerprint(`${'ab12'.repeat(15)}cd34`)).toBe(`${'AB12 '.repeat(15)}CD34`);
  });

  it('wants a secure address, adding https when it is left out', () => {
    expect(addressProblem('https://team.example.com:8443')).toBeNull();
    expect(addressProblem('')).toBeNull();
    expect(addressProblem('http://team.example.com')).toBe('teamServer.address.https');
    expect(addressProblem('not a url')).toBe('teamServer.address.https');
    expect(normaliseAddress(' team.example.com:8443 ')).toBe('https://team.example.com:8443');
    expect(normaliseAddress('https://team.example.com')).toBe('https://team.example.com');
  });
});
