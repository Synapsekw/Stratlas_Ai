import { messagesEn, t, type MessageKey } from '@aio/ui';
import { describe, expect, it } from 'vitest';

/**
 * One name for the AI (design section 6): "Ask AI" everywhere the feature is named, and the AI
 * status says "AI", never "Cloud AI". The wider copy sweep (every "agent" in running text) is the
 * glossary's work; this pins the names and the states.
 */
const NAMES: MessageKey[] = [
  'agent.dock.name',
  'agent.dock.label',
  'island.askAgent',
  'island.tile.askAgent',
  'askAi.button',
  'askAi.settings.title',
];

/** The AI's own words in the shell: the status chip, the connection menu's row, its fallbacks. */
const STATUS = Object.keys(messagesEn).filter(
  (k) =>
    k.startsWith('aiStatus.') ||
    k.startsWith('titlebar.cloud') ||
    k === 'connection.cloud' ||
    k === 'agent.offRow' ||
    k === 'agent.dock.tip',
) as MessageKey[];

const FORBIDDEN = /\bAgent\b|\bAsk (the )?agent\b|AI for Ask AI|\bCloud AI\b/;

describe('one AI name', () => {
  it('names the feature Ask AI', () => {
    for (const key of NAMES) expect(t(key), key).toBe('Ask AI');
  });

  it('no UI string says Agent, Ask agent or AI for Ask AI, and the status never says Cloud AI', () => {
    expect(STATUS.length).toBeGreaterThan(10);
    for (const key of [...NAMES, ...STATUS])
      expect(messagesEn[key as keyof typeof messagesEn], key).not.toMatch(FORBIDDEN);
  });
});
