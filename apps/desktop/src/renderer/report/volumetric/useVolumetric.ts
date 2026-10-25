// The volumetric report editor's state (spec section 6): reads the saved edits
// (`report:readText`), asks main for the model once per compared date and data fingerprint
// (`report:volumetricModel`), resolves the texts against the generated defaults, and saves every
// edit after a short pause and on leaving the editor (`report:writeText`). A package is read only:
// it shows its saved edits and never writes.
import type { VolumetricModel, VolumetricT } from '@aio/project/export';
import type { ReportPageId, ReportTextFile, VolumetricTextId } from '@aio/schema';
import { t } from '@aio/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authorName } from '../../author';
import { reportIfChangedOnDisk, useDiskChanged } from '../../diskChanged';
import { bridge } from '../../shell';
import {
  editPileNote,
  editText,
  generatedTexts,
  pagesOf,
  pileNotesOf,
  previewModel,
  recordGenerated,
  resetText,
  resolveTexts,
  SAVE_DELAY_MS,
  setCompareWith as withCompareWith,
  setPage as withPage,
  TEXT_IDS,
  type ResolvedTexts,
  type Texts,
} from './editorModel';

export interface VolumetricOptions {
  projectId: string | null;
  /** A fingerprint of the figures and pictures; a new one fetches the model again. */
  dataKey: string;
  /** The project's customer (`manifest.customer`), the Prepared for default. */
  customer: string | null | undefined;
  /** Settings, Report branding, company name: the Prepared by default. */
  companyName: string | null | undefined;
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface VolumetricEditor {
  /** The saved edits and the model are both in. */
  ready: boolean;
  /** Why the edits or the model could not be read, else null. */
  error: string | null;
  readOnly: boolean;
  /** The file as edited (null until anything is saved). */
  file: ReportTextFile | null;
  /** The model from main, and the model with the edits on it, for the preview and export. */
  model: VolumetricModel | null;
  preview: VolumetricModel | null;
  texts: ResolvedTexts;
  /** The texts generated from the figures (what Reset to generated restores). */
  generated: Texts;
  pileNotes: Record<string, string>;
  pages: Record<ReportPageId, boolean>;
  compareWith: string | null;
  saveState: SaveState;
  saveError: string | null;
  setText: (id: VolumetricTextId, text: string) => void;
  reset: (id: VolumetricTextId) => void;
  setPileNote: (pileId: string, text: string) => void;
  /** Turning off the last page that is on does nothing. */
  setPage: (id: ReportPageId, on: boolean) => void;
  setCompareWith: (captureId: string | null) => void;
  /** Write a pending edit now (before an export). */
  flush: () => Promise<void>;
}

const NO_TEXT = Object.fromEntries(TEXT_IDS.map((id) => [id, ''])) as Texts;
const words = t as VolumetricT;

type ModelState = { key: string; model: VolumetricModel } | { key: string; error: string };

export function useVolumetric(opts: VolumetricOptions): VolumetricEditor {
  const { projectId, dataKey, customer, companyName } = opts;
  const reloads = useDiskChanged((s) => s.reloads);
  const loadKey = projectId === null ? null : `${projectId}#${String(reloads)}`;

  const [file, setFile] = useState<ReportTextFile | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelState, setModelState] = useState<ModelState | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const fileRef = useRef<ReportTextFile | null>(null);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generatedRef = useRef<Texts | null>(null);
  const live = useRef(true);
  const models = useRef(new Map<string, VolumetricModel>());
  const target = useRef<{ projectId: string | null; readOnly: boolean }>({
    projectId,
    readOnly,
  });
  useEffect(() => {
    target.current = { projectId, readOnly };
  }, [projectId, readOnly]);

  // the saved edits, once per project (and again after a reload from disk)
  useEffect(() => {
    if (projectId === null || loadKey === null || loaded === loadKey) return;
    let current = true;
    void bridge.call('report:readText', { projectId, report: 'volumetric' }).then((r) => {
      if (!current) return;
      const res = r.ok ? r.value : { ok: false as const, error: r.error };
      if (res.ok) {
        fileRef.current = res.file;
        setFile(res.file);
        setReadOnly(res.readOnly);
        setLoadError(null);
      } else {
        setLoadError(res.error);
      }
      setLoaded(loadKey);
    });
    return () => {
      current = false;
    };
  }, [projectId, loadKey, loaded]);

  const compareWith = file?.compareWith ?? null;
  const ready = loadKey !== null && loaded === loadKey;
  const modelKey = projectId === null ? null : `${projectId}|${dataKey}|${compareWith ?? ''}`;

  // the model, once per compared date and data fingerprint
  useEffect(() => {
    if (!ready || projectId === null || modelKey === null) return;
    const cached = models.current.get(modelKey);
    if (cached) {
      setModelState({ key: modelKey, model: cached });
      return;
    }
    let current = true;
    void bridge
      .call('report:volumetricModel', {
        projectId,
        ...(compareWith !== null ? { compareWith } : {}),
      })
      .then((r) => {
        if (!current) return;
        const res = r.ok ? r.value : { ok: false as const, error: r.error };
        if (res.ok) {
          const model = res.model as VolumetricModel;
          models.current.set(modelKey, model);
          setModelState({ key: modelKey, model });
        } else setModelState({ key: modelKey, error: res.error });
      });
    return () => {
      current = false;
    };
  }, [ready, projectId, modelKey, compareWith]);

  const shown = modelState?.key === modelKey ? modelState : null;
  const model = shown && 'model' in shown ? shown.model : null;

  const generated = useMemo(
    () =>
      model
        ? generatedTexts(model, {
            title: t('vreport.field.title.default'),
            customer,
            companyName,
            t: words,
          })
        : NO_TEXT,
    [model, customer, companyName],
  );
  useEffect(() => {
    generatedRef.current = model ? generated : null;
  }, [model, generated]);
  const texts = useMemo(() => resolveTexts(file, generated), [file, generated]);
  const preview = useMemo(
    () => (model ? previewModel(model, texts, file) : null),
    [model, texts, file],
  );

  const write = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { projectId: id, readOnly: locked } = target.current;
    const edited = fileRef.current;
    if (!pending.current || locked || id === null || edited === null) return;
    pending.current = false;
    const next = generatedRef.current ? recordGenerated(edited, generatedRef.current) : edited;
    if (live.current) setSaveState('saving');
    const r = await bridge.call('report:writeText', {
      projectId: id,
      report: 'volumetric',
      file: next,
    });
    const res = r.ok ? r.value : { ok: false, error: r.error };
    if (!res.ok) {
      reportIfChangedOnDisk(res.error);
      if (live.current) {
        setSaveState('error');
        setSaveError(res.error ?? '');
      }
      return;
    }
    if (fileRef.current === edited && next !== edited) {
      fileRef.current = next;
      if (live.current) setFile(next);
    }
    if (live.current) {
      setSaveState('saved');
      setSaveError(null);
    }
  }, []);

  const update = useCallback(
    (change: (f: ReportTextFile | null) => ReportTextFile) => {
      if (target.current.readOnly || target.current.projectId === null) return;
      const before = fileRef.current;
      const next = change(before);
      if (next === before) return;
      fileRef.current = next;
      setFile(next);
      pending.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void write(), SAVE_DELAY_MS);
    },
    [write],
  );

  // save what is pending when the editor closes
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      void write();
    };
  }, [write]);

  const author = () => {
    const name = authorName();
    return name ? { author: name } : {};
  };

  return {
    ready: ready && model !== null,
    error: loadError ?? (shown && 'error' in shown ? shown.error : null),
    readOnly,
    file,
    model,
    preview,
    texts,
    generated,
    pileNotes: pileNotesOf(file),
    pages: pagesOf(file),
    compareWith,
    saveState,
    saveError,
    setText: (id, text) => {
      update((f) => editText(f, id, text, author()));
    },
    reset: (id) => {
      if (model) update((f) => resetText(f, id, generated[id]));
    },
    setPileNote: (pileId, text) => {
      update((f) => editPileNote(f, pileId, text, author()));
    },
    setPage: (id, on) => {
      update((f) => withPage(f, id, on));
    },
    setCompareWith: (captureId) => {
      update((f) => withCompareWith(f, captureId));
    },
    flush: write,
  };
}
