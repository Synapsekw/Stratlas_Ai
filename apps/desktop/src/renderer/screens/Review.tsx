import { Icon } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { answerShimSave, legacyLayers, readShimSave } from '../legacy';
import { bridge, shell } from '../shell';
import { NoProject } from './NoProject';

/**
 * The original offline viewer of a project, full stage, in a sandboxed iframe served from
 * aio://project/<id>/legacy/. The protocol injects the platform shims (main/protocol/shim.ts);
 * this screen answers their save requests with the native save dialog.
 *
 * Sandbox: scripts and its own aio: origin (the viewers read data/*.js, tiles and localStorage),
 * downloads (`<a download>`), and popups (the report PDF opens in a Stratlas viewer window).
 */
export function ReviewScreen() {
  const project = useWorkspace((s) => s.project);
  const layers = useMemo(() => legacyLayers(project?.manifest), [project]);
  const [chosen, setChosen] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || e.source !== target) return;
      const save = readShimSave(e.data);
      const port = e.ports[0];
      if (!save || !port) return;
      void answerShimSave(save, bridge).then((reply) => {
        port.postMessage(reply);
        port.close();
      });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  if (!project) return <NoProject view="Original review" />;
  const layer = layers.find((l) => l.id === chosen) ?? layers[0];
  let src: string | null = null;
  let problem: string | null = null;
  if (!layer) problem = 'This project has no original review.';
  else {
    try {
      src = assetUrl(project.id, layer.entry);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <section className="screen review" aria-label="Original review">
      <header className="review-h">
        <span className="rv-ic">
          <Icon name="history" size={16} />
        </span>
        <div className="rv-t">
          <b>{project.manifest.name}</b>
          <span>Original review (read-only snapshot)</span>
        </div>
        {layers.length > 1 && (
          <select
            className="rv-pick"
            aria-label="Review"
            value={layer?.id}
            onChange={(e) => {
              setChosen(e.target.value);
            }}
          >
            {layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <span className="rv-spacer" />
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            shell.getState().go('scene');
          }}
        >
          <Icon name="back" size={14} />
          Back to workspace
        </button>
      </header>
      {src ? (
        <iframe
          key={src}
          ref={frame}
          className="review-frame"
          title={`${layer?.name ?? 'Original review'}, original viewer`}
          src={src}
          sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
          allow="clipboard-write"
          data-testid="legacy-frame"
        />
      ) : (
        <div className="review-empty">
          <p className="muted">{problem}</p>
        </div>
      )}
    </section>
  );
}
