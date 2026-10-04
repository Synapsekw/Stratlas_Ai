import { expect, test } from './fixtures';

test('the zero-network guard blocks and records main-process requests', async ({
  app,
  network,
}) => {
  const errors = await app.evaluate(async ({ net, session }) => {
    const attempts = [
      () => fetch('https://example.invalid/node-fetch'),
      () => net.fetch('https://example.invalid/electron-net'),
      () => session.fromPartition('stratlas-maps').fetch('https://example.invalid/session'),
    ];
    const messages: string[] = [];
    for (const attempt of attempts) {
      try {
        await attempt();
        messages.push('reached the network');
      } catch (e) {
        messages.push(String(e));
      }
    }
    return messages;
  });
  expect(errors).toHaveLength(3);
  for (const message of errors) expect(message).toContain('zero-network guard');
  // Drain the deliberate requests so the fixture's zero-network assertion still holds.
  expect(await network.drain()).toEqual([
    'https://example.invalid/node-fetch',
    'https://example.invalid/electron-net',
    'https://example.invalid/session',
  ]);
});

test('the app starts with no network requests', async ({ win, network }) => {
  await expect(win.locator('body')).toBeVisible();
  expect(await network.outbound()).toEqual([]);
});
