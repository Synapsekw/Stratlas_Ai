import {
  targetKey,
  type CollabTarget,
  type CommentView,
  type CommentVisibility,
} from '@aio/schema';
import { useT } from '@aio/ui';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { hlcTime } from '../ids';
import { mentionCandidates } from '../mentions';
import { renderLite } from '../text';
import { threadOf } from '../work';
import { collabWrite, personOf, useCollab, type Person } from './store';
import { CollabStyles } from './styles';
import { captureView, flyToView } from './view';

/** `7 Oct 14:05` from a clock reading. */
export function whenOf(hlc: string): string {
  const d = hlcTime(hlc);
  if (!d) return '';
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

export function Initials({ person }: { person: Person }) {
  return (
    <span className="clb-who" title={person.name} aria-hidden="true">
      {person.initials}
    </span>
  );
}

/** A comment's text: markdown-lite as React nodes, never HTML; links stay text. */
function LiteText({ text }: { text: string }) {
  return (
    <>
      {renderLite(text).map((line, i) => (
        <p key={i} dir="auto">
          {line.map((tok, j) =>
            tok.t === 'bold' ? (
              <b key={j}>{tok.v}</b>
            ) : tok.t === 'italic' ? (
              <i key={j}>{tok.v}</i>
            ) : tok.t === 'code' ? (
              <code key={j}>{tok.v}</code>
            ) : tok.t === 'mention' ? (
              <span key={j} className="m">
                @{tok.v}
              </span>
            ) : (
              <span key={j}>{tok.v}</span>
            ),
          )}
        </p>
      ))}
    </>
  );
}

/** The box a comment is written in: @mention picker, Attach view, who may see it. */
function Composer({
  target,
  replyTo,
  onDone,
  autoFocus,
}: {
  target: CollabTarget;
  replyTo?: string;
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const t = useT();
  const c = useCollab();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [attach, setAttach] = useState(false);
  const [visibility, setVisibility] = useState<CommentVisibility>('team');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = c.members.filter((m) => m.role !== 'client' && m.actor !== c.me?.actor);
  const hint = mentionCandidates(text, people);

  const post = async () => {
    if (!c.projectId || !text.trim()) return;
    setBusy(true);
    setError(null);
    const view = attach ? captureView() : null;
    if (attach && !view) {
      setBusy(false);
      setError(t('collab.comment.noView'));
      return;
    }
    const r = await collabWrite('collab:comment', {
      projectId: c.projectId,
      target,
      text: text.trim(),
      visibility,
      ...(picked.length ? { mentions: picked } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(view ? { view } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setText('');
    setPicked([]);
    setAttach(false);
    onDone?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void post();
    }
  };

  return (
    <div className="clb" data-testid="comment-composer">
      <textarea
        className="clb-input"
        dir="auto"
        aria-label={replyTo ? t('collab.comment.reply') : t('collab.comment.write')}
        placeholder={t('collab.comment.placeholder')}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKey}
      />
      {hint && (
        <div className="clb-pick" role="group" aria-label={t('collab.comment.mention')}>
          {hint.people.map((p) => (
            <button
              key={p.actor}
              type="button"
              className="clb-btn ghost"
              onClick={() => {
                setText(
                  `${text.slice(0, text.length - hint.query.length)}${p.name.split(' ')[0] ?? p.name} `,
                );
                setPicked([...new Set([...picked, p.actor])]);
              }}
            >
              <Initials person={p} /> {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="clb-row">
        {!replyTo && (
          <label className="clb-row clb-faint">
            <input
              type="checkbox"
              checked={attach}
              onChange={(e) => {
                setAttach(e.target.checked);
              }}
            />
            {t('collab.comment.attachView')}
          </label>
        )}
        {c.state.policy && (
          <select
            className="clb-input"
            aria-label={t('collab.comment.visibility')}
            value={visibility}
            onChange={(e) => {
              setVisibility(e.target.value as CommentVisibility);
            }}
          >
            <option value="team">{t('collab.comment.team')}</option>
            <option value="client">{t('collab.comment.client')}</option>
          </select>
        )}
        <span style={{ flex: 1 }} />
        {onDone && replyTo && (
          <button type="button" className="clb-btn ghost" onClick={onDone}>
            {t('collab.cancel')}
          </button>
        )}
        <button
          type="button"
          className="clb-btn primary"
          disabled={busy || !text.trim()}
          onClick={() => void post()}
        >
          {replyTo ? t('collab.comment.replyPost') : t('collab.comment.post')}
        </button>
      </div>
      {error && (
        <div className="clb-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function CommentItem({
  comment,
  reply,
  readOnly,
  onReply,
}: {
  comment: CommentView;
  reply?: boolean;
  readOnly?: boolean;
  onReply?: () => void;
}) {
  const t = useT();
  const c = useCollab();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const who = personOf(c, comment.author);
  const mine = c.me?.actor === comment.author;
  const owner = c.me?.role === 'owner';
  const gone = comment.deleted || Boolean(comment.redacted);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    const r = await fn();
    if (!r.ok) setError(r.error ?? t('collab.failed'));
    return r.ok;
  };

  return (
    <li
      className={`clb-c${reply ? ' reply' : ''}${gone ? ' gone' : ''}`}
      data-testid="comment"
      data-comment={comment.id}
    >
      <Initials person={who} />
      <div className="h">
        <b>{who.name}</b>
        <span className="clb-faint">{whenOf(comment.createdAt)}</span>
        {comment.editedAt && !gone && (
          <span className="clb-faint">{t('collab.comment.edited')}</span>
        )}
        {comment.visibility === 'client' && (
          <span className="clb-tag">{t('collab.comment.clientTag')}</span>
        )}
      </div>
      <div className="t">
        {comment.redacted ? (
          <p>
            {t('collab.comment.redacted', {
              name: personOf(c, comment.redacted.by).name,
              date: whenOf(comment.redacted.at),
            })}
          </p>
        ) : comment.deleted ? (
          <p>{t('collab.comment.deleted')}</p>
        ) : editing ? (
          <div className="clb">
            <textarea
              className="clb-input"
              dir="auto"
              aria-label={t('collab.comment.edit')}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
            />
            <div className="clb-row">
              <button
                type="button"
                className="clb-btn primary"
                disabled={!draft.trim()}
                onClick={() =>
                  void run(() =>
                    collabWrite('collab:editComment', {
                      projectId: c.projectId ?? '',
                      id: comment.id,
                      text: draft.trim(),
                    }),
                  ).then((ok) => {
                    if (ok) setEditing(false);
                  })
                }
              >
                {t('collab.save')}
              </button>
              <button
                type="button"
                className="clb-btn ghost"
                onClick={() => {
                  setEditing(false);
                }}
              >
                {t('collab.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <LiteText text={comment.text ?? ''} />
        )}
      </div>
      {!gone && !editing && (
        <div className="a">
          {comment.view && (
            <button
              type="button"
              className="clb-link"
              data-testid="comment-view"
              onClick={() => {
                if (comment.view) flyToView(comment.view);
              }}
            >
              {t('collab.comment.flyTo')}
            </button>
          )}
          {!readOnly && onReply && (
            <button type="button" className="clb-link" onClick={onReply}>
              {t('collab.comment.reply')}
            </button>
          )}
          {!readOnly && mine && (
            <button
              type="button"
              className="clb-link"
              onClick={() => {
                setDraft(comment.text ?? '');
                setEditing(true);
              }}
            >
              {t('collab.comment.edit')}
            </button>
          )}
          {!readOnly && (mine || owner) && (
            <button
              type="button"
              className="clb-link"
              onClick={() =>
                void run(() =>
                  collabWrite('collab:deleteComment', {
                    projectId: c.projectId ?? '',
                    id: comment.id,
                  }),
                )
              }
            >
              {t('collab.comment.delete')}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="clb-err t" role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

/** Comments on one target: threads with replies, then the box to write one. */
export function CommentThread({ target, readOnly }: { target: CollabTarget; readOnly?: boolean }) {
  const t = useT();
  const c = useCollab();
  const [replying, setReplying] = useState<string | null>(null);
  const key = targetKey(target);
  const threads = useMemo(
    () => threadOf(c.state.comments.filter((x) => targetKey(x.target) === key)),
    [c.state.comments, key],
  );
  return (
    <div className="clb" data-testid="comment-thread">
      <CollabStyles />
      {threads.length === 0 ? (
        <p className="clb-faint">{t('collab.comment.none')}</p>
      ) : (
        <ul className="clb-list">
          {threads.map(({ comment, replies }) => (
            <li key={comment.id} className="clb">
              <ul className="clb-list">
                <CommentItem
                  comment={comment}
                  {...(readOnly ? { readOnly } : {})}
                  onReply={() => {
                    setReplying(comment.id);
                  }}
                />
                {replies.map((r) => (
                  <CommentItem key={r.id} comment={r} reply {...(readOnly ? { readOnly } : {})} />
                ))}
              </ul>
              {replying === comment.id && (
                <Composer
                  target={target}
                  replyTo={comment.id}
                  autoFocus
                  onDone={() => {
                    setReplying(null);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && <Composer target={target} />}
    </div>
  );
}
