/**
 * A thread of questions about the photo in view: the turns, each answer marked as a draft with
 * "Make a finding", and the question box. The first cloud question goes through the cloud confirm
 * (`onNeedConfirm`, unless the project skips it); its follow-ups resend the same image without a
 * second one. Another photo starts a new thread on its first question.
 */
import type { AskRoute } from '@aio/ai';
import { useAnnotateReadOnly } from '@aio/annotate';
import type { ProjectManifest } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { itemKey, type DetectItem } from '../../detections/convert';
import { cloudConfirmSkipped } from './prefs';
import { answerToDraft, askInThread, askThread } from './thread';

type PhotoItem = DetectItem & { kind: 'photo' };

const sameRoute = (a: AskRoute | null, b: AskRoute) =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind === 'local' || (b.kind === 'cloud' && a.provider === b.provider && a.model === b.model));

export function ThreadView({
  projectId,
  manifest,
  item,
  route,
  onNeedConfirm,
  disabled = false,
  text: shownText,
  onText,
}: {
  projectId: string;
  manifest: ProjectManifest;
  /** The photo in view; null: nothing to ask about. */
  item: PhotoItem | null;
  /** Where the next question goes; null: nothing can answer. */
  route: AskRoute | null;
  /** A cloud question that needs the person's yes: show the confirm for `text`, then `send()`. */
  onNeedConfirm: (text: string, send: () => void) => void;
  /** Nothing can be sent (the panel says why). */
  disabled?: boolean;
  /** The question box's text, when the owner keeps it (a saved Ask request fills it). */
  text?: string;
  onText?: (text: string) => void;
}): ReactElement {
  const t = useT();
  const readOnly = useAnnotateReadOnly();
  const thread = useStore(askThread);
  const [ownText, setOwnText] = useState('');
  const text = shownText ?? ownText;
  const setText = (v: string) => {
    if (onText) onText(v);
    else setOwnText(v);
  };
  const [made, setMade] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const key = item ? itemKey(item) : null;
  // the thread shown is this photo's; another photo's is replaced on the first question here
  const mine = key !== null && thread.key === key;
  const turns = mine ? thread.turns : [];
  const pending = mine && thread.pending;
  const off = readOnly || disabled || item === null || route === null || pending;

  const send = () => {
    const q = text.trim();
    if (off || q === '') return;
    const go = (confirmed: boolean) => {
      setText('');
      setError(null);
      if (!mine) setMade(new Set());
      askInThread({
        projectId,
        manifest,
        item,
        text: q,
        route,
        ...(confirmed ? { confirmed: true } : {}),
      }).catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    };
    const needsYes =
      route.kind === 'cloud' &&
      !(mine && thread.confirmed && sameRoute(thread.route, route)) &&
      !cloudConfirmSkipped(projectId);
    if (needsYes)
      onNeedConfirm(q, () => {
        go(true);
      });
    else go(false);
  };

  const makeFinding = (turn: number) => {
    if (!item || readOnly) return;
    answerToDraft({ projectId, manifest, item, turn }).then(
      () => {
        setMade((s) => new Set(s).add(turn));
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const shownError = error ?? (mine ? thread.error : null);
  return (
    <div className="askp-thread" data-testid="ask-thread">
      {item === null ? (
        <p className="askp-note faint">{t('askPanel.thread.noPhoto')}</p>
      ) : turns.length === 0 && !pending ? (
        <p className="askp-note faint">{t('askPanel.thread.empty')}</p>
      ) : (
        <ol className="askp-turns" aria-live="polite">
          {turns.map((turn, n) =>
            turn.role === 'user' ? (
              <li key={n} className="askp-turn you" data-testid="thread-turn-user">
                <span className="askp-who">{t('askPanel.thread.you')}</span>
                <p>{turn.text}</p>
              </li>
            ) : (
              <li key={n} className="askp-turn ai" data-testid="thread-turn-ai">
                <span className="askp-who">
                  {t('askPanel.thread.ai')}
                  <span className="askp-chip">{t('askPanel.thread.draft')}</span>
                </span>
                <p>{turn.text}</p>
                {made.has(n) ? (
                  <span className="askp-made faint small" role="status">
                    <Icon name="check" size={12} />
                    {t('askPanel.thread.made')}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    data-testid="thread-make-finding"
                    disabled={readOnly}
                    onClick={() => {
                      makeFinding(n);
                    }}
                  >
                    <Icon name="flag" size={12} />
                    {t('askPanel.thread.makeFinding')}
                  </button>
                )}
              </li>
            ),
          )}
          {pending && (
            <li className="askp-turn ai pending" data-testid="thread-pending">
              <span className="askp-who">{t('askPanel.thread.ai')}</span>
              <p className="faint">{t('askPanel.thread.thinking')}</p>
            </li>
          )}
        </ol>
      )}
      {shownError !== null && (
        <p className="askp-note err" role="alert" data-testid="thread-error">
          {shownError}
        </p>
      )}
      <form
        className="askp-ask"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className="input askp-text"
          data-testid="thread-input"
          aria-label={t('askPanel.thread.input')}
          placeholder={t(
            turns.length > 0 ? 'askPanel.thread.followPlaceholder' : 'askPanel.thread.placeholder',
          )}
          rows={2}
          maxLength={2000}
          value={text}
          disabled={readOnly || item === null}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="submit"
          className="btn sm primary"
          data-testid="thread-send"
          disabled={off || text.trim() === ''}
        >
          <Icon name="send" size={12} />
          {t('askPanel.thread.send')}
        </button>
      </form>
    </div>
  );
}
