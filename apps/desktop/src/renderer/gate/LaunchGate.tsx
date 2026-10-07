import { brand } from '@aio/brand';
import type { AioBridge, LaunchGateMode } from '@aio/schema';
import { t, useT } from '@aio/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useIdentity } from '../author';
import { build } from '../buildStamp';
import { bridge, useShell } from '../shell';
import { BrandSymbol, BrandWordmark } from '../shell/BrandMark';
import { OS_QUERIES, wantsReducedMotion } from '../theme';
import {
  gateAtStart,
  gateWanted,
  greetingFor,
  localStore,
  orgLine,
  readLaunchHint,
  writeLaunchHint,
} from './model';
import {
  IDLE_MS,
  LIGHT,
  MAX_DT,
  PARALLAX,
  plateOffsets,
  pointerTarget,
  stepSpring,
  type Spring,
} from './motion';
import { drawTerrain } from './terrain';
import './gate.css';

/**
 * The launch screen ("gate"): the Quadrion AI lockup beside a welcome with the person's name and
 * one Enter button, over a point-cloud terrain the pointer scans. It lies over the app shell, which
 * is already mounted (and inert) underneath, so Enter reveals the app at once. Approved design:
 * docs/brand/quadrion/gate/index.html (Split layout).
 *
 * Shown on every start unless Settings, Appearance, Show launch screen is off, and never in an
 * automated run (`AioBridge.launchGate`). Enter (anywhere) or a click opens the app; Esc skips the
 * intro. No sign-in fields: a later team sign-in takes the place of the name in the same panel.
 */

type Phase = 'intro' | 'ready' | 'leaving';

/** Plates, wordmark, tagline and welcome are in by then; the plates then follow the pointer. */
const INTRO_MS = 1300;
const EXIT_MS = 300;
/** Greet without a name if the identity has not answered by then. */
const IDENTITY_WAIT_MS = 1500;
/** The terrain is drawn at about 30 frames a second; the springs step every frame. */
const TERRAIN_FRAME_MS = 33;
const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const NO_POINTER = -9999;

/** Decided once per window load, before the first frame. */
function startState(): { mode: LaunchGateMode; shown: boolean } {
  const aio = window.aio as AioBridge | undefined;
  const mode = aio?.launchGate?.() ?? 'auto';
  return { mode, shown: gateAtStart(mode, readLaunchHint(localStore())) };
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const change = () => {
      setOn(m.matches);
    };
    m.addEventListener('change', change);
    return () => {
      m.removeEventListener('change', change);
    };
  }, [query]);
  return on;
}

/** The app shell under the gate (App.tsx renders it first in #root). */
function appShell(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#root > .app');
}

/**
 * Leave the gate's focus behind: the app opens as on a start without the gate, focus at the top
 * of the page and no ring on a heading. (Blurred while the gate is still in the document, so
 * keepFocusAlive takes it as a deliberate move and does not pick a control for it.)
 */
function releaseFocus(root: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && root.contains(active)) active.blur();
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The live date line, top left: the product is about time. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return (
    <div className="qg-clock" aria-hidden="true">
      {DATE_FORMAT.format(now)} · <b>{TIME_FORMAT.format(now)}</b>
    </div>
  );
}

function Gate({ onGone }: { onGone: () => void }) {
  useT();
  const [phase, setPhase] = useState<Phase>('intro');
  const [instant, setInstant] = useState(false);
  const [waited, setWaited] = useState(false);
  const settings = useShell((s) => s.settings);
  const reduce = wantsReducedMotion(settings.motion, {
    reducedMotion: useMedia(OS_QUERIES.reducedMotion),
  });
  const { identity, error } = useIdentity();
  const greeting = greetingFor(identity, waited || error !== null);

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const phaseRef = useRef<Phase>('intro');
  const reduceRef = useRef(reduce);
  const goneRef = useRef(false);

  const gone = useCallback(() => {
    if (goneRef.current) return;
    goneRef.current = true;
    onGone();
  }, [onGone]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    reduceRef.current = reduce;
  }, [reduce]);

  // The app shell waits underneath, out of reach of Tab, pointer and screen readers.
  useLayoutEffect(() => {
    const app = appShell();
    if (app) app.inert = true;
    return () => {
      if (app) app.inert = false;
    };
  }, []);

  // Main has the record of the switch; the local hint only spares the next start a dark frame.
  useEffect(() => {
    let live = true;
    void bridge.call('launch:get', {}).then((r) => {
      if (!live || !r.ok || !r.value.ok) return;
      const on = gateWanted(r.value.settings);
      writeLaunchHint(localStore(), on);
      if (!on) gone();
    });
    return () => {
      live = false;
    };
  }, [gone]);

  useEffect(() => {
    const id = setTimeout(() => {
      setWaited(true);
    }, IDENTITY_WAIT_MS);
    return () => {
      clearTimeout(id);
    };
  }, []);

  const finishIntro = useCallback(() => {
    setPhase((p) => (p === 'intro' ? 'ready' : p));
  }, []);

  useEffect(() => {
    const id = setTimeout(finishIntro, reduce ? 0 : INTRO_MS);
    return () => {
      clearTimeout(id);
    };
  }, [finishIntro, reduce]);

  const skip = useCallback(() => {
    if (phaseRef.current !== 'intro') return;
    setInstant(true);
    finishIntro();
  }, [finishIntro]);

  /** Open the app: quick, because people see this on every start. */
  const enter = useCallback(() => {
    if (phaseRef.current === 'leaving') return;
    phaseRef.current = 'leaving';
    setPhase('leaving');
    const root = rootRef.current;
    const app = appShell();
    if (app) app.inert = false;
    if (!root) {
      gone();
      return;
    }
    releaseFocus(root);
    const timing = { duration: EXIT_MS, easing: EASE_OUT, fill: 'forwards' as const };
    if (!reduceRef.current) {
      // the gate blurs back, the app comes forward
      mainRef.current?.animate(
        [
          { filter: 'blur(0)', transform: 'none' },
          { filter: 'blur(8px)', transform: 'scale(1.03)' },
        ],
        { ...timing, duration: EXIT_MS - 20 },
      );
      app?.animate([{ transform: 'scale(0.985)' }, { transform: 'none' }], {
        duration: EXIT_MS,
        easing: EASE_OUT,
      });
    }
    root.animate([{ opacity: 1 }, { opacity: 0 }], timing).finished.then(gone, gone);
    // a window hidden mid-exit produces no frames: never keep the gate waiting on them
    setTimeout(gone, EXIT_MS + 200);
  }, [gone]);

  // Keys while the gate is up: Enter anywhere opens the app (except on Skip intro, which it
  // presses), Esc skips the intro, Tab moves between the gate's two buttons; the app's own
  // shortcuts wait until it is open.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current === 'leaving') return;
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (e.target === skipRef.current) return;
        e.preventDefault();
        enter();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // time to interactive: when Enter starts to work, ms since the window began loading
    rootRef.current?.setAttribute('data-ready-ms', String(Math.round(performance.now())));
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [enter, skip]);

  // The terrain and the pointer: one loop steps the springs every frame and draws the terrain
  // at about 30 fps; paused while the window is hidden, still under reduced motion, torn down
  // with the gate.
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !root || !ctx) return;
    const css = getComputedStyle(root);
    const ink = css.getPropertyValue('--fg-0').trim() || 'white';
    const lit = css.getPropertyValue('--acc').trim() || 'aquamarine';
    let width = 0;
    let height = 0;
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const sx: Spring = { x: 0, v: 0 };
    const sy: Spring = { x: 0, v: 0 };
    const lx: Spring = { x: NO_POINTER, v: 0 };
    const ly: Spring = { x: NO_POINTER, v: 0 };
    const draw = (t: number) => {
      drawTerrain(ctx, { width, height, t, sx: sx.x, sy: sy.x, lx: lx.x, ly: ly.x, ink, lit });
    };
    size();

    if (reduce) {
      draw(0);
      const redraw = () => {
        size();
        draw(0);
      };
      window.addEventListener('resize', redraw);
      return () => {
        window.removeEventListener('resize', redraw);
        canvas.width = 0;
        canvas.height = 0;
      };
    }

    const plates = [0, 1, 2, 3].map(
      (i) => markRef.current?.querySelectorAll<SVGElement>(`[data-plate="${String(i)}"]`) ?? [],
    );
    const placePlates = () => {
      plateOffsets(sx.x, sy.x).forEach(([dx, dy], i) => {
        const tf = `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`;
        for (const el of plates[i] ?? []) el.setAttribute('transform', tf);
      });
    };

    let tx = 0;
    let ty = 0;
    let px = NO_POINTER;
    let py = NO_POINTER;
    let lastMove = 0;
    const t0 = performance.now();
    let lastT = t0;
    let lastDraw = Number.NEGATIVE_INFINITY;
    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      if (document.hidden) return;
      const dt = Math.min(MAX_DT, (now - lastT) / 1000);
      lastT = now;
      const idle = now - lastMove > IDLE_MS;
      stepSpring(sx, idle ? 0 : tx, PARALLAX.k, PARALLAX.d, dt);
      stepSpring(sy, idle ? 0 : ty, PARALLAX.k, PARALLAX.d, dt);
      if (px !== NO_POINTER) {
        stepSpring(lx, px, LIGHT.k, LIGHT.d, dt);
        stepSpring(ly, py, LIGHT.k, LIGHT.d, dt);
      }
      // the plates belong to the intro's keyframes until it ends, then to the pointer
      if (phaseRef.current !== 'intro') placePlates();
      if (now - lastDraw > TERRAIN_FRAME_MS) {
        draw(now - t0);
        lastDraw = now;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const visibility = () => {
      if (document.hidden || raf) return;
      lastT = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const pointer = window.matchMedia(FINE_POINTER).matches;
    const move = (e: PointerEvent) => {
      [tx, ty] = pointerTarget(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      // the first move starts the light under the pointer
      if (px === NO_POINTER) {
        lx.x = e.clientX;
        ly.x = e.clientY;
      }
      px = e.clientX;
      py = e.clientY;
      lastMove = performance.now();
    };
    const leave = () => {
      tx = 0;
      ty = 0;
      px = NO_POINTER;
      py = NO_POINTER;
      lx.x = NO_POINTER;
      ly.x = NO_POINTER;
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', size);
    if (pointer) {
      window.addEventListener('pointermove', move, { passive: true });
      document.documentElement.addEventListener('pointerleave', leave);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', size);
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
      // free the backing store at once rather than when the element is collected
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [reduce]);

  const org = orgLine(settings, t('gate.thisComputer'));
  const footer = [brand.productName, build.version].filter(Boolean).join(' ');

  return (
    <div
      ref={rootRef}
      className="qg"
      data-surface="dark"
      data-phase={phase}
      data-instant={instant ? '' : undefined}
      data-testid="launch-gate"
    >
      <canvas ref={canvasRef} className="qg-bg" aria-hidden="true" />
      <div className="qg-vignette" aria-hidden="true" />
      <Clock />
      <button
        ref={skipRef}
        type="button"
        className="qg-skip"
        inert={phase !== 'intro'}
        onClick={(e) => {
          // from the keyboard (no click count): carry on to Enter; from the mouse: no ring left
          const keyboard = e.detail === 0;
          skip();
          if (keyboard) enterRef.current?.focus();
          else e.currentTarget.blur();
        }}
      >
        {t('gate.skip')}
      </button>
      <div ref={mainRef} className="qg-main">
        <div className="qg-brand" ref={markRef}>
          <BrandSymbol className="qg-mark" layered label={brand.productName} />
          <div className="qg-wm">
            <BrandWordmark className="qg-wm-svg" decorative />
          </div>
          <p className="qg-tag">{brand.tagline}</p>
        </div>
        <section
          className="qg-entry"
          aria-label={t('gate.region', { product: brand.productName })}
          data-testid="launch-gate-panel"
        >
          <div className="qg-who" data-greeting={greeting.kind}>
            {greeting.kind === 'anonymous' ? (
              <>
                <b className="qg-name">{t('gate.welcome')}</b>
                <span className="qg-org qg-hint">{t('gate.setName')}</span>
              </>
            ) : (
              <>
                <span className="qg-hello">{t('gate.welcomeBack')}</span>
                <b className="qg-name" data-testid="launch-gate-name">
                  {greeting.kind === 'named' ? greeting.name : ' '}
                </b>
              </>
            )}
            <span className="qg-org" data-testid="launch-gate-org">
              {org}
            </span>
          </div>
          <button
            ref={enterRef}
            type="button"
            className="qg-enter"
            aria-keyshortcuts="Enter"
            onClick={enter}
          >
            {t('gate.enter')}
            <kbd aria-hidden="true">↵</kbd>
          </button>
          <div className="qg-status">
            <span className="qg-dot" aria-hidden="true" />
            {t('titlebar.offline')}
            <span className="qg-sep" aria-hidden="true">
              ·
            </span>
            {t(settings.cloudAi ? 'gate.cloudOn' : 'gate.local')}
          </div>
        </section>
      </div>
      <footer className="qg-foot" aria-hidden="true">
        {footer} · {brand.company}
      </footer>
    </div>
  );
}

/**
 * Mount beside `<App />`: renders the gate on the first frame when this start shows it, and
 * nothing once it is dismissed (canvas, timers and listeners go with it).
 */
export function LaunchGate() {
  const [start] = useState(startState);
  const [up, setUp] = useState(start.shown);
  const done = useCallback(() => {
    setUp(false);
  }, []);
  useEffect(() => {
    if (start.shown || start.mode === 'skip') return;
    // Left out by the local copy of the switch: keep that copy true to launch.json (switched back
    // on outside this window), so the next start shows it again.
    void bridge.call('launch:get', {}).then((r) => {
      if (r.ok && r.value.ok) writeLaunchHint(localStore(), gateWanted(r.value.settings));
    });
  }, [start]);
  return up ? <Gate onGone={done} /> : null;
}
