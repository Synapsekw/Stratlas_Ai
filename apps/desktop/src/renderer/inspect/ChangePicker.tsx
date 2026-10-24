/**
 * Change on an AI suggestion: the class and severity form, starting on the draft's own class and
 * severity (else the project's last choice), whose confirm accepts the draft with them. Under the
 * lists: Same as an existing finding, which links the draft to an issue instead (key L opens the
 * picker straight on it), and, for a class the AI suggested that the project lacks, Add it as a
 * class. One call at a time: a confirm or a pick while one is pending is ignored.
 */
import { ClassSeverityForm, useNewClass } from '@aio/annotate';
import type { Detection } from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import { useT } from '@aio/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createClassFromLabel } from '../detections/createFromLabel';
import { LinkPicker } from '../detections/LinkPicker';
import { acceptWith, linkSuggestion, type AcceptOutcome } from './actions';
import { lastChoiceFor } from './lastChoice';

export interface ChangePickerProps {
  projectId: string;
  detection: Detection;
  issues: readonly Issue[];
  /** 'link' opens straight on "Same as an existing finding…" (key L). Default 'pick'. */
  startOn?: 'pick' | 'link';
  onDone: () => void;
  onCancel: () => void;
}

function startValues(projectId: string, d: Detection) {
  if (d.classId) {
    return {
      classId: d.classId,
      severity: d.uncertain ? ('uncertain' as const) : d.severity,
    };
  }
  const last = lastChoiceFor(projectId);
  return { classId: last?.classId ?? null, severity: last?.severity ?? null };
}

export function ChangePicker({
  projectId,
  detection: d,
  issues,
  startOn = 'pick',
  onDone,
  onCancel,
}: ChangePickerProps): ReactElement {
  const t = useT();
  const { create, disabledReason } = useNewClass();
  const [linking, setLinking] = useState(startOn === 'link');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const start = startValues(projectId, d);

  const run = (call: () => Promise<AcceptOutcome>) => {
    if (pending.current) return;
    pending.current = true;
    setError(null);
    void call()
      .then((r) => {
        if (!alive.current) return;
        if (r.ok) onDone();
        else setError('error' in r ? r.error : t('inspect.acceptPick'));
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        pending.current = false;
      });
  };

  const word = d.suggestedNew && d.classId === '' ? d.label : undefined;

  return (
    <div
      className="ann-pop inspect-change-picker"
      data-stack="true"
      data-testid="inspect-change-picker"
      role="group"
      aria-label={t('inspect.change.title')}
    >
      {linking ? (
        <div className="inspect-change-link">
          <LinkPicker
            detection={d}
            issues={issues}
            onPick={(issueId) => {
              run(() => linkSuggestion(d.id, issueId));
            }}
            onCancel={() => {
              setError(null);
              if (startOn === 'link') onCancel();
              else setLinking(false);
            }}
          />
          {error && (
            <p className="ann-error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <ClassSeverityForm
          // a class made from the AI's word lands on the draft: start again on it
          key={d.classId}
          initialClassId={start.classId}
          initialSeverity={start.severity}
          confirmLabel={t('inspect.change.accept')}
          error={error}
          onConfirm={(classId, severity) => {
            run(() => acceptWith(projectId, d.id, { classId, severity }));
            return null;
          }}
          onCancel={onCancel}
          rows={
            <>
              {word && create && (
                <button
                  type="button"
                  className="ann-btn ghost"
                  data-testid="det-create-class"
                  disabled={disabledReason !== null || creating}
                  title={disabledReason ?? t('det.suggestedClass', { label: word })}
                  onClick={() => {
                    setCreating(true);
                    setError(null);
                    void createClassFromLabel(word).then((e) => {
                      if (!alive.current) return;
                      setCreating(false);
                      setError(e);
                    });
                  }}
                >
                  {t('inspect.change.addClass', { label: word })}
                </button>
              )}
              <button
                type="button"
                className="ann-btn ghost"
                data-testid="inspect-change-same"
                onClick={() => {
                  setError(null);
                  setLinking(true);
                }}
              >
                {t('inspect.change.same')}
                <kbd>L</kbd>
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
