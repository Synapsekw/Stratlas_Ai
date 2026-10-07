import { IssueCollab } from '@aio/collab/ui';
import type { Issue, Layer, Sighting } from '@aio/schema';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useState } from 'react';
import { nextStatus, previousStatus } from '../model/ops';
import { focusIssue, issueEditor, useAnnotateReadOnly, useIssueEditorState } from '../runtime';
import { sightingAnchor, severityColor } from '../tools/mesh';
import { projectMsFromVideo } from '../video/track';
import { SeverityBadge, kindLabel, sevStyle, sightingLabel, useTaxonomy } from './common';
import { IssueHistory } from './historySlot';
import { AnnotateStyles } from './styles';

/** Jump the views to one sighting: open the photo, seek the clip, or fly to the 3D point. */
export function openSighting(issue: Issue, s: Sighting, layers: readonly Layer[]): void {
  const ws = workspace.getState();
  ws.select({ kind: 'issue', id: issue.id });
  if (s.on === 'image') {
    ws.select({ kind: 'photo', id: s.photo, layer: s.layer });
    return;
  }
  if (s.on === 'video') {
    const layer = layers.find((l) => l.id === s.layer);
    ws.setActiveClip(s.layer);
    if (layer?.kind === 'video') ws.setTime(projectMsFromVideo(layer, s.track[0]?.t ?? 0));
    return;
  }
  const p = sightingAnchor(s);
  if (p) ws.flyTo({ kind: 'point', p, distance: 4 });
}

function thumbFor(s: Sighting, layers: readonly Layer[], projectId: string | undefined) {
  if (!projectId) return null;
  const layer = layers.find((l) => l.id === s.layer);
  try {
    if (s.on === 'image' && layer?.kind === 'photos') {
      const p = layer.items.find((x) => x.id === s.photo);
      return p ? assetUrl(projectId, p.src) : null;
    }
    if (s.on === 'video' && layer?.kind === 'video' && layer.poster) {
      return assetUrl(projectId, layer.poster);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Detail and edit form for one issue (class, severity, status, note, sightings). `embedded` is
 * the edit part only, inside a card that already shows the code, severity, status and photos:
 * no header, no summary row, sightings as plain chips (no photo thumbnails).
 */
export function IssueDetail({
  issueId,
  className,
  embedded = false,
}: {
  issueId: string;
  className?: string;
  embedded?: boolean;
}) {
  const issue = useWorkspace((s) => s.issues.find((i) => i.id === issueId));
  const issues = useWorkspace((s) => s.issues);
  const project = useWorkspace((s) => s.project);
  const { classes, classById, modelById } = useTaxonomy();
  const { lastError } = useIssueEditorState();
  const readOnly = useAnnotateReadOnly();
  const [linkTarget, setLinkTarget] = useState('');

  if (!issue) {
    return (
      <div className={`ann-panel ${className ?? ''}`}>
        <AnnotateStyles />
        <div className="ann-empty">Issue {issueId} is not in this project.</div>
      </div>
    );
  }
  const layers = project?.manifest.layers ?? [];
  const model = modelById.get(issue.severityModelId);
  const cls = classById.get(issue.classId);
  const next = nextStatus(issue.status);
  const prev = previousStatus(issue.status);
  const others = issues.filter((i) => i.id !== issue.id);
  const severities: Issue['severity'][] = [
    ...(model?.levels.map((l) => l.value) ?? []),
    ...(model?.uncertain ? (['uncertain'] as const) : []),
  ];

  return (
    <div
      className={`ann-panel${embedded ? ' embedded' : ''} ${className ?? ''}`}
      data-testid={embedded ? 'issue-edit' : 'issue-detail'}
    >
      <AnnotateStyles />
      {!embedded && (
        <div className="ann-h">
          <h3>
            {issue.code} · {cls?.label ?? issue.classId}
          </h3>
          <div className="acts">
            <button
              type="button"
              className="ann-btn ghost"
              title="Fly to the best sighting"
              onClick={() => {
                focusIssue(issue);
              }}
            >
              Fly to
            </button>
          </div>
        </div>
      )}
      <div className="ann-body">
        {!embedded && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <SeverityBadge model={model} severity={issue.severity} withLabel />
            <span className={`ann-tag${issue.status === 'draft' ? ' acc' : ''}`}>
              {issue.status}
            </span>
            {issue.source !== 'human' && <span className="ann-tag">{issue.source}</span>}
            <span className="ann-faint" style={{ marginLeft: 'auto' }}>
              by {issue.author} · {issue.updatedAt.slice(0, 16).replace('T', ' ')}
            </span>
          </div>
        )}

        {readOnly ? (
          <>
            <b className="ann-ro-title">{issue.title}</b>
            {issue.note && <p className="ann-ro-note">{issue.note}</p>}
          </>
        ) : (
          <>
            <label className="ann-field">
              <span>Title</span>
              <input
                key={`t-${issue.updatedAt}`}
                className="ann-input"
                defaultValue={issue.title}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== issue.title) issueEditor.update(issue.id, { title: v });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </label>
            <label className="ann-field">
              <span>Class</span>
              <select
                className="ann-select"
                value={issue.classId}
                onChange={(e) => issueEditor.update(issue.id, { classId: e.target.value })}
              >
                {!cls && <option value={issue.classId}>{issue.classId}</option>}
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="ann-field">
              <span>Severity</span>
              <div className="ann-seg" role="group" aria-label="Severity">
                {severities.map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    aria-pressed={issue.severity === v}
                    title={
                      v === 'uncertain'
                        ? model?.uncertain?.label
                        : model?.levels.find((l) => l.value === v)?.criteria
                    }
                    onClick={() => issueEditor.update(issue.id, { severity: v })}
                  >
                    <span className="ann-dot" style={sevStyle(severityColor(model, v))} />
                    {v === 'uncertain' ? '?' : v}
                  </button>
                ))}
              </div>
            </div>
            <div className="ann-field">
              <span>Status</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {prev && (
                  <button
                    type="button"
                    className="ann-btn"
                    onClick={() => issueEditor.setStatus(issue.id, prev)}
                  >
                    Back to {prev}
                  </button>
                )}
                {next && (
                  <button
                    type="button"
                    className="ann-btn primary"
                    onClick={() => issueEditor.setStatus(issue.id, next)}
                  >
                    {next === 'reviewed'
                      ? 'Mark reviewed'
                      : next === 'approved'
                        ? 'Approve'
                        : 'Close'}
                  </button>
                )}
              </div>
            </div>
            <label className="ann-field" style={{ alignItems: 'start' }}>
              <span>Note</span>
              <textarea
                key={`n-${issue.updatedAt}`}
                className="ann-input"
                defaultValue={issue.note}
                onBlur={(e) => {
                  if (e.target.value !== issue.note)
                    issueEditor.update(issue.id, { note: e.target.value });
                }}
              />
            </label>
          </>
        )}
        {lastError && !readOnly && <div className="ann-error">{lastError}</div>}

        <div className="ann-faint">Sightings ({issue.sightings.length})</div>
        <div className="ann-sightings">
          {issue.sightings.map((s, idx) => {
            const thumb = embedded ? null : thumbFor(s, layers, project?.id);
            return (
              <div
                key={idx}
                className="ann-sighting"
                role="button"
                tabIndex={0}
                onClick={() => {
                  openSighting(issue, s, layers);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') openSighting(issue, s, layers);
                }}
              >
                <div
                  className="sth"
                  style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}
                >
                  {!thumb && kindLabel(s.on)}
                </div>
                <div className="stl">
                  <span title={sightingLabel(s)}>{sightingLabel(s)}</span>
                  {issue.sightings.length > 1 && !readOnly && (
                    <button
                      type="button"
                      className="ann-btn ghost danger"
                      style={{ height: 18, padding: '0 4px' }}
                      title="Remove this sighting"
                      onClick={(e) => {
                        e.stopPropagation();
                        issueEditor.removeSighting(issue.id, idx);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {others.length > 0 && !readOnly && (
          <div className="ann-field">
            <span>Same defect</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <select
                className="ann-select"
                aria-label="Other issue"
                value={linkTarget}
                onChange={(e) => {
                  setLinkTarget(e.target.value);
                }}
              >
                <option value="">Pick an issue</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} {o.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ann-btn"
                disabled={!linkTarget}
                title="Move every sighting of the picked issue into this one and delete it"
                onClick={() => {
                  issueEditor.merge(issue.id, linkTarget);
                  setLinkTarget('');
                }}
              >
                Merge here
              </button>
            </div>
          </div>
        )}

        <IssueCollab issueId={issue.id} editor={issueEditor} readOnly={readOnly} />
        <IssueHistory projectId={project?.id ?? ''} issueId={issue.id} />
        {!readOnly && (
          <div>
            <button
              type="button"
              className="ann-btn ghost danger"
              onClick={() => issueEditor.remove(issue.id)}
            >
              Delete issue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
