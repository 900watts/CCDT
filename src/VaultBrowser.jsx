import React, { useCallback, useEffect, useState } from 'react'
import { supabase, isConfigured } from './supabaseClient'
import { demoStore } from './store'
import { doCreateJoinRequest, fetchOne, setActiveVault } from './terminal/commands'
import { openDossierWindow } from './dossierWindow'

// Card colors keyed by role. Public vaults get a green accent.
const ROLE_COLOR = {
  owner: '#ffd166',
  admin: '#38ff9a',
  member: '#6a9980',
  outsider: '#5a8a8a',
}

export default function VaultBrowser({ user }) {
  // ── Two-pane layout: list on the left, detail on the right ──
  const [publicVaults, setPublicVaults] = useState([])
  const [myVaults, setMyVaults] = useState([])
  const [selected, setSelected] = useState(null)   // vault id
  const [info, setInfo] = useState(null)            // peek_get_vault_public_info result
  const [archives, setArchives] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [joinStatus, setJoinStatus] = useState('') // '', 'sending', 'sent', 'err:<reason>'
  const [error, setError] = useState('')

  const ctx = () => ({ supabase, isConfigured, user, demoData: demoStore })

  // ── List all vaults the browser cares about ──
  const loadList = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const tasks = []
      if (isConfigured) {
        tasks.push(supabase.rpc('peek_list_public_vaults'))
        if (user) {
          tasks.push(supabase.rpc('peek_list_my_vaults'))
        }
      }
      const results = await Promise.all(tasks)
      const pub = results[0]
      const mine = user ? results[1] : null
      setPublicVaults(pub?.data || [])
      setMyVaults(mine?.data || [])
      if (pub?.error) setError(`public vault list: ${pub.error.message}`)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { loadList() }, [loadList])

  // ── Pick a vault and load its public info + public archives ──
  const selectVault = useCallback(async (vaultId) => {
    setSelected(vaultId)
    setInfo(null)
    setArchives([])
    setJoinStatus('')
    if (!vaultId || !isConfigured) return
    const [infoRes, archRes] = await Promise.all([
      supabase.rpc('peek_get_vault_public_info', { p_vault_id: vaultId }),
      supabase.rpc('peek_list_public_archives_of_vault', { p_vault_id: vaultId, p_limit: 100 }),
    ])
    if (infoRes.error) {
      setError(`vault info: ${infoRes.error.message}`)
    } else {
      setInfo(infoRes.data)
    }
    if (archRes.error) {
      setError(`vault archives: ${archRes.error.message}`)
    } else {
      setArchives(archRes.data || [])
    }
  }, [])

  // ── Request to join the currently selected vault ──
  const requestJoin = useCallback(async () => {
    if (!selected || !user) return
    setJoinStatus('sending')
    setError('')
    const res = await doCreateJoinRequest(selected, null, ctx())
    if (res.ok) {
      setJoinStatus('sent')
      // Refresh info so pending_request_id appears
      const r = await supabase.rpc('peek_get_vault_public_info', { p_vault_id: selected })
      if (!r.error) setInfo(r.data)
    } else {
      setJoinStatus(`err:${res.reason}`)
    }
  }, [selected, user, ctx])

  // ── Open an archive (dossier window) ──
  const openArchive = useCallback(async (num) => {
    const res = await fetchOne(num, ctx())
    if (res.ok) {
      openDossierWindow(res.data, { operatorClearance: res.data.classification || 'PUBLIC' })
    } else if (res.reason === 'not_found') {
      setError(`ARCHIVE ${num} NOT FOUND`)
    } else {
      setError(`cannot open: ${res.reason}`)
    }
  }, [ctx])

  // ── Filter for the search box ──
  const matches = (v, term) => {
    if (!term) return true
    const t = term.toLowerCase()
    return v.vault_id.toLowerCase().includes(t) ||
           (v.display_name || '').toLowerCase().includes(t)
  }
  const filteredPublic = publicVaults.filter((v) => matches(v, q))
  const filteredMine = myVaults.filter((v) => matches(v, q))

  // ── Determine CTA label/disabled state for the selected vault ──
  const myRole = info?.my_role || null
  const myClr  = info?.my_clearance || 0
  const pendingId = info?.pending_request_id || null
  const isOwnVault = myRole === 'owner'

  return (
    <div className="vbrowser">
      {/* ── toolbar ── */}
      <div className="vbrowser__toolbar">
        <span className="vbrowser__title">VAULTS</span>
        <span className="vbrowser__count">
          {filteredPublic.length} public · {filteredMine.length} yours
        </span>
        <input
          className="vbrowser__search"
          placeholder="filter…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
        <button className="vbrowser__btn" onClick={loadList} title="refresh">⟳</button>
      </div>

      {error && <div className="vbrowser__err">{error}</div>}

      <div className="vbrowser__split">
        {/* ── left: list ── */}
        <div className="vbrowser__list">
          {loading && <div className="vbrowser__empty">loading…</div>}

          {!loading && filteredMine.length > 0 && (
            <>
              <div className="vbrowser__list-header">YOUR VAULTS</div>
              {filteredMine.map((v) => (
                <VaultRow
                  key={v.vault_id}
                  v={v}
                  selected={selected === v.vault_id}
                  onClick={() => selectVault(v.vault_id)}
                  badge={`role=${v.role}`}
                  badgeColor={ROLE_COLOR[v.role] || ROLE_COLOR.member}
                  tag={v.vault_id === (info?.id) && myRole ? '◀ active' : ''}
                  subtitle={`members: ${v.member_count}`}
                />
              ))}
            </>
          )}

          {!loading && filteredPublic.length > 0 && (
            <>
              <div className="vbrowser__list-header">PUBLIC VAULTS</div>
              {filteredPublic.map((v) => (
                <VaultRow
                  key={v.id}
                  v={{ vault_id: v.id, display_name: v.display_name }}
                  selected={selected === v.id}
                  onClick={() => selectVault(v.id)}
                  badge="PUBLIC"
                  badgeColor="#38ff9a"
                  subtitle={`owner: ${v.owner_display} · members: ${v.member_count}`}
                />
              ))}
            </>
          )}

          {!loading && !filteredPublic.length && !filteredMine.length && (
            <div className="vbrowser__empty">
              {user
                ? 'no public vaults and no vault memberships yet.'
                : 'not authenticated — run login in the terminal.'}
            </div>
          )}
        </div>

        {/* ── right: detail ── */}
        <div className="vbrowser__detail">
          {!selected && (
            <div className="vbrowser__detail-empty">
              ← pick a vault on the left
              <br/>
              public vaults show here even if you are not a member.
            </div>
          )}

          {selected && !info && (
            <div className="vbrowser__detail-empty">loading vault info…</div>
          )}

          {selected && info && (
            <div className="vbrowser__detail-body">
              <div className="vbrowser__detail-head">
                <div className="vbrowser__detail-id">{info.id}</div>
                <div className="vbrowser__detail-name">{info.display_name}</div>
                <div className="vbrowser__detail-meta">
                  owner: {info.owner_display} · members: {info.member_count} ·{' '}
                  public archives: {info.public_archive_count}
                  {info.is_public ? ' · public vault' : ' · private vault'}
                </div>
                {myRole && (
                  <div className="vbrowser__detail-mine">
                    you are <b style={{color: ROLE_COLOR[myRole] || '#fff'}}>{myRole}</b> in this vault
                    {myClr ? ` · vault-clr ${myClr}` : ''}
                  </div>
                )}
              </div>

              <div className="vbrowser__detail-actions">
                {isOwnVault && (
                  <div className="vbrowser__badge vbrowser__badge--own">
                    you own this vault. open the terminal to manage it.
                  </div>
                )}
                {!isOwnVault && myRole && (
                  <button
                    className="vbrowser__btn vbrowser__btn--primary"
                    onClick={() => { setActiveVault(info.id); setJoinStatus('switched') }}
                  >
                    SWITCH ACTIVE VAULT
                  </button>
                )}
                {!myRole && (
                  <button
                    className="vbrowser__btn vbrowser__btn--primary"
                    onClick={requestJoin}
                    disabled={joinStatus === 'sending' || !!pendingId}
                  >
                    {pendingId
                      ? 'JOIN REQUEST PENDING'
                      : joinStatus === 'sending'
                        ? 'SENDING…'
                        : 'REQUEST TO JOIN'}
                  </button>
                )}
                {joinStatus === 'sent' && (
                  <span className="vbrowser__ok">request sent. admin/owner will review.</span>
                )}
                {joinStatus.startsWith('err:') && (
                  <span className="vbrowser__err-inline">denied: {joinStatus.slice(4)}</span>
                )}
                {joinStatus === 'switched' && (
                  <span className="vbrowser__ok">active vault is now {info.id}.</span>
                )}
              </div>

              <div className="vbrowser__archives-header">
                PUBLIC ARCHIVES ({archives.length})
              </div>
              <div className="vbrowser__archives">
                {archives.length === 0 && (
                  <div className="vbrowser__empty">no public archives in this vault.</div>
                )}
                {archives.map((a) => (
                  <button
                    key={a.id}
                    className="vbrowser__archive-card"
                    onClick={() => openArchive(a.archive_number)}
                  >
                    <div className="vbrowser__archive-num">#{a.archive_number}</div>
                    <div className="vbrowser__archive-title">{a.title}</div>
                    <div className="vbrowser__archive-dept">{a.department || '—'}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function VaultRow({ v, selected, onClick, badge, badgeColor, subtitle, tag }) {
  return (
    <button
      className={`vrow ${selected ? 'vrow--selected' : ''}`}
      onClick={onClick}
    >
      <div className="vrow__id">{v.vault_id}</div>
      <div className="vrow__name">{v.display_name}</div>
      <div className="vrow__meta">
        <span className="vrow__badge" style={{color: badgeColor, borderColor: badgeColor}}>{badge}</span>
        <span className="vrow__sub">{subtitle}</span>
        {tag && <span className="vrow__tag">{tag}</span>}
      </div>
    </button>
  )
}
