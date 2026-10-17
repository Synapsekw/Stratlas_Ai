/**
 * Unsaved measurement changes and their Save, or what dragging does while vertices are edited
 * (stage island D18). One note for every place that shows it: the Measure workbench's live card
 * and the card on top of the bench, and the stage's fallback while the right sidebar is folded
 * away (`UnsavedBar`).
 */
import { isTelecomTool } from '@aio/survey';
import { Button, useT, type MessageKey } from '@aio/ui';
import { useShell } from '../shell';
import { isDirty, saveMeasurements, useMeasure } from './measureStore';
import '../workspace/workbench/benches/measureBench.css';

/** What the note says, or null when there is nothing to say (or nothing may be saved). */
export function usePending(): { message: MessageKey; dirty: boolean; saving: boolean } | null {
  const dirty = useMeasure(isDirty);
  const saving = useMeasure((s) => s.saving);
  const editing = useMeasure((s) => s.editing !== null);
  const focusTool = useMeasure((s) => s.file.measurements.find((m) => m.id === s.focus)?.tool);
  const pkg = useShell((s) => s.pkg !== null);
  const readOnly = useMeasure((s) => s.readOnly) || pkg;
  if (readOnly || (!dirty && !editing)) return null;
  const message: MessageKey =
    editing && focusTool && isTelecomTool(focusTool)
      ? 'measureBench.editingEndpoints'
      : editing
        ? 'measureBench.editingVertices'
        : 'measureBench.unsaved';
  return { message, dirty, saving };
}

/** The note and, with unsaved changes, Save measurements (`saveTestId` names the button). */
export function PendingNote({ saveTestId = 'survey-save' }: { saveTestId?: string }) {
  const t = useT();
  const pending = usePending();
  if (!pending) return null;
  return (
    <div className="meb-pending" role="region" aria-label={t('measureBench.unsavedRegion')}>
      <span className="meb-faint">{t(pending.message)}</span>
      {pending.dirty && (
        <Button
          variant="primary"
          disabled={pending.saving}
          data-testid={saveTestId}
          onClick={() => {
            void saveMeasurements();
          }}
        >
          {t('measureBench.saveAll')}
        </Button>
      )}
    </div>
  );
}
