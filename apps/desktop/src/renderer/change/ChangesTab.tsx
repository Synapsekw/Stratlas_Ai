import {
  changeProducers,
  changeStore,
  ChangePanel,
  layersOf,
  type ChangePairContext,
} from '@aio/change';
import { formatDate } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useCaptureIndex } from '../workspace/compare';
import { useSplit } from '../workspace/SplitPanes';
import { openLineUp } from '../lineup/lineUpActions';
import { createChangeActions } from './actions';
import { useChangeProject, useComparedPair } from './useChangeOverlays';

/** The Changes tab of the right panel: the register of the dates being compared. */
export function ChangesTab({ className }: { className?: string }) {
  useChangeProject();
  const project = useWorkspace((s) => s.project);
  const index = useCaptureIndex();
  const split = useSplit();
  const compared = useComparedPair(split);
  const actions = useMemo(() => createChangeActions(), []);
  const captures = useMemo(
    () =>
      (index?.captures ?? []).map((c) => ({
        id: c.id,
        label: `${formatDate(c.date)} · ${c.label}`,
      })),
    [index],
  );
  if (!project || !index) return null;
  const context = (pair: { from: string; to: string }): ChangePairContext => ({
    projectId: project.id,
    manifest: project.manifest,
    from: pair.from,
    to: pair.to,
    layersFrom: layersOf(index, project.manifest.layers, pair.from),
    layersTo: layersOf(index, project.manifest.layers, pair.to),
  });
  /** Run a producer again for the panel's pair; `name` is its id or a change set's producer. */
  const rerun = (name: string) => {
    const pair = changeStore.getState().pair;
    const ctx = pair ? context(pair) : null;
    const producer = changeProducers().find((p) => p.id === name || `change.${p.id}` === name);
    if (!ctx || !producer) {
      // an in-app producer (issues, detections, vectors) is part of the panel's own run
      void changeStore.getState().compute();
      return;
    }
    void producer.run(ctx);
  };
  return (
    <ChangePanel
      className={className}
      captures={captures}
      defaultPair={compared}
      context={context}
      actions={actions}
      onLineUp={(from, to) => {
        // after a saved line-up the refused run starts again by itself
        const refused = changeStore.getState().misaligned?.producer;
        openLineUp(
          from,
          to,
          refused
            ? () => {
                rerun(refused);
              }
            : undefined,
        );
      }}
      onRerun={rerun}
    />
  );
}
