// Part B of the volumetric report (the founder-approved layout of 20 Nov 2026): the site overview
// (`page.part === 'overview'`, see overview.tsx), then the pile pages with one full card per pile,
// two to a page (`pagePlan` indexes `model.cards`; see pileCard.tsx). Every pile has a card, with
// a volume or not. The report's last printed page, whichever it is, closes with the closing
// remarks and the method note (`LastBlocks`); the room they take comes off the pictures or the
// cards' charts, by counts.
import type { VolumetricModel, VolumetricPile } from '@aio/project/export';
import { t } from '@aio/ui';
import type { ReactElement } from 'react';
import type { PageComponent, PageContext } from '../types/template';
import { dateText, LastBlocks, lastBlocksMm, Page, volumetricTexts } from './chrome';
import { Overview } from './overview';
import { PileCard } from './pileCard';
import './piles.css';

/** A pile page's title: "Piles 3 to 4 of 9", or "Pile 9 of 9" for a page with one card. */
export function pilesTitle(from: number, to: number, total: number): string {
  return to > from
    ? t('vreport.piles.range', { from, to, total })
    : t('vreport.piles.rangeOne', { from, total });
}

/** The site overview, or a page of two pile cards. */
export function PilesPage({
  model,
  text,
  views,
  page,
  total,
}: PageContext<VolumetricModel>): ReactElement {
  const texts = volumetricTexts(model, text);
  const last = page.number === total;
  const reserve = lastBlocksMm(texts, last);
  if (page.part === 'overview')
    return (
      <Page kind="piles" number={page.number} by={texts.preparedBy}>
        <Overview model={model} views={views} reserveMm={reserve} />
        <LastBlocks texts={texts} last={last} />
      </Page>
    );
  const byId = new Map(model.piles.map((p) => [p.id, p]));
  const cards = model.cards
    .slice(page.from, page.to)
    .map((id) => byId.get(id))
    .filter((p): p is VolumetricPile => p !== undefined);
  // a page with one card has the other card's room for the closing block
  const perCard = cards.length > 1 ? reserve / cards.length : 0;
  return (
    <Page kind="piles" number={page.number} by={texts.preparedBy}>
      <header className="vr-pile-page-head">
        <h1>{pilesTitle(page.from + 1, page.from + cards.length, model.cards.length)}</h1>
        {model.latest ? (
          <span>{t('vreport.band.surveyed', { date: dateText(model.latest.date) })}</span>
        ) : null}
      </header>
      {cards.map((p) => {
        const note = (text.pileNotes[p.id] ?? p.note ?? '').trim();
        return (
          <PileCard
            key={p.id}
            model={model}
            pile={p}
            note={note === '' ? null : note}
            views={views}
            reserveMm={perCard}
          />
        );
      })}
      <LastBlocks texts={texts} last={last} />
    </Page>
  );
}

/** Part B's entry in the volumetric template (collected by `types/index.ts`). */
export const volumetricPage: { id: 'piles'; component: PageComponent<VolumetricModel> } = {
  id: 'piles',
  component: PilesPage,
};
