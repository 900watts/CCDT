import React, { useEffect, useRef, useState } from 'react'
import { supabase, isConfigured } from './supabaseClient'
import { runCommand, doLogin, doRegister, doDeleteConfirm, fetchMessage, doMarkRead, CREATE_FIELDS, finalizeCreate, importFile } from './terminal/commands'
import { demoStore } from './store'
import { openDossierWindow } from './dossierWindow'
import { openInboxWindow, openComposeWindow, openMessageWindow } from './mailboxWindow'
import DatabaseView from './DatabaseView'

const CLASS_COLOR = {
  SECRET: 'var(--secret)',
  'TOP SECRET': 'var(--secret)',
  CONFIDENTIAL: 'var(--conf)',
  PUBLIC: 'var(--pub)'
}

let lineId = 0
const nextId = () => `L${lineId++}`

function Dossier({ data }) {
  const order = ['title', 'department', 'content', 'tags', 'created_at']
  const known = new Set(['archive_number', ...order, 'classification', 'id', 'updated_at'])
  const extra = Object.keys(data).filter((k) => !known.has(k) && data[k] != null)
  const fields = [...order.filter((k) => data[k] != null), ...extra]
  const cls = (data.classification || 'PUBLIC').toUpperCase()
  const color = CLASS_COLOR[cls] || 'var(--fg)'
  return (
    <div className="dossier">
      <div className="dossier__title">
        ARCHIVE {data.archive_number}
        <span className="dossier__tag" style={{ color }}>
          {cls}
        </span>
      </div>
      {fields.map((k) => (
        <div className="dossier__row" key={k}>
          <div className="dossier__key">{k}</div>
          <div className="dossier__val">{fmt(data[k])}</div>
        </div>
      ))}
    </div>
  )
}

function fmt(v) {
  if (v == null) return ''
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export default function App() {
  const [lines, setLines] = useState([])
  const [input, setInput] = useState('')
  // mode: normal | login-email | login-pass | wizard | confirm-delete
  const [mode, setMode] = useState('normal')
  const [user, setUser] = useState(null)
  const [history, setHistory] = useState([])
  const [wizard, setWizard] = useState(null) // { idx, data }
  const [view, setView] = useState('terminal') // terminal | database
  const [pendingDelete, setPendingDelete] = useState(null) // archive_number awaiting "I'm sure"
  const histIdx = useRef(-1)
  const pending = useRef({ email: '' })
  const screenRef = useRef(null)
  const fileInputRef = useRef(null)

  const append = (newLines) => {
    setLines((prev) => [
      ...prev,
      ...newLines.map((l) => (l.clear ? { clear: true, id: nextId() } : { ...l, id: nextId() }))
    ])
  }

  const ctx = () => ({ supabase, isConfigured, user, setUser, demoData: demoStore })

  // Format current time as "M/DD/YYYY, HH:MM:SS AM/PM"
  const accessTime = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const mo = d.getMonth() + 1
    const day = pad(d.getDate())
    const yr = d.getFullYear()
    let hh = d.getHours()
    const mm = pad(d.getMinutes())
    const ss = pad(d.getSeconds())
    const ap = hh >= 12 ? 'PM' : 'AM'
    hh = ((hh + 11) % 12) + 1
    return `${mo}/${day}/${yr}, ${pad(hh)}:${mm}:${ss} ${ap}`
  }

  // boot + auth session restore
  useEffect(() => {
    const sep = '─'.repeat(62)
    append([
      { cls: 'ok', text: `${sep}` },
      { cls: 'ok', text: `-------------------------- CCDT  V1.0 ---------------------------` },
      { cls: 'ok', text: '' },
      { cls: 'ok', text: 'SECURE, CONTAIN, PROTECT' },
      { cls: 'ok', text: 'Corporate Central Data Terminal' },
      { cls: 'ok', text: '' },
      { cls: 'dim', text: `Access Time: ${accessTime()}` },
      { cls: 'ok', text: '' },
      { cls: 'sys', text: "Enter 'help' for available commands or 'access' to quickly access files." },
      { cls: 'sys', text: "Example: 'access usernames' to access the usernames registry." },
      { cls: 'ok', text: `${sep}` }
    ])
    if (!isConfigured) {
      append([
        { cls: 'warn', text: 'DEMO MODE — Supabase not configured. Using sample data.' }
      ])
    } else if (supabase) {
      supabase.auth.getSession().then(({ data }) => {
        if (data.session?.user) setUser(data.session.user)
      })
      const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
        setUser(session?.user || null)
      })
      return () => sub.subscription.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight
  }, [lines])

  const promptText = () => {
    if (mode === 'login-email') return 'EMAIL:'
    if (mode === 'login-pass') return 'PASSWORD:'
    if (mode === 'register-email') return 'EMAIL:'
    if (mode === 'register-pass') return 'PASSWORD:'
    if (mode === 'register-level') return 'CLEARANCE [1-4]:'
    if (mode === 'register-username') return 'USERNAME:'
    if (mode === 'confirm-delete') return 'CONFIRM>'
    const name = user ? (user.email || 'admin').split('@')[0] : 'guest'
    return `${name}@CCDT:~$`
  }

  const wizardPrompt = () => {
    if (!wizard) return ''
    const step = CREATE_FIELDS[wizard.idx]
    return step ? `${step.prompt}:` : ''
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    const value = input
    setInput('')

    if (mode === 'login-email') {
      const email = value.trim()
      if (!email) {
        append([{ cls: 'err', text: 'EMAIL REQUIRED' }])
        return
      }
      pending.current.email = email
      setMode('login-pass')
      return
    }
    if (mode === 'login-pass') {
      const email = pending.current.email
      append([{ cls: 'echo', text: `EMAIL: ${email}` }, { cls: 'echo', text: 'PASSWORD: ********' }])
      const res = await doLogin(email, value, ctx())
      setMode('normal')
      append(res)
      return
    }

    // ----- guided register (bare `register`): email → password → clearance -----
    if (mode === 'register-email') {
      const email = value.trim()
      if (!email) {
        append([{ cls: 'err', text: 'EMAIL REQUIRED' }])
        return
      }
      pending.current.regEmail = email
      setMode('register-pass')
      return
    }
    if (mode === 'register-pass') {
      const pw = value
      if (!pw) {
        append([{ cls: 'err', text: 'PASSWORD REQUIRED' }])
        return
      }
      pending.current.regPass = pw
      append([{ cls: 'echo', text: `EMAIL: ${pending.current.regEmail}` }, { cls: 'echo', text: 'PASSWORD: ********' }])
      setMode('register-level')
      return
    }
    if (mode === 'register-level') {
      const email = pending.current.regEmail
      const pw = pending.current.regPass
      const lvl = value.trim()
      append([{ cls: 'echo', text: `CLEARANCE: ${lvl}` }])
      pending.current.regPass = ''
      // In live mode, ask for username next (so we can check uniqueness before
      // creating the auth user). DEMO mode skips this and finalises immediately.
      if (isConfigured) {
        pending.current.regLvl = lvl
        pending.current.regEmail = email
        pending.current.regPw = pw
        setMode('register-username')
        return
      }
      setMode('normal')
      pending.current.regEmail = ''
      const res = await doRegister([email, pw, lvl], ctx())
      append(res)
      return
    }
    if (mode === 'register-username') {
      const { regEmail: email, regPw: pw, regLvl: lvl } = pending.current
      const uname = value.trim()
      // peek_username_taken — runs in live mode only
      const { data: takenData } = await supabase.rpc('peek_username_taken', { p_username: uname })
      const taken = !!takenData
      if (!uname) {
        append([{ cls: 'err', text: 'USERNAME REQUIRED (or "skip")' }])
        return
      }
      if (uname.toLowerCase() === 'skip') {
        setMode('normal')
        pending.current.regEmail = ''
        pending.current.regPw = ''
        pending.current.regLvl = ''
        const res = await doRegister([email, pw, lvl], ctx())
        append(res)
        return
      }
      if (!/^[a-z0-9_-]{3,32}$/i.test(uname)) {
        append([{ cls: 'err', text: 'INVALID USERNAME — 3-32 chars, [a-z0-9_-] only' }])
        return
      }
      if (taken) {
        append([{ cls: 'err', text: `USERNAME "${uname}" ALREADY TAKEN — choose another (or "skip")` }])
        return
      }
      // Username is unique — proceed.
      setMode('normal')
      pending.current.regEmail = ''
      pending.current.regPw = ''
      pending.current.regLvl = ''
      const res = await doRegister([email, pw, lvl, uname], ctx())
      append(res)
      return
    }

    // ----- confirm-delete mode: operator must type "I'm sure" -----
    if (mode === 'confirm-delete' && pendingDelete) {
      const num = pendingDelete
      const typed = value.trim()
      append([{ cls: 'echo', text: `${promptText()} ${value}` }])
      setMode('normal')
      setPendingDelete(null)
      if (typed.toLowerCase() === "i'm sure") {
        const res = await doDeleteConfirm(num, ctx())
        append(res)
      } else {
        append([{ cls: 'dim', text: 'DELETE CANCELLED.' }])
      }
      return
    }

    // ----- wizard mode (create) -----
    if (mode === 'wizard' && wizard) {
      if (value.trim().toLowerCase() === 'cancel') {
        setWizard(null)
        setMode('normal')
        append([{ cls: 'dim', text: 'WIZARD CANCELLED.' }])
        return
      }
      const step = CREATE_FIELDS[wizard.idx]

      // multiline accumulation (content)
      if (step.multiline) {
        if (value === '') {
          // blank line finishes this step
          const nw = { ...wizard, idx: wizard.idx + 1 }
          if (nw.idx >= CREATE_FIELDS.length) {
            const res = await finalizeCreate(nw.data, ctx())
            append(res)
            setWizard(null)
            setMode('normal')
          } else {
            setWizard(nw)
            append([{ cls: 'promptline', text: CREATE_FIELDS[nw.idx].prompt }])
          }
          return
        }
        const data = { ...wizard.data, [step.key]: (wizard.data[step.key] ? wizard.data[step.key] + '\n' : '') + value }
        append([{ cls: 'echo', text: `${step.prompt}> ${value}` }])
        setWizard({ ...wizard, data })
        return
      }

      // normal single-line step
      if (step.validate) {
        const msg = step.validate(value)
        if (msg) {
          append([{ cls: 'err', text: msg }])
          return
        }
      }
      const data = { ...wizard.data, [step.key]: value }
      append([{ cls: 'echo', text: `${step.prompt}: ${value}` }])
      const nw = { ...wizard, data, idx: wizard.idx + 1 }
      if (nw.idx >= CREATE_FIELDS.length) {
        const res = await finalizeCreate(nw.data, ctx())
        append(res)
        setWizard(null)
        setMode('normal')
      } else {
        setWizard(nw)
        append([{ cls: 'promptline', text: CREATE_FIELDS[nw.idx].prompt }])
      }
      return
    }

    // ----- normal mode -----
    const trimmed = value.trim().toLowerCase()
    if (trimmed === 'database') {
      append([{ cls: 'echo', text: `${promptText()} ${value}` }])
      setView('database')
      return
    }
    if (trimmed === 'terminal') {
      append([{ cls: 'echo', text: `${promptText()} ${value}` }])
      setView('terminal')
      return
    }
    if (value.trim().toLowerCase() === 'login') {
      append([{ cls: 'echo', text: `${promptText()} login` }])
      setMode('login-email')
      return
    }
    // bare `register` -> guided prompts; `register em pw lvl` still works inline
    if (value.trim().toLowerCase() === 'register') {
      append([{ cls: 'echo', text: `${promptText()} register` }])
      setMode('register-email')
      return
    }
    if (value.trim().toLowerCase() === 'load' || value.trim().toLowerCase() === 'import') {
      append([{ cls: 'echo', text: `${promptText()} ${value.trim().toLowerCase()}` }])
      const res = await runCommand(value, ctx())
      append(res.lines)
      // open file dialog within the user gesture
      fileInputRef.current?.click()
      return
    }

    append([{ cls: 'echo', text: `${promptText()} ${value}` }])
    if (value.trim()) {
      setHistory((h) => [...h, value])
      histIdx.current = -1
    }
    const res = await runCommand(value, ctx())
    const arr = Array.isArray(res) ? res : res.lines || []

    // `clear` empties the screen instead of appending a marker.
    if (arr.some((l) => l.clear)) {
      setLines([])
      return
    }

    // "window" lines spawn a draggable viewer (WinBox); they are not printed.
    const windows = arr.filter((l) => l.cls === 'window')
    const printable = arr.filter((l) => l.cls !== 'window' && !l.clear)
    windows.forEach((w) => openDossierWindow(w.data))
    if (printable.length) append(printable)

    // wizard (create) — start guided multi-step flow
    if (!Array.isArray(res) && res.wizard) {
      setWizard(res.wizard)
      setMode('wizard')
      append([{ cls: 'promptline', text: CREATE_FIELDS[res.wizard.idx].prompt }])
    }

    // delete — enter confirm-delete mode, awaiting "I'm sure"
    if (!Array.isArray(res) && res.confirmDelete != null) {
      setPendingDelete(res.confirmDelete)
      setMode('confirm-delete')
    }

    // mail — spawn the mailbox / compose / single-message window
    if (!Array.isArray(res)) {
      const liveCtx = ctx()
      if (res.openCompose) openComposeWindow(liveCtx)
      if (res.openMailbox) {
        if (res.openMsgId) {
          const m = await fetchMessage(res.openMsgId, liveCtx)
          if (m) {
            await doMarkRead(res.openMsgId, liveCtx)
            openMessageWindow(m, liveCtx)
          } else {
            append([{ cls: 'err', text: `MESSAGE ${res.openMsgId} NOT FOUND / NOT VISIBLE` }])
          }
        } else {
          openInboxWindow(liveCtx, (m) => openMessageWindow(m, liveCtx))
        }
      }
    }
  }

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    append([{ cls: 'dim', text: `importing ${file.name} …` }])
    const res = await importFile(file, ctx())
    append(res)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!history.length) return
      histIdx.current = histIdx.current < 0 ? history.length - 1 : Math.max(0, histIdx.current - 1)
      setInput(history[histIdx.current])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx.current < 0) return
      histIdx.current += 1
      if (histIdx.current >= history.length) {
        histIdx.current = -1
        setInput('')
      } else setInput(history[histIdx.current])
    }
  }

  const rendered = lines.filter((l) => !l.clear)

  return (
    <div className="terminal">
      <div className="terminal__bar">
        <div className="tabs">
          <button
            className={`tab${view === 'terminal' ? ' tab--active' : ''}`}
            onClick={() => setView('terminal')}
          >
            TERMINAL
          </button>
          <button
            className={`tab${view === 'database' ? ' tab--active' : ''}`}
            onClick={() => setView('database')}
          >
            DATABASE
          </button>
        </div>
        <span className={user ? 'ok' : 'warn'}>
          {user ? `SESSION: ${user.email}` : isConfigured ? 'SESSION: NONE' : 'DEMO MODE'}
        </span>
      </div>

      <div className="terminal__main" style={{ display: view === 'terminal' ? 'flex' : 'none' }}>
        <div className="terminal__screen" ref={screenRef}>
          {rendered.map((l) =>
            l.cls === 'dossier' ? (
              <Dossier key={l.id} data={l.data} />
            ) : (
              <div key={l.id} className={`line ${l.cls || 'sys'}`}>
                {l.text}
              </div>
            )
          )}
        </div>

        <form className="terminal__input" onSubmit={onSubmit}>
          <span className="prompt">
            {mode === 'wizard' && wizard
              ? wizardPrompt()
              : promptText()}
          </span>
          <input
            autoFocus
            value={input}
            type={mode === 'login-pass' || mode === 'register-pass' ? 'password' : 'text'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          placeholder={
            mode === 'normal'
              ? "access 173  ·  database  ·  create  ·  help"
              : mode === 'login-email' || mode === 'register-email'
              ? 'email (or username if you have one)'
              : mode === 'login-pass' || mode === 'register-pass'
              ? '••••••••'
              : mode === 'register-level'
              ? '1 (PUBLIC) · 2 (CONFIDENTIAL) · 3 (SECRET) · 4 (TOP SECRET)'
              : mode === 'register-username'
              ? '3-32 chars [a-z0-9_-] — or "skip" to leave empty'
              : mode === 'confirm-delete'
              ? "type \"I'm sure\" to confirm, or anything else to cancel"
              : mode === 'wizard' && wizard
              ? CREATE_FIELDS[wizard.idx]?.prompt || ''
              : ''
          }
            spellCheck={false}
            autoComplete="off"
          />
        </form>
      </div>

      {view === 'database' && <DatabaseView user={user} />}

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.txt,.md"
        style={{ display: 'none' }}
        onChange={onFile}
      />
    </div>
  )
}
