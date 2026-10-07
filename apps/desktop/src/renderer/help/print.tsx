// The printed user guide (guide.html): every chapter of the bundled guide on A4, with a cover
// and contents. tools/guide/build-pdf.mjs loads it in a hidden window, waits for
// `window.__guide.state === 'ready'` and prints it with printToPDF, like the house report.
import '../zodJitless';
import '@aio/ui/fonts.css';
import '@aio/ui/tokens.css';
import './help.css';
import './print.css';
import { brand } from '@aio/brand';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { build, formatBuildTime } from '../buildStamp';
import { BrandLockup } from '../shell/BrandMark';
import { GuideArticle } from './GuideArticle';
import { guideChapters } from './guide';

interface GuideState {
  state: 'loading' | 'ready' | 'error';
  chapters: number;
  images: number;
  error?: string;
}

const w = window as unknown as { __guide: GuideState };
w.__guide = { state: 'loading', chapters: 0, images: 0 };

function PrintedGuide() {
  const chapters = guideChapters();
  return (
    <>
      <section className="pg-cover">
        <div className="pg-mark">
          <BrandLockup />
        </div>
        <h1>User guide</h1>
        <p className="pg-sub">
          Version {build.version} · {formatBuildTime(build.time, { year: true }).split(',')[0]}
        </p>
        <p className="pg-company">{brand.company}</p>
      </section>
      <section className="pg-contents">
        <h2>Contents</h2>
        <ol>
          {chapters.map((c) => (
            <li key={c.slug}>{c.title}</li>
          ))}
        </ol>
        <p className="pg-note">
          The same guide is in the app: press F1, or click ? in the title bar. It works offline and
          can be searched.
        </p>
      </section>
      {chapters.map((c, i) => (
        <section key={c.slug} className="pg-chapter guide">
          <div className="pg-num">Chapter {i + 1}</div>
          <GuideArticle chapter={c.slug} blocks={c.blocks} eager />
        </section>
      ))}
    </>
  );
}

async function main() {
  const host = document.getElementById('guide');
  if (!host) throw new Error('Missing #guide element');
  flushSync(() => {
    createRoot(host).render(<PrintedGuide />);
  });
  const images = [...document.images];
  await Promise.all(
    images.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener(
              'load',
              () => {
                resolve();
              },
              { once: true },
            );
            img.addEventListener(
              'error',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
    ),
  );
  await document.fonts.ready;
  w.__guide = {
    state: 'ready',
    chapters: document.querySelectorAll('.pg-chapter').length,
    images: images.filter((i) => i.naturalWidth > 0).length,
  };
}

main().catch((e: unknown) => {
  w.__guide = { ...w.__guide, state: 'error', error: String(e) };
});
