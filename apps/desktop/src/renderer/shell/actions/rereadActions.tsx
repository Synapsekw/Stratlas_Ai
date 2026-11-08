import type { IpcResponse } from '@aio/schema';
import { defineAction, everyLayer, registerActions, t, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { createRoot } from 'react-dom/client';
import { loadOrientation } from '../../builder/orientationFile';
import { toasts } from '../../exports/exports';
import { bridge } from '../../shell';
import { ConfirmDialog } from '../ConfirmDialog';
import { editBlocked } from './reasons';

/*
 * Re-read photo positions (photo position edit, 21 Oct 2026): on a photos dataset, read heights
 * and view directions again from the photo files with the fixed reader. A dry run first gives the
 * counts and whether processing refined the photos; the person confirms; a folder of originals is
 * asked for when the review copies carry no metadata.
 */

type Done = Extract<IpcResponse<'builder:rereadPhotos'>, { ok: true }>;

/** The toast line of a re-read: photos read, hand moves kept, thermal twins, files not found. */
export function rereadSummary(r: Pick<Done, 'reread' | 'kept' | 'twins' | 'notFound'>): string {
  return [
    t('position.say.reread', { count: r.reread }),
    ...(r.kept > 0 ? [t('position.say.rereadKept', { count: r.kept })] : []),
    ...(r.twins > 0 ? [t('position.say.twins', { count: r.twins })] : []),
    ...(r.notFound > 0 ? [t('position.say.rereadMissing', { count: r.notFound })] : []),
  ].join(' ');
}

/** How many thermal photos a re-read placed at their visual twins. */
export const twinCount = (r: Pick<Done, 'twins'>): number => r.twins;

/** The asks of the flow, swapped in tests. */
export interface RereadAsk {
  confirm(text: string): Promise<boolean>;
  pickFolder(title: string): Promise<string | null>;
}

function RereadConfirm({ text, done }: { text: string; done: (yes: boolean) => void }) {
  const tr = useT();
  return (
    <ConfirmDialog
      title={tr('position.reread')}
      yes={tr('position.reread')}
      testId="reread-confirm"
      onConfirm={() => {
        done(true);
      }}
      onCancel={() => {
        done(false);
      }}
    >
      <p id="reread-text" style={{ margin: 0 }}>
        {text}
      </p>
    </ConfirmDialog>
  );
}

/** The confirm box of the window, mounted for one answer. */
function askConfirm(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const done = (yes: boolean) => {
      root.unmount();
      host.remove();
      resolve(yes);
    };
    root.render(<RereadConfirm text={text} done={done} />);
  });
}

async function pickFolder(title: string): Promise<string | null> {
  const r = await bridge.call('dialog:openFolder', { title });
  return r.ok ? r.value.path : null;
}

const WINDOW_ASK: RereadAsk = { confirm: askConfirm, pickFolder };

let seq = 0;

/**
 * Re-read one photos dataset of the open project: dry run, folder of originals when needed,
 * confirm, then the re-read; the project and its corrections are reloaded and a toast says what
 * happened. Resolves when the flow has ended (cancelled included).
 */
export async function rereadPhotos(layerId: string, ask: RereadAsk = WINDOW_ASK): Promise<void> {
  const p = workspace.getState().project;
  if (!p) return;
  seq += 1;
  const id = `reread-${String(seq)}`;
  const fail = (text: string) => {
    const ts = toasts.getState();
    ts.start(id, t('position.reread'));
    ts.finish(id, 'error', text);
  };
  const call = async (folder: string | undefined, dryRun: boolean) => {
    const r = await bridge.call('builder:rereadPhotos', {
      projectId: p.id,
      layerId,
      ...(folder !== undefined ? { folder } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    });
    return r.ok ? r.value : { ok: false as const, error: r.error };
  };
  let folder: string | undefined;
  let dry = await call(undefined, true);
  if (!dry.ok && 'needsFolder' in dry) {
    const picked = await ask.pickFolder(t('position.reread.pickFolder', { count: dry.missing }));
    if (picked === null) return;
    folder = picked;
    dry = await call(folder, true);
  }
  if (!dry.ok) {
    fail('error' in dry ? dry.error : t('position.reread.pickFolder', { count: dry.missing }));
    return;
  }
  const text = [
    t('position.reread.confirm'),
    ...(dry.refined ? [t('position.reread.refined')] : []),
  ].join(' ');
  if (!(await ask.confirm(text))) return;
  const r = await call(folder, false);
  if (!r.ok) {
    fail('error' in r ? r.error : t('position.reread.pickFolder', { count: r.missing }));
    return;
  }
  const ws = workspace.getState();
  if (ws.project?.id === p.id) {
    ws.replaceManifest(r.manifest);
    void loadOrientation();
  }
  const ts = toasts.getState();
  ts.start(id, t('position.reread'));
  ts.finish(id, 'done', rereadSummary(r));
}

/** Register "Re-read photo positions" on photos datasets. */
export function registerRereadActions(): void {
  registerActions([
    defineAction<'layers'>({
      id: 'layers.rereadPhotos',
      label: 'position.reread',
      section: 'edit',
      targets: ['layers'],
      appliesTo: (target, ctx) => everyLayer(target, ctx, (l) => l.kind === 'photos'),
      disabled: (_t, ctx) => editBlocked(ctx),
      run: async (target) => {
        const [layerId] = target.layerIds;
        if (layerId !== undefined) await rereadPhotos(layerId);
      },
    }),
  ]);
}
