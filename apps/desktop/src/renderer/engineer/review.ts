import { getActiveStage } from '@aio/engine';
import type { ComponentsPanel } from '@aio/modelling';
import type { ProcModel } from '@aio/schema';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect } from 'react';
import {
  addComponent,
  engineerHost,
  rebuildWith,
  setStatus,
  useHost,
  useRun,
  type HostState,
} from './host';
import { buildComponentsPanel, rebuildFor } from './reviewPanel';

/**
 * The review of the open engineering run for the Model builder: the run's model and the
 * Components panel wired to the run (values and removals rebuild through the assembler, status
 * and additions are written to the model, hiding is a view of the draft layer, thumbnails come
 * from the run's evidence images, focus flies to the component). Null without a run model.
 */
export function useEngineeringReview(
  shown: ProcModel | null,
): { model: ProcModel; panel: ComponentsPanel } | null {
  const host = useHost((s) => s);
  const runModel = useRun((s) => s.model, null);
  const run = useRun((s) => s.run, null);
  const busy = useRun((s) => s.busy, false);
  const draftLayer = useRun((s) => s.draftLayer, null);
  const state = useRun((s) => s, null);
  const hiddenLayers = useWorkspace((s) => s.hidden);
  const selected = host.selected;
  const engineering = runModel !== null && (shown === null || shown.id === runModel.id);

  // the evidence thumbnails of the selected component, read once each
  useEffect(() => {
    if (!engineering || !selected || !run || !host.ipc) return;
    const a = runModel.assemblies.find((x) => x.id === selected);
    const ipc = host.ipc;
    for (const s of a?.sources ?? []) {
      if (!s.ref.startsWith('img-') || engineerHost.getState().thumbnails[s.ref]) continue;
      void ipc.evidenceImage(run.id, s.ref).then(
        (url) => {
          engineerHost.setState((h: HostState) => ({
            thumbnails: { ...h.thumbnails, [s.ref]: url },
          }));
        },
        () => undefined,
      );
    }
  }, [engineering, selected, run, runModel, host.ipc]);

  if (!engineering || !state) return null;
  const sources = run
    ? [...run.setup.sources.clouds, ...run.setup.sources.meshes].map((s) => s.layer)
    : [];
  const panel = buildComponentsPanel(
    state,
    {
      selected,
      hidden: host.hidden,
      sourceVisible: sources.some((id) => !hiddenLayers[id]),
      modelVisible: draftLayer !== null && !hiddenLayers[draftLayer],
      stale: host.stale,
      thumbnails: host.thumbnails,
      locked: busy,
    },
    {
      onSelect: (id) => {
        engineerHost.setState({ selected: id });
      },
      onToggle: (id) => {
        const was = engineerHost.getState().hidden;
        const hide = !was.includes(id);
        engineerHost.setState({ hidden: hide ? [...was, id] : was.filter((x) => x !== id) });
        if (draftLayer) getActiveStage()?.setNodeVisible(draftLayer, id, !hide);
      },
      onStatus: (ids, status) => void setStatus(ids, status),
      onRemove: (id) => void rebuildWith(rebuildFor(runModel, { remove: id })),
      onAdd: (kind) => void addComponent(kind),
      onField: (id, key, value) => void rebuildWith(rebuildFor(runModel, { id, key, value })),
      onFocus: (id) => {
        if (!draftLayer) return;
        const selection = { kind: 'asset' as const, id, layer: draftLayer };
        workspace.getState().select(selection);
        workspace.getState().flyTo({ kind: 'selection', selection });
      },
      onSourceVisible: (v) => {
        for (const id of sources) workspace.getState().setLayerVisible(id, v);
      },
      onModelVisible: (v) => {
        if (draftLayer) workspace.getState().setLayerVisible(draftLayer, v);
      },
      onRebuild: () => void rebuildWith(state.user),
    },
  );
  return { model: runModel, panel };
}
