import '@cesium/engine/Source/Widget/CesiumWidget.css';
import type { CesiumWidget } from '@cesium/engine';
import { useEffect, useRef } from 'react';
import {
  configureCesiumBase,
  createOfflineWidget,
  naturalEarthLayer,
  type GlobeTier,
} from './setup';

export interface GlobeViewProps {
  /** Where the app serves its copy of Cesium's workers and assets (`<renderer>/cesium/`). */
  baseUrl: string;
  tier: GlobeTier;
  onReady?: (widget: CesiumWidget) => void;
}

/** The CesiumWidget in a React element; destroyed (with its WebGL context) on unmount. */
export function GlobeView({ baseUrl, tier, onReady }: GlobeViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    let widget: CesiumWidget | undefined;
    configureCesiumBase(baseUrl);
    void naturalEarthLayer().then((baseLayer) => {
      if (!live) return;
      widget = createOfflineWidget(el, { tier, baseLayer });
      Object.assign(el, { __aioGlobe: widget });
      onReady?.(widget);
    });
    return () => {
      live = false;
      Reflect.deleteProperty(el, '__aioGlobe');
      widget?.destroy();
    };
    // the widget is built once per mount; the tier is read at creation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);
  return <div ref={ref} className="aio-globe" data-testid="globe-canvas" />;
}
