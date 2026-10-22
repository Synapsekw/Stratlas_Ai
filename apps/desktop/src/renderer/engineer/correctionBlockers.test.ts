import type { SessionState } from '@aio/ai';
import { describe, expect, it } from 'vitest';
import { correctionSendBlocker } from './correctionBlockers';

type Availability = SessionState['availability'];
const none = { photos: false, scans: false, drawings: false };
const cloud: Availability = {
  status: 'ready',
  cloud: true,
  route: { kind: 'cloud' } as never,
};
const local: Availability = { ...cloud, cloud: false };
const base = {
  readOnly: false,
  availability: cloud,
  agentBusy: false,
  preview: false,
  required: none,
  allowed: none,
};

describe('correctionSendBlocker', () => {
  it('is null when nothing blocks', () => {
    expect(correctionSendBlocker(base)).toBeNull();
  });
  it('reports read only', () => {
    expect(correctionSendBlocker({ ...base, readOnly: true })).toEqual({ kind: 'readOnly' });
  });
  it('reports checking', () => {
    expect(correctionSendBlocker({ ...base, availability: { status: 'checking' } })).toEqual({
      kind: 'checking',
    });
  });
  it('reports a disabled route with its message', () => {
    const availability = {
      status: 'disabled',
      reason: 'no-bridge',
      message: 'No route.',
    } as Availability;
    expect(correctionSendBlocker({ ...base, availability })).toEqual({
      kind: 'route',
      message: 'No route.',
    });
  });
  it('reports a busy conversation or open preview', () => {
    expect(correctionSendBlocker({ ...base, agentBusy: true })).toEqual({ kind: 'conversation' });
    expect(correctionSendBlocker({ ...base, preview: true })).toEqual({ kind: 'conversation' });
  });
  it('lists missing permissions on a cloud route', () => {
    expect(correctionSendBlocker({ ...base, required: { ...none, photos: true } })).toEqual({
      kind: 'permission',
      missing: ['photos'],
    });
  });
  it('ignores permissions on a local route', () => {
    expect(
      correctionSendBlocker({ ...base, availability: local, required: { ...none, photos: true } }),
    ).toBeNull();
  });
  it('lets checking win over conversation, and read only win over all', () => {
    const busy = { ...base, agentBusy: true, availability: { status: 'checking' } as Availability };
    expect(correctionSendBlocker(busy)).toEqual({ kind: 'checking' });
    expect(correctionSendBlocker({ ...busy, readOnly: true })).toEqual({ kind: 'readOnly' });
  });
});
