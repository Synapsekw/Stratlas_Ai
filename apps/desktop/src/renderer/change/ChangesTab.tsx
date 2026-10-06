import { ChangePanel, layersOf, type ChangePairContext } from '@aio/change';
import { formatDate } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useCaptureIndex } from '../workspace/compare';
import { useSplit } from '../workspace/SplitPanes';
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
  return (
    <ChangePanel
      className={className}
      captures={captures}
      defaultPair={compared}
      context={context}
      actions={actions}
    />
  );
}
