import React, { useCallback, useEffect, useState } from 'react'
import { supabase, isConfigured } from './supabaseClient'
import {
  doInviteToVault, doSetVaultMember, doFireVaultMember,
  doResetVaultPassword, doCreateTransfer, doGrantVisit,
  doRevokeVisit, doResolveJoinRequest, setActiveVault,
} from './terminal/commands'

// Vault settings GUI — modal that opens when the user clicks MANAGE
// on a vault they own or admin. Tabbed interface covering all the
// vault operations that previously required terminal commands.
//
// Tabs:
//   overview    display name, owner, public toggle, password reset
//   members     list + inline edit role/clearance + fire
//   invites     pending invite list + revoke
//   visits      active visit grants + revoke
//   requests    pending join requests + approve/decline
//   ownership   transfer form + see pending transfer
//   danger      delete vault (owner only)

const TABS = [
  { id: 'overview',  label: 'OVERVIEW' },
  { id: 'members',   label: 'MEMBERS' },
  { id: 'invites',   label: 'INVITES' },
  { id: 'visits',    label: 'VISIT GRANTS' },
  { id: 'requests',  label: 'JOIN REQUESTS' },
  { id: 'ownership', label: 'OWNERSHIP' },
  { id: 'danger',    label: 'DANGER ZONE' },
]

const ROLE_COLOR = { owner: '#ffd166', admin: '#38ff9a', member: '#6a9980' }
const CLR_LABEL = { 1: 'PUBLIC', 2: 'CONFIDENTIAL', 3: 'SECRET', 4: 'TOP SECRET' }

export default function VaultSettings({ vaultId, myRole, user, onClose, onChange }) {
  const [tab, setTab] = useState('overview')
  const [info, setInfo] = useState(null)
  const [members, setMembers] = useState([])
  const [invites, setInvites] = useState([])
  const [visits, setVisits] = useState([])
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')    // toast / status
  const [busy, setBusy] = useState(false)

  const isOwner = myRole === 'owner'
  const canAdmin = isOwner || myRole === 'admin'
  const ctx = { supabase, isConfigured, user }

  // ── Load all the data the GUI needs ──
  const load = useCallback(async () => {
    if (!isConfigured || !vaultId) return
    setLoading(true)
    setError('')
    try {
      const tasks = [
        supabase.rpc('peek_get_vault_public_info', { p_vault_id: vaultId }),
        supabase.rpc('peek_list_vault_invites', { p_vault_id: vaultId }),
        supabase.rpc('peek_list_visit_grants', { p_vault_id: vaultId }),
        supabase.rpc('peek_list_join_requests', { p_vault_id: vaultId }),
      ]
      const [infoR, invR, visR, reqR] = await Promise.all(tasks)
      if (infoR.error) throw new Error(`info: ${infoR.error.message}`)
      if (invR.error) throw new Error(`invites: ${invR.error.message}`)
      if (visR.error) throw new Error(`visits: ${visR.error.message}`)
      if (reqR.error) throw new Error(`requests: ${reqR.error.message}`)
      setInfo(infoR.data)
      setInvites(invR.data || [])
      setVisits(visR.data || [])
      setRequests(reqR.data || [])

      // Members query — direct table read. RLS limits us to what we can see
      // (members + global admin/O5). We need usernames too, so we do two
      // queries and join client-side.
      const memR = await supabase
        .from('vault_members')
        .select('user_id, role, clearance, joined_at')
        .eq('vault_id', vaultId)
        .order('role', { ascending: true })
      if (memR.error) throw new Error(`members: ${memR.error.message}`)
      const ids = (memR.data || []).map((m) => m.user_id).filter(Boolean)
      let userMap = {}
      if (ids.length) {
        const uR = await supabase
          .from('users')
          .select('id, username')
          .in('id', ids)
        if (!uR.error) {
          userMap = Object.fromEntries((uR.data || []).map((u) => [u.id, u.username]))
        }
      }
      setMembers((memR.data || []).map((m) => ({ ...m, username: userMap[m.user_id] || m.user_id.slice(0, 8) })))
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [vaultId])

  useEffect(() => { load() }, [load])

  // ── Helpers for actions ──
  const flash = (text) => {
    setMsg(text)
    setTimeout(() => setMsg(''), 2400)
  }
  const wrap = async (fn, successText) => {
    setBusy(true); setError('')
    try {
      const res = await fn()
      if (res?.ok) {
        flash(successText || 'done')
        await load()
        onChange?.()
      } else {
        setError(res?.reason || 'unknown error')
      }
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // ── RENDER ──
  return (
    <div className="vset__overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="vset__modal">
        <div className="vset__title">
          <div className="vset__title-main">
            <span className="vset__title-icon">⚙</span>
            <span>VAULT SETTINGS</span>
          </div>
          <div className="vset__title-sub">
            <span className="vset__title-id">{vaultId}</span>
            {info?.display_name && <span className="vset__title-name">{info.display_name}</span>}
            {myRole && (
              <span className="vset__title-role" style={{ color: ROLE_COLOR[myRole] }}>
                {myRole.toUpperCase()}
              </span>
            )}
          </div>
          <button className="vset__close" onClick={onClose} aria-label="close">×</button>
        </div>

        <div className="vset__tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`vset__tab ${tab === t.id ? 'vset__tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {msg && <div className="vset__toast vset__toast--ok">{msg}</div>}
        {error && <div className="vset__toast vset__toast--err">{error}</div>}

        <div className="vset__content">
          {loading && <div className="vset__loading">loading vault data…</div>}
          {!loading && tab === 'overview' && (
            <OverviewTab
              info={info} vaultId={vaultId} isOwner={isOwner} canAdmin={canAdmin}
              busy={busy}               onPublicChange={async (val) => {
                await wrap(async () => {
                  const { data, error } = await supabase.rpc('peek_set_vault_public', {
                    p_vault_id: vaultId,
                    p_is_public: val,
                  })
                  if (error) return { ok: false, reason: error.message }
                  // Surface the actual RPC response so we don't show a generic 'failed'
                  if (data && typeof data === 'object') {
                    if (data.status === 'ok') return { ok: true }
                    return { ok: false, reason: data.reason || `rpc returned status=${data.status}` }
                  }
                  // RPC returned no data — treat as failure with a hint
                  return { ok: false, reason: 'rpc returned no data' }
                }, `vault is_public = ${val}`)
              }}
              onPasswordChange={async (oldPw, newPw) => {
                await wrap(
                  () => doResetVaultPassword(vaultId, oldPw, newPw, ctx),
                  'password updated'
                )
              }}
            />
          )}
          {!loading && tab === 'members' && (
            <MembersTab
              members={members} canAdmin={canAdmin} isOwner={isOwner} busy={busy}
              currentUserId={user?.id}
              onSetRole={async (uid, role, clearance) => {
                await wrap(() => doSetVaultMember(vaultId, uid, role, clearance, ctx),
                  `member updated`)
              }}
              onFire={async (uid) => {
                if (!confirm('fire this member? they will lose all access to this vault.')) return
                await wrap(() => doFireVaultMember(vaultId, uid, ctx),
                  'member removed from vault')
              }}
            />
          )}
          {!loading && tab === 'invites' && (
            <InvitesTab
              vaultId={vaultId} invites={invites} canAdmin={canAdmin} busy={busy}
              onInvite={async (username, role, clearance) => {
                await wrap(() => doInviteToVault(vaultId, username, role, clearance, ctx),
                  `invite sent to ${username}`)
              }}
              onRevoke={async (token) => {
                // peek_send_vault_invite has no revoke endpoint — best we can
                // do is delete the row. Members can't do that, but admins
                // can via the vault_invites RLS we set up.
                await wrap(async () => {
                  const { error } = await supabase.from('vault_invites').delete().eq('token', token)
                  return error ? { ok: false, reason: error.message } : { ok: true }
                }, 'invite revoked')
              }}
            />
          )}
          {!loading && tab === 'visits' && (
            <VisitsTab
              vaultId={vaultId} visits={visits} canAdmin={canAdmin} busy={busy}
              onGrant={async (username, clearance, hours) => {
                await wrap(() => doGrantVisit(vaultId, username, clearance, hours, ctx),
                  `granted clearance to ${username} for ${hours}h`)
              }}
              onRevoke={async (username) => {
                await wrap(() => doRevokeVisit(vaultId, username, ctx),
                  'visit grant revoked')
              }}
            />
          )}
          {!loading && tab === 'requests' && (
            <RequestsTab
              requests={requests} canAdmin={canAdmin} busy={busy}
              onResolve={async (id, approve) => {
                await wrap(() => doResolveJoinRequest(id, approve, ctx),
                  approve ? 'approved' : 'declined')
              }}
            />
          )}
          {!loading && tab === 'ownership' && (
            <OwnershipTab
              vaultId={vaultId} isOwner={isOwner} busy={busy}
              onTransfer={async (username) => {
                if (!confirm(`transfer ownership of "${vaultId}" to ${username}? you will lose all access.`)) return
                await wrap(() => doCreateTransfer(vaultId, username, ctx),
                  'transfer initiated. target must accept to complete.')
              }}
            />
          )}
          {!loading && tab === 'danger' && isOwner && (
            <DangerTab vaultId={vaultId} busy={busy}
              onDelete={async () => {
                const typed = prompt('THIS IS IRREVERSIBLE. Type the vault id to confirm:')
                if (typed !== vaultId) return
                await wrap(async () => {
                  // No peek_delete_vault exists yet — drop a placeholder note
                  // for the operator. A real RPC can be added later.
                  return { ok: false, reason: 'delete-vault not yet implemented in this build' }
                }, '')
              }}
            />
          )}
          {!loading && tab === 'danger' && !isOwner && (
            <div className="vset__readonly">only the owner can delete a vault.</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── TAB: Overview ────────────────────────────────────────────────────────────
function OverviewTab({ info, vaultId, isOwner, canAdmin, busy, onPublicChange, onPasswordChange }) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  return (
    <div className="vset__pane">
      <div className="vset__row">
        <div className="vset__label">DISPLAY NAME</div>
        <div className="vset__value">{info?.display_name || '—'}</div>
      </div>
      <div className="vset__row">
        <div className="vset__label">OWNER</div>
        <div className="vset__value">{info?.owner_display || '—'}</div>
      </div>
      <div className="vset__row">
        <div className="vset__label">CREATED</div>
        <div className="vset__value">
          {info?.created_at ? new Date(info.created_at).toISOString().slice(0, 10) : '—'}
        </div>
      </div>
      <div className="vset__row">
        <div className="vset__label">MEMBERS</div>
        <div className="vset__value">{info?.member_count ?? '—'}</div>
      </div>
      <div className="vset__row">
        <div className="vset__label">PUBLIC ARCHIVES</div>
        <div className="vset__value">{info?.public_archive_count ?? '—'}</div>
      </div>

      <hr className="vset__rule" />

      <div className="vset__row">
        <div className="vset__label">PUBLIC VISIBILITY</div>
        <div className="vset__value">
          {canAdmin ? (
            <label className="vset__switch">
              <input
                type="checkbox"
                checked={!!info?.is_public}
                disabled={busy}
                onChange={(e) => onPublicChange(e.target.checked)}
              />
              <span className="vset__switch-slider" />
              <span className="vset__switch-label">
                {info?.is_public ? 'PUBLIC' : 'PRIVATE'}
              </span>
            </label>
          ) : (
            <span>{info?.is_public ? 'PUBLIC' : 'PRIVATE'}</span>
          )}
        </div>
      </div>
      <div className="vset__hint">
        When public, anyone can browse this vault's PUBLIC-classified archives and request to join.
      </div>

      {isOwner && (
        <>
          <hr className="vset__rule" />
          <div className="vset__subhead">RESET VAULT PASSWORD</div>
          <div className="vset__form">
            <input
              type="password"
              placeholder="old password"
              value={oldPw}
              disabled={busy}
              onChange={(e) => setOldPw(e.target.value)}
              className="vset__input"
            />
            <input
              type="password"
              placeholder="new password"
              value={newPw}
              disabled={busy}
              onChange={(e) => setNewPw(e.target.value)}
              className="vset__input"
            />
            <button
              className="vset__btn"
              disabled={busy || !oldPw || !newPw}
              onClick={() => { onPasswordChange(oldPw, newPw); setOldPw(''); setNewPw('') }}
            >
              RESUME PASSWORD
            </button>
          </div>
          <div className="vset__hint">owner only. used to authorize sensitive operations later.</div>
        </>
      )}
    </div>
  )
}

// ── TAB: Members ────────────────────────────────────────────────────────────
function MembersTab({ members, canAdmin, isOwner, busy, currentUserId, onSetRole, onFire }) {
  // Editable inline — when user clicks the role/clearance pill, show a picker
  return (
    <div className="vset__pane">
      <div className="vset__subhead">CURRENT MEMBERS ({members.length})</div>
      {members.length === 0 && <div className="vset__empty">no members visible.</div>}
      {members.map((m) => (
        <MemberRow
          key={m.user_id} m={m} canAdmin={canAdmin} isOwner={isOwner} busy={busy}
          currentUserId={currentUserId}
          onSetRole={onSetRole} onFire={onFire}
        />
      ))}
    </div>
  )
}

function MemberRow({ m, canAdmin, isOwner, busy, currentUserId, onSetRole, onFire }) {
  const [editing, setEditing] = useState(false)
  const [role, setRole] = useState(m.role)
  const [clearance, setClearance] = useState(m.clearance)
  const isSelf = m.user_id === (currentUserId || '')
  const canEditThis = canAdmin && !(m.role === 'owner' && !isOwner)  // owner row is read-only for non-owners
  const canFireThis = canAdmin && m.role !== 'owner' && !isSelf

  return (
    <div className="vset__member-row">
      <div className="vset__member-head">
        <div className="vset__member-name">
          {m.username}
          {isSelf && <span className="vset__member-self">YOU</span>}
        </div>
        <div className="vset__member-joined">
          joined {new Date(m.joined_at).toISOString().slice(0, 10)}
        </div>
      </div>
      <div className="vset__member-body">
        {editing ? (
          <>
            <select className="vset__select" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy || !isOwner}>
              <option value="owner">owner</option>
              <option value="admin">admin</option>
              <option value="member">member</option>
            </select>
            <select className="vset__select" value={clearance} onChange={(e) => setClearance(Number(e.target.value))} disabled={busy}>
              <option value="1">L1 PUBLIC</option>
              <option value="2">L2 CONFIDENTIAL</option>
              <option value="3">L3 SECRET</option>
              <option value="4">L4 TOP SECRET</option>
            </select>
            <button
              className="vset__btn vset__btn--small"
              disabled={busy}
              onClick={() => { onSetRole(m.user_id, role, clearance); setEditing(false) }}
            >
              SAVE
            </button>
            <button
              className="vset__btn vset__btn--ghost vset__btn--small"
              disabled={busy}
              onClick={() => { setEditing(false); setRole(m.role); setClearance(m.clearance) }}
            >
              CANCEL
            </button>
          </>
        ) : (
          <>
            <span className="vset__pill" style={{ color: ROLE_COLOR[m.role], borderColor: ROLE_COLOR[m.role] }}>
              {m.role}
            </span>
            <span className="vset__pill vset__pill--clearance">
              {CLR_LABEL[m.clearance]}
            </span>
            {canEditThis && (
              <button
                className="vset__btn vset__btn--ghost vset__btn--small"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                EDIT
              </button>
            )}
            {canFireThis && (
              <button
                className="vset__btn vset__btn--danger vset__btn--small"
                disabled={busy}
                onClick={() => onFire(m.user_id)}
              >
                FIRE
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── TAB: Invites ────────────────────────────────────────────────────────────
function InvitesTab({ vaultId, invites, canAdmin, busy, onInvite, onRevoke }) {
  const [username, setUsername] = useState('')
  const [role, setRole] = useState('member')
  const [clearance, setClearance] = useState(1)
  return (
    <div className="vset__pane">
      {canAdmin && (
        <>
          <div className="vset__subhead">SEND NEW INVITE</div>
          <div className="vset__form">
            <input
              type="text" placeholder="username" className="vset__input"
              value={username} disabled={busy} onChange={(e) => setUsername(e.target.value)}
            />
            <select className="vset__select" value={role} disabled={busy} onChange={(e) => setRole(e.target.value)}>
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <select className="vset__select" value={clearance} disabled={busy} onChange={(e) => setClearance(Number(e.target.value))}>
              <option value="1">L1 PUBLIC</option>
              <option value="2">L2 CONFIDENTIAL</option>
              <option value="3">L3 SECRET</option>
              <option value="4">L4 TOP SECRET</option>
            </select>
            <button
              className="vset__btn"
              disabled={busy || !username}
              onClick={() => { onInvite(username, role, clearance); setUsername('') }}
            >
              INVITE
            </button>
          </div>
          <hr className="vset__rule" />
        </>
      )}
      <div className="vset__subhead">PENDING INVITES ({invites.length})</div>
      {invites.length === 0 && <div className="vset__empty">no invites.</div>}
      {invites.map((inv) => {
        const status = inv.accepted_at ? 'ACCEPTED' : (new Date(inv.expires_at) < new Date() ? 'EXPIRED' : 'PENDING')
        return (
          <div key={inv.token} className="vset__row vset__row--lined">
            <div className="vset__row-main">
              <div className="vset__row-main-l">{inv.invitee_email}</div>
              <div className="vset__row-main-r">
                <span className="vset__pill">{inv.role}</span>
                <span className="vset__pill vset__pill--clearance">{CLR_LABEL[inv.clearance]}</span>
                <span className={`vset__pill vset__pill--${status.toLowerCase()}`}>{status}</span>
              </div>
            </div>
            <div className="vset__row-detail">
              <span className="vset__mono">{inv.token}</span>
              {canAdmin && status === 'PENDING' && (
                <button
                  className="vset__btn vset__btn--danger vset__btn--small"
                  disabled={busy}
                  onClick={() => onRevoke(inv.token)}
                >
                  REVOKE
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── TAB: Visit Grants ───────────────────────────────────────────────────────
function VisitsTab({ vaultId, visits, canAdmin, busy, onGrant, onRevoke }) {
  const [username, setUsername] = useState('')
  const [clearance, setClearance] = useState(2)
  const [hours, setHours] = useState(2)
  return (
    <div className="vset__pane">
      {canAdmin && (
        <>
          <div className="vset__subhead">GRANT TEMPORARY ACCESS</div>
          <div className="vset__form">
            <input
              type="text" placeholder="username" className="vset__input"
              value={username} disabled={busy} onChange={(e) => setUsername(e.target.value)}
            />
            <select className="vset__select" value={clearance} disabled={busy} onChange={(e) => setClearance(Number(e.target.value))}>
              <option value="1">L1 PUBLIC</option>
              <option value="2">L2 CONFIDENTIAL</option>
              <option value="3">L3 SECRET</option>
              <option value="4">L4 TOP SECRET</option>
            </select>
            <input
              type="number" min="1" max="168" className="vset__input vset__input--num"
              value={hours} disabled={busy} onChange={(e) => setHours(Number(e.target.value))}
            />
            <span className="vset__hint-inline">hours</span>
            <button
              className="vset__btn"
              disabled={busy || !username || hours < 1}
              onClick={() => { onGrant(username, clearance, hours); setUsername('') }}
            >
              GRANT
            </button>
          </div>
          <hr className="vset__rule" />
        </>
      )}
      <div className="vset__subhead">ACTIVE VISIT GRANTS ({visits.length})</div>
      {visits.length === 0 && <div className="vset__empty">no active grants.</div>}
      {visits.map((v, i) => {
        const expired = new Date(v.expires_at) < new Date()
        return (
          <div key={i} className="vset__row vset__row--lined">
            <div className="vset__row-main">
              <div className="vset__row-main-l">{v.username}</div>
              <div className="vset__row-main-r">
                <span className="vset__pill vset__pill--clearance">{CLR_LABEL[v.clearance]}</span>
                <span className={`vset__pill ${expired ? 'vset__pill--expired' : 'vset__pill--active'}`}>
                  {expired ? 'EXPIRED' : `expires ${new Date(v.expires_at).toISOString().slice(0, 16).replace('T', ' ')}`}
                </span>
              </div>
            </div>
            {canAdmin && !expired && (
              <div className="vset__row-detail">
                <button
                  className="vset__btn vset__btn--danger vset__btn--small"
                  disabled={busy}
                  onClick={() => onRevoke(v.username)}
                >
                  REVOKE
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── TAB: Join Requests ──────────────────────────────────────────────────────
function RequestsTab({ requests, canAdmin, busy, onResolve }) {
  return (
    <div className="vset__pane">
      <div className="vset__subhead">PENDING JOIN REQUESTS ({requests.length})</div>
      {requests.length === 0 && <div className="vset__empty">no pending requests.</div>}
      {requests.map((r) => (
        <div key={r.request_id} className="vset__row vset__row--lined">
          <div className="vset__row-main">
            <div className="vset__row-main-l">{r.requester_username || r.requester_email}</div>
            <div className="vset__row-main-r">
              <span className={`vset__pill vset__pill--${r.status}`}>{r.status}</span>
            </div>
          </div>
          {r.message && <div className="vset__member-msg">"{r.message}"</div>}
          {canAdmin && r.status === 'pending' && (
            <div className="vset__row-detail">
              <button
                className="vset__btn vset__btn--small"
                disabled={busy}
                onClick={() => onResolve(r.request_id, true)}
              >
                APPROVE
              </button>
              <button
                className="vset__btn vset__btn--danger vset__btn--small"
                disabled={busy}
                onClick={() => onResolve(r.request_id, false)}
              >
                DECLINE
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── TAB: Ownership ──────────────────────────────────────────────────────────
function OwnershipTab({ vaultId, isOwner, busy, onTransfer }) {
  const [username, setUsername] = useState('')
  return (
    <div className="vset__pane">
      <div className="vset__subhead">TRANSFER OWNERSHIP</div>
      <div className="vset__hint">
        Transferring ownership immediately removes the current owner from the vault. The
        target must accept the transfer mail to confirm. ONE owner per vault at a time.
      </div>
      {!isOwner && (
        <div className="vset__readonly">only the current owner can initiate a transfer.</div>
      )}
      {isOwner && (
        <div className="vset__form">
          <input
            type="text" placeholder="target username" className="vset__input"
            value={username} disabled={busy} onChange={(e) => setUsername(e.target.value)}
          />
          <button
            className="vset__btn vset__btn--danger"
            disabled={busy || !username}
            onClick={() => onTransfer(username)}
          >
            INITIATE TRANSFER
          </button>
        </div>
      )}
    </div>
  )
}

// ── TAB: Danger Zone ────────────────────────────────────────────────────────
function DangerTab({ vaultId, busy, onDelete }) {
  return (
    <div className="vset__pane">
      <div className="vset__subhead vset__danger-head">DELETE VAULT</div>
      <div className="vset__hint">
        This permanently deletes the vault and all its members, invites, visit grants, and
        join requests. Archives are retained but become orphaned (visible to O5 only).
      </div>
      <div className="vset__form">
        <button
          className="vset__btn vset__btn--danger vset__btn--large"
          disabled={busy}
          onClick={onDelete}
        >
          DELETE THIS VAULT
        </button>
      </div>
    </div>
  )
}
