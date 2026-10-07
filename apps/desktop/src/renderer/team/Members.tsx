import type { Member, Role } from '@aio/schema';
import { Icon, t, type MessageKey } from '@aio/ui';
import { useEffect, useState } from 'react';
import { refreshIdentity, useIdentity } from '../author';
import { bridge } from '../shell';

/**
 * The members of a project (M9 T2): roles, identity badges, devices, add from an identity card.
 * Only an owner changes the team; main checks every change again and explains a refusal.
 */

const ROLES: Role[] = ['owner', 'reviewer', 'viewer', 'client'];
const roleLabel = (r: Role) => t(`identity.role.${r}` as MessageKey);

type Res = { ok: true } | { ok: false; error: string };

/** One answer of a members channel as "done" or the sentence to show. */
function outcome(r: { ok: true; value: Res } | { ok: false; error: string }): string | null {
  if (!r.ok) return r.error;
  return r.value.ok ? null : r.value.error;
}

function Badge({ member, me }: { member: Member; me: string | undefined }) {
  switch (member.verification) {
    case 'self':
      return (
        <span className="tag" title={t('identity.badge.self.title')}>
          {t('identity.badge.self')}
        </span>
      );
    case 'owner':
      return (
        <span className="tag acc">
          <Icon name="shield" size={12} />
          {member.addedBy === me ? t('identity.badge.byYou') : t('identity.badge.owner')}
        </span>
      );
    case 'server':
      return <span className="tag acc">{t('identity.badge.server')}</span>;
    case 'account':
      return <span className="tag acc">{t('identity.badge.account')}</span>;
  }
}

interface Pending {
  path: string;
  name: string;
  initials: string;
}

export function Members({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { identity } = useIdentity();
  const myActor = identity?.actor;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [myRole, setMyRole] = useState<Role | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [role, setRole] = useState<Role>('reviewer');
  const [certify, setCertify] = useState(true);
  const [confirm, setConfirm] = useState<string | null>(null);

  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    void bridge.call('members:list', { projectId }).then((r) => {
      if (!live) return;
      if (!r.ok || !r.value.ok) {
        setError(r.ok ? (r.value.ok ? null : r.value.error) : r.error);
        return;
      }
      setMembers(r.value.members);
      setMyRole(r.value.me);
    });
    return () => {
      live = false;
    };
  }, [projectId, rev]);

  const shared = (members?.length ?? 0) > 0;
  const owner = !shared || myRole === 'owner';

  const run = async (call: () => Promise<string | null>) => {
    setError(await call());
    setConfirm(null);
    setRev((n) => n + 1);
    await refreshIdentity();
  };

  const pickCard = async () => {
    setError(null);
    const picked = await bridge.call('dialog:openFile', {
      title: t('identity.members.add'),
      filters: [{ name: 'Identity card', extensions: ['aioid'] }],
    });
    if (!picked.ok || !picked.value.path) return;
    const path = picked.value.path;
    const card = await bridge.call('identity:importCard', { path });
    const why = card.ok ? (card.value.ok ? null : card.value.error) : card.error;
    if (why !== null || !card.ok || !card.value.ok) {
      setError(why);
      return;
    }
    setPending({ path, name: card.value.name, initials: card.value.initials });
  };

  const add = (p: Pending) =>
    run(async () => {
      const r = await bridge.call('members:add', { projectId, card: p.path, role, certify });
      if (!r.ok) return r.error;
      if (!r.value.ok) return r.value.error;
      setPending(null);
      return null;
    });

  return (
    <div className="sblock">
      <h2>
        {t('identity.members', { project: projectName })}
        {owner && !pending && (
          <span className="acts">
            <button type="button" className="btn sm" onClick={() => void pickCard()}>
              <Icon name="plus" size={12} />
              {t('identity.members.add')}
            </button>
          </span>
        )}
      </h2>
      {members && !shared && <p className="help">{t('identity.members.none')}</p>}
      {error && (
        <p className="notice warn" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      {pending && (
        <div
          className="prov"
          role="group"
          aria-label={t('identity.members.confirmAdd', { name: pending.name })}
          style={{ marginBottom: 12, gridTemplateColumns: 'minmax(0, 1fr) auto' }}
        >
          <div style={{ display: 'grid', gap: 8 }}>
            <b>
              {pending.name} <span className="tag">{pending.initials}</span>
            </b>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('identity.members.addAs')}
              <select
                className="input"
                aria-label={t('identity.members.addAs')}
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as Role);
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={certify}
                onChange={(e) => {
                  setCertify(e.target.checked);
                }}
              />
              {t('identity.members.certify')}
            </label>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn sm primary" onClick={() => void add(pending)}>
              {t('identity.members.confirmAdd', { name: pending.name })}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setPending(null);
              }}
            >
              {t('identity.members.cancel')}
            </button>
          </div>
        </div>
      )}
      {shared && members && (
        <table className="tbl" aria-label={t('identity.members', { project: projectName })}>
          <thead>
            <tr>
              <th>{t('identity.col.person')}</th>
              <th>{t('identity.col.role')}</th>
              <th>{t('identity.col.identity')}</th>
              <th>{t('identity.col.devices')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const self = m.actor === myActor;
              const editable = myRole === 'owner' && !self;
              return (
                <tr key={m.actor} data-actor={m.actor}>
                  <td>
                    <span className="cell-h" title={m.email ?? m.name}>
                      <span className="tag">{m.initials}</span>
                      {m.name}
                      {self && <span className="faint">{t('identity.members.you')}</span>}
                    </span>
                  </td>
                  <td>
                    {editable ? (
                      <select
                        className="input"
                        aria-label={`${t('identity.col.role')}: ${m.name}`}
                        value={m.role}
                        onChange={(e) => {
                          const next = e.target.value as Role;
                          void run(async () =>
                            outcome(
                              await bridge.call('members:setRole', {
                                projectId,
                                actor: m.actor,
                                role: next,
                              }),
                            ),
                          );
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      roleLabel(m.role)
                    )}
                  </td>
                  <td>
                    <Badge member={m} me={myActor} />
                  </td>
                  <td>
                    {m.devices.map((d) => (
                      <div key={d.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span className="mono faint" title={d.id}>
                          {d.id.slice(0, 10)}
                        </span>
                        {d.revoked ? (
                          <span className="tag">{t('identity.members.revoked')}</span>
                        ) : (
                          myRole === 'owner' && (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => {
                                if (confirm !== `revoke:${d.id}`) {
                                  setConfirm(`revoke:${d.id}`);
                                  return;
                                }
                                void run(async () =>
                                  outcome(
                                    await bridge.call('members:revokeDevice', {
                                      projectId,
                                      device: d.id,
                                    }),
                                  ),
                                );
                              }}
                            >
                              {confirm === `revoke:${d.id}`
                                ? t('identity.members.confirmRevoke')
                                : t('identity.members.revoke')}
                            </button>
                          )
                        )}
                      </div>
                    ))}
                  </td>
                  <td>
                    {editable && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          if (confirm !== `remove:${m.actor}`) {
                            setConfirm(`remove:${m.actor}`);
                            return;
                          }
                          void run(async () =>
                            outcome(
                              await bridge.call('members:remove', { projectId, actor: m.actor }),
                            ),
                          );
                        }}
                      >
                        {confirm === `remove:${m.actor}`
                          ? t('identity.members.confirmRemove')
                          : t('identity.members.remove')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
