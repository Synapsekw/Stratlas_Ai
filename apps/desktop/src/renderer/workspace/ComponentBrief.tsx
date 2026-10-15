import type { ComponentInfo, EngineStage } from '@aio/engine';
import { useT } from '@aio/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './components.css';

/** Room kept between the brief and the window edge, px. */
const EDGE = 8;
/** The brief sits this far below and right of the pointer, px. */
const OFFSET = 16;
const MAX_SENTENCE = 140;

/** The first sentence of a description, cut at a word when it runs long. */
export function firstSentence(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/s.exec(text.trim());
  const s = (m?.[0] ?? text).trim();
  if (s.length <= MAX_SENTENCE) return s;
  const cut = s.slice(0, MAX_SENTENCE);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Keep a box of `size` beside `at` and inside `0..limit`, flipping to the other side if needed. */
function place(at: number, size: number, limit: number): number {
  let v = at + OFFSET;
  if (v + size > limit - EDGE) v = at - OFFSET - size;
  return Math.max(EDGE, Math.min(v, limit - EDGE - size));
}

/**
 * The hover brief of an engineering component: name, category, the first sentence of its
 * description and how to select it, beside the pointer (`x`, `y` in client pixels) and inside the
 * window.
 */
export function ComponentBrief({ info, x, y }: { info: ComponentInfo; x: number; y: number }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + OFFSET, top: y + OFFSET });
  useLayoutEffect(() => {
    const el = ref.current;
    const r = el?.getBoundingClientRect();
    const w = r?.width ?? 0;
    const h = r?.height ?? 0;
    setPos({ left: place(x, w, window.innerWidth), top: place(y, h, window.innerHeight) });
  }, [x, y, info]);
  const line = info.description ? firstSentence(info.description) : '';
  return (
    <div
      ref={ref}
      className="comp-brief"
      role="tooltip"
      data-testid="component-brief"
      style={{ left: `${String(pos.left)}px`, top: `${String(pos.top)}px` }}
    >
      <b>{info.name}</b>
      {info.category && <span className="cb-cat">{info.category}</span>}
      {line && <p>{line}</p>}
      <span className="cb-hint">{t('component.brief.select')}</span>
    </div>
  );
}

/**
 * The brief for whatever engineering component the pointer is over in a 3D view: follows the
 * stage's hover (mouse only; touch selects with a tap and reads the card).
 */
export function StageComponentBrief({ engine }: { engine: EngineStage | null }) {
  const [hover, setHover] = useState<ComponentInfo | null>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!engine) return;
    const canvas = engine.renderer.domElement;
    const move = (e: PointerEvent) => {
      setAt({ x: e.clientX, y: e.clientY });
    };
    const leave = () => {
      setHover(null);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    const off = engine.onPick((e) => {
      if (e.kind === 'hover') setHover(e.pick?.component ?? null);
    });
    return () => {
      off();
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      setHover(null);
    };
  }, [engine]);
  return hover ? <ComponentBrief info={hover} x={at.x} y={at.y} /> : null;
}
