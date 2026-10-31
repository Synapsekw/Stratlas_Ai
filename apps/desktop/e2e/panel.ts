/**
 * The right panel's four fixed tabs (UI revision D2) for the specs: Selection, Tools, Layers &
 * display and Project, each a list of sections. A spec that opened an old workbench tab by its id
 * opens that id's section here (`openBench`); `openSection` opens a tab and, optionally, a section
 * by its new id.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import {
  sectionFor,
  type PanelTab,
  type SectionId,
  type TabId,
} from '../src/renderer/workspace/workbench/tabsModel';

const side = (win: Page) => win.locator('.ws > .right');

/** Show a folded right panel (its edge tab). */
async function unfold(win: Page): Promise<void> {
  if (await win.locator('.ws.right-off').count()) {
    await win.locator('.stage-rp button').click();
    await expect(win.locator('.ws.right-off')).toHaveCount(0);
  }
}

/** The panel tab's button. */
export function panelTab(win: Page, tab: PanelTab): Locator {
  return side(win).locator(`#wb-tab-${tab}`);
}

/** A clicked pile's panel: Selection's (founder, 30 Oct: a clicked pile opens in Selection). */
export function selectedPile(win: Page): Locator {
  return side(win).locator('#wb-panel-selection').getByTestId('pile-panel');
}

/** A section of the panel, header and body. */
export function panelSection(win: Page, section: SectionId): Locator {
  return side(win).locator(`[data-section="${section}"]`);
}

/** The body of the section an old tab id lives in (Selection: the tab's own body). */
export function benchBody(win: Page, id: TabId): Locator {
  const { tab, section } = sectionFor(id);
  if (tab === 'selection') return side(win).locator('#wb-panel-selection');
  return panelSection(win, section).locator('.wb-psec-inner');
}

/**
 * Bring a tab forward (unfolding the panel first) and, with `section`, open that section; returns
 * the section's body, or the tab's panel without one.
 */
export async function openSection(win: Page, tab: PanelTab, section?: SectionId): Promise<Locator> {
  await unfold(win);
  const button = panelTab(win, tab);
  if ((await button.getAttribute('aria-selected')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
  if (!section) {
    const panel = side(win).locator(`#wb-panel-${tab}`);
    await expect(panel).toBeVisible();
    return panel;
  }
  const sec = panelSection(win, section);
  if ((await sec.getAttribute('data-open')) !== 'true') {
    await sec.locator(':scope > .wb-section-head').click();
  }
  await expect(sec).toHaveAttribute('data-open', 'true');
  return sec.locator('.wb-psec-inner');
}

/** Open the section an old workbench tab id lives in now, and return its body. */
export async function openBench(win: Page, id: TabId): Promise<Locator> {
  const { tab, section } = sectionFor(id);
  return openSection(win, tab, tab === 'selection' ? undefined : section);
}

/** The panel shows the section an old tab id lives in: its tab in front, the section open. */
export async function expectBench(win: Page, id: TabId): Promise<void> {
  const { tab, section } = sectionFor(id);
  await expect(panelTab(win, tab)).toHaveAttribute('aria-selected', 'true');
  if (tab !== 'selection')
    await expect(panelSection(win, section)).toHaveAttribute('data-open', 'true');
}
