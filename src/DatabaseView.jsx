import React, { useCallback, useEffect, useState } from 'react'
import { supabase, isConfigured } from './supabaseClient'
import { demoStore } from './store'
import { fetchList, fetchOne, getClearance } from './terminal/commands'
import { openDossierWindow } from './dossierWindow'

const CLASS_COLOR = {
  SECRET: '#ff4d6d',
  'TOP SECRET': '#ff4d6d',
  CONFIDENTIAL: '#ffd166',
  PUBLIC: '#38ff9a'
}

export default function DatabaseView({ user }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')

  const ctx = () => ({ supabase, isConfigured, user, demoData: demoStore })

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchList(ctx())
      setRows(r)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    load()
  }, [load])

  const open = async (num) => {
    const res = await fetchOne(num, ctx())
    if (res.ok) {
      openDossierWindow(res.data)
    } else if (res.reason === 'not_found') {
      setError(`ARCHIVE ${num} NOT FOUND`)
    } else if (res.reason === 'denied') {
      setError(`CLEARANCE INSUFFICIENT for ARCHIVE ${num}`)
    } else {
      setError(res.reason)
    }
  }

  const filtered = q.trim()
    ? rows.filter((r) => {
        const s = `${r.archive_number} ${r.title} ${r.department || ''}`.toLowerCase()
        return s.includes(q.trim().toLowerCase())
      })
    : rows

  const myLevel = getClearance(ctx())

  return (
    <div className="dbview">
      <div className="dbview__toolbar">
        <span className="dbview__title">DATABASE</span>
        <span className="dbview__count">{filtered.length} record{filtered.length === 1 ? '' : 's'}</span>
        <span className="dbview__clr">clearance {myLevel}</span>
        <input
          className="dbview__search"
          placeholder="filter…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
        <button className="dbview__btn" onClick={load} title="refresh">⟳</button>
      </div>

      {error && <div className="dbview__err">{error}</div>}

      <div className="dbview__grid">
        {loading && <div className="dbview__empty">loading…</div>}
        {!loading && !filtered.length && (
          <div className="dbview__empty">
            {isConfigured
              ? user
                ? 'no readable archives. (did you apply schema.sql?)'
                : 'not authenticated — run login in the terminal.'
              : 'no demo archives.'}
          </div>
        )}
        {filtered.map((r) => {
          const cls = (r.classification || 'PUBLIC').toUpperCase()
          const color = CLASS_COLOR[cls] || '#38ff9a'
          return (
            <button
              key={r.archive_number}
              className="dbcard"
              onClick={() => open(r.archive_number)}
            >
              <div className="dbcard__top">
                <span className="dbcard__num">#{r.archive_number}</span>
                <span className="dbcard__cls" style={{ color, borderColor: color }}>{cls}</span>
              </div>
              <div className="dbcard__title">{r.title}</div>
              <div className="dbcard__dept">{r.department || '—'}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}