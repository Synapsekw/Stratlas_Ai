import { ComponentsSection } from '@aio/modelling';
import { Button, EmptyState, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useShell } from '../shell';
import { useLayerComponents } from '../workspace/ComponentList';
import { Section } from '../workspace/workbench/Section';
import { acceptedCount, acceptRun, useHost, useRun } from './host';
import { useEngineeringReview } from './review';
import { createEngineeringModel, engineerUi } from './ui';
import { ModelLabelsToggle } from './ModelLabelsToggle';
import { CorrectionWorkbench } from './CorrectionWorkbench';

/** Content only: the workbench owns placement, heading, scrolling and closing. */
export function EngineeringReview() {
  const t = useT();
  const review = useEngineeringReview(null);
  const run = useRun((s) => s.run, null);
  const draft = useRun((s) => s.draftLayer, null);
  const acceptedLayer = useRun((s) => s.layer, null);
  const busy = useRun((s) => s.busy, false);
  const error = useHost((s) => s.error);
  const hidden = useWorkspace((s) => s.hidden);
  const projectId = useWorkspace((s) => s.project?.id);
  const labelMode = useShell((s) => s.labelMode);
  const setLabelMode = useShell((s) => s.setLabelMode);
  const corrections = useStore(engineerUi, (s) => s.reviewMode === 'corrections');
  const layer = acceptedLayer ?? draft;
  const components = useLayerComponents(layer ?? '');
  const ready = components.length > 0;
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sceneKey = `${projectId ?? ''}:${run?.id ?? ''}:${layer ?? ''}`;
  const waitKey = `${sceneKey}:${String(attempt)}`;
  const waitExpired = expiredKey === waitKey && !busy;
  useEffect(() => {
    if (!layer || ready || busy) return;
    const timer = setTimeout(() => {
      setExpiredKey(waitKey);
    }, 30_000);
    return () => {
      clearTimeout(timer);
    };
  }, [layer, ready, busy, waitKey]);
  const sourceIds = [
    ...(run?.setup.sources.clouds ?? []),
    ...(run?.setup.sources.meshes ?? []),
  ].map((s) => s.layer);
  const sourceKey = sourceIds.join('\n');
  useEffect(() => {
    if (!layer) return;
    const ui = engineerUi.getState();
    const entering = ui.framedReview !== sceneKey;
    const loaded = ready && ui.readyReview !== sceneKey;
    const ws = workspace.getState();
    if (entering) {
      engineerUi.setState({ framedReview: sceneKey });
      ws.applyVisibility(
        [layer],
        sourceKey ? sourceKey.split('\n').filter((id) => id !== layer) : [],
      );
    }
    // A loading scene can consume the first request before its model is ready. Reframe once
    // when it loads, but preserve the camera and overlay when moving tabs or opening the drawer.
    if (loaded) engineerUi.setState({ readyReview: sceneKey });
    if (entering || loaded)
      ws.flyTo({ kind: 'selection', selection: { kind: 'layer', id: layer, layer } });
  }, [layer, sceneKey, sourceKey, ready]);
  if (!review || !run)
    return (
      <EmptyState
        icon="box"
        title={t('eng.review.empty')}
        body={t('eng.review.emptyBody')}
        action={
          <Button
            onClick={() => {
              createEngineeringModel();
            }}
          >
            {t('eng.review.start')}
          </Button>
        }
      />
    );
  const accepted = acceptedCount(review.model);
  const modelShown = !!layer && !hidden[layer];
  const cloudShown = sourceIds.some((id) => !hidden[id]);
  const mode = modelShown ? (cloudShown ? 'overlay' : 'model') : 'cloud';
  const setView = (next: 'model' | 'cloud' | 'overlay') => {
    if (!layer) return;
    workspace
      .getState()
      .applyVisibility(
        [...(next !== 'cloud' ? [layer] : []), ...(next !== 'model' ? sourceIds : [])],
        [...(next === 'cloud' ? [layer] : []), ...(next === 'model' ? sourceIds : [])],
      );
  };
  const fit = () => {
    if (!layer) return;
    workspace
      .getState()
      .flyTo({ kind: 'selection', selection: { kind: 'layer', id: layer, layer } });
  };
  return (
    <section
      className="eng-model-review"
      data-testid="eng-model-review"
      aria-label={t('eng.review.title')}
    >
      <Section id="model" bench="review" title={t('eng.review.model')} defaultOpen>
        <div className="wb-controls">
          <b>{review.model.name}</b>
          <p className="wb-note" role="status">
            {ready
              ? t('eng.review.selectHint')
              : waitExpired
                ? t('eng.review.unavailable')
                : t('eng.review.loading')}
          </p>
          {!ready && waitExpired && !acceptedLayer && (
            <Button
              data-testid="eng-preview-retry"
              disabled={busy}
              onClick={() => {
                setAttempt((n) => n + 1);
                review.panel.onRebuild();
              }}
            >
              {t('eng.review.retry')}
            </Button>
          )}
          {error && (
            <p className="eng-bad" role="alert">
              {error}
            </p>
          )}
          {!corrections && (
            <div className="eng-review-toolbar" role="group" aria-label={t('eng.run.views')}>
              {(['model', 'cloud', 'overlay'] as const).map((view) => (
                <Button
                  key={view}
                  data-testid={`eng-view-${view}`}
                  pressed={mode === view}
                  disabled={!layer || (view !== 'model' && sourceIds.length === 0)}
                  onClick={() => {
                    setView(view);
                  }}
                >
                  {t(`eng.review.view.${view}`)}
                </Button>
              ))}
            </div>
          )}
          <div className="eng-review-toolbar">
            <Button variant="quiet" disabled={!layer} onClick={fit}>
              {t('eng.review.fit')}
            </Button>
            <ModelLabelsToggle
              on={labelMode !== 'off'}
              onChange={(on) => {
                setLabelMode(on ? 'all' : 'off');
              }}
            />
            <Button
              variant="quiet"
              data-testid="eng-review-progress"
              onClick={() => {
                engineerUi.getState().show();
              }}
            >
              {t('eng.review.progress')}
            </Button>
          </div>
        </div>
      </Section>
      <Section id="parts" bench="review" title={t('eng.review.details')} defaultOpen>
        <div className="wb-controls">
          <div className="eng-review-toolbar" role="group" aria-label={t('eng.review.mode')}>
            <Button
              pressed={!corrections}
              onClick={() => {
                engineerUi.setState({ reviewMode: 'components' });
              }}
            >
              {t('eng.review.components')}
            </Button>
            <Button
              pressed={corrections}
              disabled={!ready}
              onClick={() => {
                engineerUi.setState({ reviewMode: 'corrections' });
              }}
            >
              {t('eng.review.corrections')}
            </Button>
          </div>
          {corrections && layer ? (
            <CorrectionWorkbench key={`${projectId ?? ''}:${run.id}`} layerId={layer} />
          ) : (
            <ComponentsSection
              showVisibility={false}
              selectionFirst
              model={review.model}
              panel={{ ...review.panel, locked: review.panel.locked === true || !ready }}
            />
          )}
          {!corrections &&
            (acceptedLayer ? (
              <span role="status">{t('eng.run.accepted')}</span>
            ) : (
              <Button
                variant="primary"
                data-testid="eng-add-reviewed"
                disabled={busy || accepted === 0 || !ready}
                onClick={() => void acceptRun()}
              >
                {t('eng.review.add', { count: accepted })}
              </Button>
            ))}
        </div>
      </Section>
    </section>
  );
}
