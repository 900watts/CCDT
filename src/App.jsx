import React, { useEffect, useRef, useState } from 'react'
import { supabase, isConfigured } from './supabaseClient'
import { runCommand, doLogin, CREATE_FIELDS, finalizeCreate, importFile } from './terminal/commands'
import { demoStore } from './store'

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
  // mode: normal | login-email | login-pass | wizard
  const [mode, setMode] = useState('normal')
  const [user, setUser] = useState(null)
  const [history, setHistory] = useState([])
  const [wizard, setWizard] = useState(null) // { idx, data }
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

  // boot + auth session restore
  useEffect(() => {
    append([
      { cls: 'ok', text: 'CCDT v0.3 — SECURE SESSION' },
      { cls: 'dim', text: 'type "help" for commands. "access <number>" to open a record.' }
    ])
    if (!isConfigured) {
      append([
        { cls: 'warn', text: 'DEMO MODE — Supabase not configured. Using sample data + fake auth.' },
        { cls: 'dim', text: 'Add VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY to a .env file to go live.' }
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

  const promptText = () => (user ? `operator@archive:~$` : `guest@archive:~$`)

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
    if (value.trim().toLowerCase() === 'login') {
      append([{ cls: 'echo', text: `${promptText()} login` }])
      setMode('login-email')
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
    if (Array.isArray(res)) {
      append(res)
    } else {
      append(res.lines || [])
      if (res.wizard) {
        setWizard(res.wizard)
        setMode('wizard')
        append([{ cls: 'promptline', text: CREATE_FIELDS[res.wizard.idx].prompt }])
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
        <span>CCDT</span>
        <span className={user ? 'ok' : 'warn'}>
          {user ? `SESSION: ${user.email}` : isConfigured ? 'SESSION: NONE' : 'DEMO MODE'}
        </span>
      </div>

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
          {mode === 'normal'
            ? promptText()
            : mode === 'login-email'
            ? 'EMAIL:'
            : mode === 'login-pass'
            ? 'PASSWORD:'
            : wizardPrompt()}
        </span>
        <input
          autoFocus
          value={input}
          type={mode === 'login-pass' ? 'password' : 'text'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            mode === 'normal'
              ? 'access 173  ·  create  ·  load'
              : mode === 'login-email'
              ? 'you@company.com'
              : mode === 'login-pass'
              ? '••••••••'
              : mode === 'wizard' && wizard
              ? CREATE_FIELDS[wizard.idx]?.prompt || ''
              : ''
          }
          spellCheck={false}
          autoComplete="off"
        />
      </form>

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
