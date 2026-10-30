/**
 * Settings, Models and detection: the Analytics pack section and the detector library. The graphics
 * card check is the real one, so `ap-hw` names the card on a computer with a suitable NVIDIA card
 * and says why not on one without (CI). A detector saved to the library through IPC is listed with
 * "No reviews yet". No pack is installed, so the section offers the install.
 */
import { expect, test } from './fixtures';

const DETECTOR_ID = 'e2e-dark-patch';

const detector = {
  schema: 'aio.vlm-detector/1',
  id: DETECTOR_ID,
  name: 'Dark patch',
  version: 1,
  classId: 'patch',
  assetTypes: ['roof'],
  looksLike: 'a dark patch on the surface',
  ignore: 'shadows of the drone',
  question: 'Is this a dark patch on the surface?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen2.5-vl-7b-instruct-q4_k_m', modelSha256: 'a'.repeat(64) },
  author: 'e2e',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'experimental',
};

test('the Analytics pack section shows the hardware check and the detector library', async ({
  win,
}) => {
  const saved = await win.evaluate(
    (d) => window.aio.invoke('detectors:save', { where: 'library', detector: d }),
    detector as never,
  );
  expect(saved).toMatchObject({ ok: true, version: 1 });

  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Models and detection' })
    .click();

  // the pack section: the card check answered (a card with its memory, or why not)
  const pack = win.getByTestId('analytics-pack');
  await pack.scrollIntoViewIfNeeded();
  const hw = win.getByTestId('ap-hw');
  await expect(hw).not.toContainText('Checking the graphics card', { timeout: 30_000 });
  const ok = await hw.evaluate((el) => el.classList.contains('ok'));
  if (ok) await expect(hw).toContainText(/ · \d+ GB · \d+\.\d GB free$/);
  else await expect(hw).toHaveClass(/\bwarn\b/);
  await expect(hw).not.toBeEmpty();
  await expect(win.getByTestId('ap-install-card')).toBeVisible();

  // the library: the saved detector, not reviewed yet
  const row = win.getByTestId(`dl-row-library-${DETECTOR_ID}`);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText('Dark patch');
  await expect(win.getByTestId(`dl-stats-${DETECTOR_ID}`)).toHaveText('No reviews yet');

  // the pack section and the library row together (at 1100 x 720 both fit)
  const shot = test.info().outputPath('settings-analytics-pack.png');
  await win.screenshot({ path: shot });
  await test.info().attach('settings-analytics-pack', { path: shot, contentType: 'image/png' });
});
