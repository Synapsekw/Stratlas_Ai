import { changeStore, ChangePanel, layersOf, type ChangePairContext } from '@aio/change';
import type { ChangeSet } from '@aio/schema';
import { formatDate, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useCaptureIndex } from '../workspace/compare';
import { useSplit } from '../workspace/SplitPanes';
import { openLineUp } from '../lineup/lineUpActions';
import { rerunProducer, rerunScoped } from './rerun';
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
  /** Run a producer again for the panel's pair; the error comes back for the panel to show. */
  const rerun = (name: string, set?: ChangeSet): Promise<string | null> => {
    // an area's set replays the params it ran with, never a whole-map run
    if (set?.scope)
      return set.run?.params
        ? rerunScoped(set.producer, set.run.params)
        : Promise.resolve(t('lineUp.rerun.unavailable'));
    const pair = changeStore.getState().pair;
    return rerunProducer(name, pair ? context(pair) : null);
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
        const mis = changeStore.getState().misaligned;
        const refused = mis?.producer;
        openLineUp(
          from,
          to,
          refused
            ? () => {
                const run = mis.params ? rerunScoped(refused, mis.params) : rerun(refused);
                void run.then((error) => {
                  if (error) changeStore.getState().setError(error);
                });
              }
            : undefined,
        );
      }}
      onRerun={rerun}
    />
  );
}
