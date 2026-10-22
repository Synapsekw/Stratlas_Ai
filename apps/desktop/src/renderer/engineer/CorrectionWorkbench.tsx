import { getActiveStage } from '@aio/engine';
import { pinTargetRefusal } from '@aio/modelling';
import type {
  ModelCorrection,
  ModelCorrectionInput,
  ProcModel,
  ProjectManifest,
} from '@aio/schema';
import { useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Matrix4 } from 'three';
import { agentTask, appAgentSession, setAgentTask } from '../agent/session';
import { agentPane } from '../agent/agentPaneStore';
import { bridge, shell, useShell } from '../shell';
import { showBench } from '../workspace/workbench/followTool';
import { CorrectionPanel } from './CorrectionPanel';
import type { CorrectionPanelProps, CorrectionTargetView } from './CorrectionPanel.types';
import { correctionSendBlocker, type CorrectionBlocker } from './correctionBlockers';
import { armCorrectionPin, attachCorrectionComparison, showCorrectionPin } from './correctionScene';
import {
  correctionDraftKey,
  useCorrectionDraft,
  type CorrectionActionKind,
} from './correctionDraft';
import { afterDecision, allowCloudKinds, saveThenSend, sendCorrections } from './correctionSend';
import { requiredKinds } from './correctionSession';
import { engineerHost, modelCorrections, useHost, useRun } from './host';
import { prepareCorrectionSubmission } from './correctionTools';

const allowDeps = {
  call: bridge.call.bind(bridge),
  project: () => workspace.getState().project,
  replaceManifest: (projectId: string, manifest: ProjectManifest) => {
    const ws = workspace.getState();
    if (ws.project?.id === projectId) ws.replaceManifest(manifest);
  },
};

/** App wiring only; CorrectionPanel remains portable to the sidebar workbench. */
export function CorrectionWorkbench({ layerId }: { layerId: string }) {
  const t = useT();
  const model = useRun((s) => s.model, null);
  const run = useRun((s) => s.run, null);
  const evidence = useRun((s) => s.evidence, null);
  const busy = useRun((s) => s.busy, false);
  const selected = useHost((s) => s.selected);
  const project = useWorkspace((s) => s.project);
  const hiddenLayers = useWorkspace((s) => s.hidden);
  const draft = useCorrectionDraft(correctionDraftKey(project?.id, run?.id));
  const {
    pin,
    setPin,
    pinRadiusM,
    setPinRadiusM,
    requestId,
    setRequestId,
    view,
    setView,
    error,
    setError,
    working,
  } = draft;
  const agent = appAgentSession();
  const agentState = useSyncExternalStore(agent.subscribe, agent.getState);
  const readOnly = useShell((s) => s.pkg !== null);
  useEffect(() => {
    // the route and project policy are checked on mount and focus, never inside an action
    const check = () => {
      setAgentTask('build');
      void agent.refresh();
    };
    const before = agentTask();
    check();
    globalThis.addEventListener('focus', check);
    return () => {
      globalThis.removeEventListener('focus', check);
      setAgentTask(before);
    };
  }, [agent]);
  const [pinMode, setPinMode] = useState(false);
  const [candidate, setCandidate] = useState<{ id: string; before: ProcModel; after: ProcModel }>();
  const [stale, setStale] = useState<string>();
  const comparison = useRef<ReturnType<typeof attachCorrectionComparison> | null>(null);
  const layer = project?.manifest.layers.find((l) => l.id === layerId);
  const transform = layer && 'transform' in layer ? layer.transform : undefined;
  const matrixKey = JSON.stringify(transform ?? new Matrix4().elements);
  const sourceKey = JSON.stringify([
    layerId,
    ...(run?.setup.sources.clouds ?? []).map((s) => s.layer),
    ...(run?.setup.sources.meshes ?? []).map((s) => s.layer),
  ]);
  const requests = run?.corrections ?? [];
  const request = requests.find((r) => r.id === requestId);

  useEffect(() => {
    if (!pinMode || !layer) return;
    const stage = getActiveStage();
    if (!stage) return;
    const picker = armCorrectionPin(stage, {
      modelToProject: JSON.parse(matrixKey) as number[],
      allowedLayerIds: JSON.parse(sourceKey) as string[],
      onPin: (picked) => {
        setPin(picked);
        setPinMode(false);
        setError(undefined);
      },
      onCancel: () => {
        setPinMode(false);
      },
      onMiss: setError,
    });
    return () => {
      picker.dispose();
    };
  }, [pinMode, matrixKey, sourceKey, layer, setPin, setError]);

  const point =
    pin?.point ?? (request?.target.kind === 'pin' ? request.target.projectPosition : undefined);
  const pointKey = JSON.stringify(point ?? null);
  useEffect(() => {
    const stage = getActiveStage();
    if (!stage || pointKey === 'null') return;
    const marker = showCorrectionPin(stage, JSON.parse(pointKey) as [number, number, number]);
    return () => {
      marker.dispose();
    };
  }, [pointKey]);

  useEffect(() => {
    if (request?.status !== 'proposed' || !model) return;
    let cancelled = false;
    void modelCorrections.candidate(request.id).then(
      (after) => {
        if (!cancelled) {
          setCandidate({ id: request.id, before: model, after });
          setStale(undefined);
          setError(undefined);
        }
      },
      (e: unknown) => {
        if (!cancelled) {
          setStale(request.id);
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request, model, setError]);

  const ready =
    !!candidate &&
    candidate.id === request?.id &&
    candidate.before === model &&
    request.status === 'proposed' &&
    stale !== request.id;
  useEffect(() => {
    const stage = getActiveStage();
    if (!ready || !stage) return;
    const shown = workspace.getState().isLayerVisible(layerId);
    const ids =
      request.proposal?.patch.map((p) => (p.op === 'remove' ? p.id : p.assembly.id)) ?? [];
    try {
      const overlay = attachCorrectionComparison(stage, {
        before: candidate.before,
        after: candidate.after,
        modelToProject: JSON.parse(matrixKey) as number[],
        changedIds: ids,
        pickable: true,
        layerId,
      });
      comparison.current = overlay;
      workspace.getState().setLayerVisible(layerId, false);
      return () => {
        overlay.dispose();
        comparison.current = null;
        workspace.getState().setLayerVisible(layerId, shown);
      };
    } catch (e) {
      queueMicrotask(() => {
        setError(e instanceof Error ? e.message : String(e));
        setStale(candidate.id);
      });
    }
  }, [ready, candidate, layerId, matrixKey, request, setError]);
  useEffect(() => {
    comparison.current?.show(view);
  }, [view, ready, candidate]);

  if (!model || !run) return null;
  const targetView = (r: ModelCorrection): CorrectionTargetView => {
    const target = r.target;
    if (target.kind === 'model') return { kind: 'model' };
    return target.kind === 'part'
      ? {
          ...target,
          label: model.assemblies.find((a) => a.id === target.partId)?.name ?? target.partId,
        }
      : {
          kind: 'pin',
          position: target.projectPosition,
          layerId: target.sourceLayerId,
          radiusM: target.radiusM,
        };
  };
  /** One action at a time; only this action's token can clear the lock. */
  const act = async <T,>(
    kind: CorrectionActionKind,
    action: () => Promise<T>,
    report = true,
  ): Promise<T> => {
    const token = draft.begin(kind);
    if (token === false) throw new Error(t('eng.correction.error.running'));
    try {
      return await action();
    } catch (e) {
      if (report) setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      draft.end(token);
    }
  };
  /** Hands saved, open requests to the AI. The blocker has already ruled out a busy or off route. */
  const sendToAi = (ids: string[], report = true) =>
    act(
      'sending',
      () =>
        sendCorrections({
          ids,
          prepare: prepareCorrectionSubmission,
          send: async (text) => {
            shell.getState().setRight(false);
            agentPane.getState().setMode('normal');
            showBench('review');
            setAgentTask('build');
            await agent.send(text);
          },
        }),
      report,
    );
  const openIds = (except?: string) =>
    requests.filter((r) => r.status === 'open' && r.id !== except).map((r) => r.id);
  const pinRefusal = pinTargetRefusal(model);
  const manifest = project?.manifest;
  const evidenceKind = (id: string): 'photo' | 'cloud' =>
    evidence?.images.find((x) => x.id === id)?.kind === 'photo' ? 'photo' : 'cloud';
  const composer = draft.composer;
  const draftRef: Pick<ModelCorrection, 'target' | 'evidence'> = {
    target:
      composer.targetMode === 'pin' && pin && !pinRefusal
        ? {
            kind: 'pin',
            position: pin.modelPoint,
            projectPosition: pin.point,
            radiusM: pinRadiusM,
            sourceLayerId: pin.layerId,
          }
        : { kind: 'model' },
    evidence: composer.evidenceIds.map((id) => ({ kind: evidenceKind(id), ref: id })),
  };
  const blocked: CorrectionBlocker | null = correctionSendBlocker({
    readOnly,
    availability: agentState.availability,
    agentBusy: agentState.busy,
    preview: !!agentState.preview,
    required: requiredKinds(run, model, [...requests.filter((r) => r.status === 'open'), draftRef]),
    allowed: {
      photos: manifest?.aiCloudPhotos === true,
      scans: manifest?.aiCloudScans === true,
      drawings: manifest?.aiCloudDrawings === true,
    },
  });
  const blocker: CorrectionPanelProps['blocker'] = !blocked
    ? undefined
    : blocked.kind === 'route'
      ? {
          message: blocked.message,
          fix: {
            label: t('eng.correction.blocker.openSettings'),
            onClick: () => {
              shell.getState().openSettingsPage('ai');
            },
          },
        }
      : blocked.kind === 'permission'
        ? {
            message: t('eng.correction.blocker.permission', {
              kinds: new Intl.ListFormat('en', { type: 'conjunction' }).format(blocked.missing),
            }),
            fix: {
              label: t('eng.ev.allow'),
              onClick: () => {
                allowCloudKinds(blocked.missing, allowDeps).catch((e: unknown) => {
                  setError(e instanceof Error ? e.message : String(e));
                });
              },
            },
          }
        : {
            message: t(
              blocked.kind === 'readOnly'
                ? 'eng.correction.readOnly'
                : blocked.kind === 'checking'
                  ? 'eng.correction.blocker.checking'
                  : 'eng.correction.blocker.conversation',
            ),
          };
  const busyReason = working ? (draft.busyReason ?? 'saving') : busy ? 'modelling' : undefined;
  const scaleProvisional = !model.scale || model.scale.status === 'provisional';
  const focus = (target: CorrectionTargetView) => {
    if (target.kind === 'model') return;
    if (target.kind === 'part')
      workspace.getState().flyTo({
        kind: 'selection',
        selection: { kind: 'asset', id: target.partId, layer: layerId },
      });
    else workspace.getState().flyTo({ kind: 'point', p: target.position, distance: 4 });
  };
  const proposal =
    request?.status === 'proposed' && request.proposal
      ? {
          id: request.id,
          requestId: request.id,
          explanation: request.proposal.explanation,
          stale: stale === request.id,
          changes: request.proposal.patch.map((p) => ({
            partId: p.op === 'remove' ? p.id : p.assembly.id,
            label:
              p.op === 'remove'
                ? (model.assemblies.find((a) => a.id === p.id)?.name ?? p.id)
                : p.assembly.name,
            kind:
              p.op === 'add'
                ? ('added' as const)
                : p.op === 'remove'
                  ? ('removed' as const)
                  : ('changed' as const),
          })),
        }
      : undefined;
  return (
    <CorrectionPanel
      draft={draft.composer}
      onDraftChange={draft.setComposer}
      onDiscardDraft={() => {
        draft.discard();
        setPinMode(false);
      }}
      {...(run.setup.sources.clouds.length || run.setup.sources.meshes.length
        ? {
            sourceVisible: [...run.setup.sources.clouds, ...run.setup.sources.meshes].some(
              (s) => !hiddenLayers[s.layer],
            ),
            onSourceVisibleChange: (visible: boolean) => {
              for (const source of [...run.setup.sources.clouds, ...run.setup.sources.meshes])
                workspace.getState().setLayerVisible(source.layer, visible);
            },
          }
        : {})}
      parts={model.assemblies.map((a) => ({ id: a.id, label: a.name }))}
      {...(selected ? { selectedPartId: selected } : {})}
      {...(pin ? { pin: { position: pin.point, layerId: pin.layerId } } : {})}
      pinMode={pinMode}
      pinRadiusM={pinRadiusM}
      onPinRadiusChange={setPinRadiusM}
      busy={busy || working}
      {...(busyReason ? { busyReason } : {})}
      {...(blocker ? { blocker } : {})}
      {...(composer.targetMode === 'pin' && pinRefusal
        ? { pinNote: t('eng.correction.pinHintOnly') }
        : {})}
      scaleProvisional={scaleProvisional}
      proposalReady={ready}
      view={view}
      {...(error ? { error } : {})}
      {...(requestId ? { selectedRequestId: requestId } : {})}
      {...(proposal ? { proposal } : {})}
      evidenceOptions={(evidence?.images ?? []).map((image) => ({
        id: image.id,
        label: `${image.view} (${image.id})`,
        kind: image.kind,
      }))}
      requests={requests.map((r) => ({
        id: r.id,
        target: targetView(r),
        comment: r.comment,
        evidenceIds: r.evidence?.map((s) => s.ref) ?? [],
        status: r.id === stale ? 'stale' : r.status,
        replies: r.replies.map((v, i) => ({
          id: `${r.id}-${String(i)}`,
          text: v.comment,
          author: t('eng.correction.reviewer'),
        })),
      }))}
      onSelectPart={(id) => {
        engineerHost.setState({ selected: id });
        workspace.getState().select({ kind: 'asset', id, layer: layerId });
      }}
      onPinModeChange={(enabled) => {
        setRequestId(undefined);
        setPinMode(enabled);
        setError(undefined);
      }}
      onClearPin={() => {
        setPin(undefined);
      }}
      onSubmit={({ target = { kind: 'model' }, comment, evidenceIds, send }) =>
        saveThenSend({
          save: () =>
            act('saving', async () => {
              if (target.kind === 'pin' && !pin && !pinRefusal)
                throw new Error(t('eng.correction.error.pin'));
              const camera = getActiveStage()?.saveView();
              // a pin on a model without known placement or scale is kept only as the view hint
              const typed: ModelCorrectionInput['target'] =
                target.kind === 'model' || (target.kind === 'pin' && pinRefusal)
                  ? { kind: 'model' }
                  : target.kind === 'part'
                    ? { kind: 'part', partId: target.partId }
                    : {
                        kind: 'pin',
                        position: pin?.modelPoint ?? target.position,
                        projectPosition: target.position,
                        radiusM: target.radiusM ?? pinRadiusM,
                        sourceLayerId: pin?.layerId ?? layerId,
                      };
              const created = await modelCorrections.create({
                id: `fix-${crypto.randomUUID()}`,
                target: typed,
                comment,
                ...(camera ? { camera: { position: camera.position, target: camera.target } } : {}),
                evidence: evidenceIds.map((id) => ({ kind: evidenceKind(id), ref: id })),
              });
              setRequestId(created.id);
              setPin(undefined);
              setView('before');
              return created.id;
            }),
          ...(send ? { send: (id: string) => sendToAi([id, ...openIds(id)], false) } : {}),
        })
      }
      onSelectRequest={(id) => {
        setRequestId(id);
        setPin(undefined);
        setPinMode(false);
        setView('before');
        const r = requests.find((r) => r.id === id);
        if (r?.camera) getActiveStage()?.restoreView(r.camera, false);
        else if (r) focus(targetView(r));
      }}
      onSend={(ids) => sendToAi(ids, false)}
      onViewChange={setView}
      onFocusTarget={focus}
      onAccept={(id) =>
        act('saving', async () => {
          if (!ready || view !== 'after') throw new Error(t('eng.correction.error.after'));
          await modelCorrections.accept(id);
          afterDecision('accept', { setRequestId, setView });
        })
      }
      onReject={(id) =>
        act('saving', async () => {
          await modelCorrections.reject(id);
          afterDecision('reject', { setRequestId, setView });
        })
      }
      onResend={(id, reply) =>
        saveThenSend({
          save: () =>
            act('saving', async () => {
              // reopens the request as open (trimming old rounds), with the reply when given
              await modelCorrections.resend(id, reply);
              setView('before');
              return id;
            }),
          send: (saved) => sendToAi([saved], false),
        })
      }
      onReply={(id, text) =>
        act('saving', async () => {
          await modelCorrections.reply(id, text);
          setView('before');
        })
      }
    />
  );
}
