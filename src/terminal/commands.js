// Terminal command logic. Each handler returns either:
//   - an array of "lines"   (normal commands)
//   - { lines, wizard }     (start an interactive multi-step wizard, e.g. create)
//   - { lines, needFile }   (App should open a file picker, e.g. load)
//
// A line is: { cls, text } | { clear: true } | { cls: 'dossier', data }

import { addDemoArchive } from '../store'

const DEMO_USER = { id: 'demo-agent', email: 'agent@archive.local' }

const CLASSIFICATIONS = ['PUBLIC', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']

// Clearance model: each classification maps to the minimum clearance level an
// operator must hold to READ it. 1 = PUBLIC … 4 = TOP SECRET.
// This is the real enforcement that was missing before — a level-2 operator can
// no longer open a level-4 (TOP SECRET) document.
const CLEARANCE_LEVEL = { PUBLIC: 1, CONFIDENTIAL: 2, SECRET: 3, 'TOP SECRET': 4 }
const MAX_CLEARANCE = 4

function requiredLevel(rec) {
  return CLEARANCE_LEVEL[String((rec && rec.classification) || '').toUpperCase()] || 1
}

// The operator's current clearance level (defaults to 1 / PUBLIC when unset).
function getClearance(ctx) {
  const raw = ctx.user && (ctx.user.clearance_level ?? ctx.user.user_metadata?.clearance_level)
  const lvl = Number(raw)
  return Number.isFinite(lvl) && lvl > 0 ? Math.min(lvl, MAX_CLEARANCE) : 1
}

const HELP = [
  { cls: 'ok', text: 'AVAILABLE COMMANDS' },
  { cls: 'dim', text: '  access <number>   retrieve an archive record by its number' },
  { cls: 'dim', text: '  list [n]          list the n most recent archives (default 10)' },
  { cls: 'dim', text: '  search <query>    search archives by title / content' },
  { cls: 'dim', text: '  create            create a new archive document (guided)' },
  { cls: 'dim', text: '  load              import a document from a file (.json/.txt/.md)' },
  { cls: 'dim', text: '  login [email pw]  authenticate (prompts if no args given)' },
  { cls: 'dim', text: '  register <em> <pw> <lvl>  create an operator account (clearance 1-4)' },
  { cls: 'dim', text: '  logout            end the current session' },
  { cls: 'dim', text: '  whoami            show the current operator + clearance level' },
  { cls: 'dim', text: '  about             what this terminal is' },
  { cls: 'dim', text: '  clear             clear the screen' },
  { cls: 'dim', text: '  help             show this list' }
]

// Guided "create" wizard field definitions. `multiline` steps accumulate lines
// until a blank line is submitted. `validate` returns an error string or null.
export const CREATE_FIELDS = [
  {
    key: 'archive_number',
    prompt: 'ARCHIVE NUMBER',
    validate: (v) => (v.trim() ? null : 'NUMBER REQUIRED')
  },
  {
    key: 'title',
    prompt: 'TITLE',
    validate: (v) => (v.trim() ? null : 'TITLE REQUIRED')
  },
  {
    key: 'classification',
    prompt: 'CLASSIFICATION [PUBLIC/CONFIDENTIAL/SECRET/TOP SECRET]',
    default: 'PUBLIC',
    validate: (v) =>
      CLASSIFICATIONS.includes(v.trim().toUpperCase()) ? null : 'INVALID — use PUBLIC/CONFIDENTIAL/SECRET/TOP SECRET'
  },
  { key: 'department', prompt: 'DEPARTMENT' },
  { key: 'content', prompt: 'CONTENT (type, blank line to finish)', multiline: true },
  { key: 'tags', prompt: 'TAGS (comma separated, optional)' }
]

function authGuard(ctx) {
  if (!ctx.user) {
    return [{ cls: 'err', text: 'ACCESS DENIED — authentication required. run: login' }]
  }
  return null
}

function dossierLines(row) {
  return [
    { cls: 'ok', text: `ACCESS GRANTED // ARCHIVE ${row.archive_number}` },
    { cls: 'dossier', data: row }
  ]
}

function deniedLines(num, rec, have) {
  return [
    { cls: 'err', text: `CLEARANCE INSUFFICIENT // ARCHIVE ${num}` },
    { cls: 'dim', text: `requires level ${requiredLevel(rec)} (${rec.classification}); you hold level ${have}.` }
  ]
}

// Turn raw wizard/file input into a normalized record ready to insert.
function normalize(raw) {
  const tagsRaw = raw.tags
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.map((t) => String(t).trim()).filter(Boolean)
    : String(tagsRaw || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
  return {
    archive_number: String(raw.archive_number || '').trim(),
    title: String(raw.title || '').trim(),
    classification: String(raw.classification || 'PUBLIC').trim().toUpperCase(),
    department: String(raw.department || '').trim(),
    content: String(raw.content || '').trim(),
    tags
  }
}

async function insertRecord(record, ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase
      .from('archives')
      .insert(record)
      .select()
      .single()
    if (error) return [{ cls: 'err', text: `WRITE FAILED: ${error.message}` }]
    return [
      { cls: 'ok', text: `DOCUMENT COMMITTED // ARCHIVE ${data.archive_number}` },
      { cls: 'dim', text: 'persisted to Supabase (archives table).' }
    ]
  }
  addDemoArchive(record)
  return [
    { cls: 'ok', text: `DOCUMENT COMMITTED (DEMO) // ARCHIVE ${record.archive_number}` },
    { cls: 'dim', text: 'stored in local session only — connect Supabase to persist.' }
  ]
}

async function access(args, ctx) {
  const guard = authGuard(ctx)
  if (guard) return guard
  const num = args[0]
  if (!num) return [{ cls: 'warn', text: 'usage: access <number>' }]

  if (ctx.isConfigured) {
    // RPC does the clearance check server-side and returns a precise status,
    // so we can show "NOT FOUND" vs "CLEARANCE INSUFFICIENT" distinctly.
    const { data, error } = await ctx.supabase.rpc('access_archive', { p_num: num })
    if (error) return [{ cls: 'err', text: `QUERY ERROR: ${error.message}` }]
    if (!data || data.status === 'not_found') return [{ cls: 'err', text: `ARCHIVE ${num} NOT FOUND` }]
    if (data.status === 'denied') {
      return [
        { cls: 'err', text: `CLEARANCE INSUFFICIENT // ARCHIVE ${num}` },
        {
          cls: 'dim',
          text: `requires level ${data.required} (${data.classification}); you hold level ${data.have}.`
        }
      ]
    }
    return dossierLines(data.data)
  }

  const row = ctx.demoData.find((a) => a.archive_number === num)
  if (!row) return [{ cls: 'err', text: `ARCHIVE ${num} NOT FOUND` }]
  const have = getClearance(ctx)
  if (requiredLevel(row) > have) return deniedLines(num, row, have)
  return dossierLines(row)
}

async function list(args, ctx) {
  const guard = authGuard(ctx)
  if (guard) return guard
  const limit = Math.min(parseInt(args[0], 10) || 10, 100)

  let rows = []
  if (ctx.isConfigured) {
    // RLS policy "archives_read_clearance" already filters to readable rows.
    const { data, error } = await ctx.supabase
      .from('archives')
      .select('archive_number,title,classification,department')
      .order('archive_number', { ascending: true })
      .limit(limit)
    if (error) return [{ cls: 'err', text: `QUERY ERROR: ${error.message}` }]
    rows = data || []
  } else {
    // DEMO: enforce clearance client-side to match live behaviour.
    rows = ctx.demoData
      .filter((a) => requiredLevel(a) <= getClearance(ctx))
      .slice(0, limit)
  }
  if (!rows.length) return [{ cls: 'dim', text: 'NO ARCHIVES.' }]
  const out = [{ cls: 'ok', text: `ARCHIVE INDEX (${rows.length})` }]
  for (const r of rows) {
    out.push({
      cls: 'sys',
      text: `  [${r.archive_number}] (${r.classification || 'PUBLIC'}) ${r.title}` +
        (r.department ? ` — ${r.department}` : '')
    })
  }
  return out
}

async function search(args, ctx) {
  const guard = authGuard(ctx)
  if (guard) return guard
  const q = args.join(' ').trim()
  if (!q) return [{ cls: 'warn', text: 'usage: search <query>' }]

  let rows = []
  if (ctx.isConfigured) {
    // RLS policy filters to readable rows before the search runs.
    const { data, error } = await ctx.supabase
      .from('archives')
      .select('archive_number,title,classification')
      .or(`title.ilike.%${q}%,content.ilike.%${q}%`)
      .limit(25)
    if (error) return [{ cls: 'err', text: `QUERY ERROR: ${error.message}` }]
    rows = data || []
  } else {
    const lq = q.toLowerCase()
    rows = ctx.demoData.filter(
      (a) =>
        requiredLevel(a) <= getClearance(ctx) &&
        ((a.title || '').toLowerCase().includes(lq) || (a.content || '').toLowerCase().includes(lq))
    )
  }
  if (!rows.length) return [{ cls: 'dim', text: 'NO MATCHES.' }]
  const out = [{ cls: 'ok', text: `SEARCH RESULTS (${rows.length})` }]
  for (const r of rows) {
    out.push({ cls: 'sys', text: `  [${r.archive_number}] ${r.title}` })
  }
  return out
}

export async function doLogin(email, password, ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.auth.signInWithPassword({
      email,
      password
    })
    if (error) return [{ cls: 'err', text: `LOGIN FAILED: ${error.message}` }]
    ctx.setUser(data.user)
    return [{ cls: 'ok', text: `AUTH OK // session established for ${data.user.email}` }]
  }
  if (!email || !password) return [{ cls: 'err', text: 'LOGIN FAILED: need email + password' }]
  // DEMO login gets full clearance so the demo can read everything by default.
  ctx.setUser({ ...DEMO_USER, email, clearance_level: MAX_CLEARANCE })
  return [{ cls: 'ok', text: `AUTH OK (DEMO) // session established for ${email}` }]
}

export async function doRegister(args, ctx) {
  const [email, password, lvlArg] = args
  if (!email || !password || !lvlArg) {
    return [{ cls: 'warn', text: 'usage: register <email> <password> <clearance 1-4>' }]
  }
  const level = Math.max(1, Math.min(MAX_CLEARANCE, parseInt(lvlArg, 10) || 1))
  if (ctx.isConfigured) {
    // clearance_level is stored in the auth user's metadata; the RLS policy and
    // the access_archive() RPC read it from there.
    const { data, error } = await ctx.supabase.auth.signUp({
      email,
      password,
      options: { data: { clearance_level: level } }
    })
    if (error) return [{ cls: 'err', text: `REGISTER FAILED: ${error.message}` }]
    if (data.session) ctx.setUser(data.user)
    return [
      { cls: 'ok', text: `REGISTRATION OK // ${email} (clearance level ${level})` },
      {
        cls: 'dim',
        text: data.session
          ? 'session established — you may now access archives.'
          : 'confirm your email, then run: login'
      }
    ]
  }
  ctx.setUser({ ...DEMO_USER, email, clearance_level: level })
  return [{ cls: 'ok', text: `REGISTRATION OK (DEMO) // ${email} (clearance level ${level})` }]
}

export async function doLogout(ctx) {
  if (ctx.isConfigured) {
    const { error } = await ctx.supabase.auth.signOut()
    if (error) return [{ cls: 'err', text: `LOGOUT FAILED: ${error.message}` }]
  }
  ctx.setUser(null)
  return [{ cls: 'ok', text: 'SESSION TERMINATED.' }]
}

// Finalize a "create" wizard: build + insert the record.
export async function finalizeCreate(data, ctx) {
  const guard = authGuard(ctx)
  if (guard) return guard
  const record = normalize(data)
  if (!record.archive_number || !record.title) {
    return [{ cls: 'err', text: 'CREATE ABORTED — number and title are required.' }]
  }
  return insertRecord(record, ctx)
}

function stem(name) {
  return name.replace(/\.[^.]+$/, '')
}

// Import a file (.json / .txt / .md) as a new archive document.
export async function importFile(file, ctx) {
  const guard = authGuard(ctx)
  if (guard) return guard
  const name = file.name || 'document'
  let text
  try {
    text = await file.text()
  } catch (e) {
    return [{ cls: 'err', text: `READ ERROR: ${e.message}` }]
  }

  let raw
  if (name.toLowerCase().endsWith('.json')) {
    try {
      const j = JSON.parse(text)
      raw = {
        archive_number: j.archive_number || stem(name),
        title: j.title || stem(name),
        classification: j.classification || 'PUBLIC',
        department: j.department || '',
        content: j.content || '',
        tags: j.tags || []
      }
    } catch (e) {
      return [{ cls: 'err', text: `JSON PARSE ERROR: ${e.message}` }]
    }
  } else {
    raw = {
      archive_number: stem(name),
      title: stem(name).replace(/[-_]/g, ' '),
      classification: 'PUBLIC',
      department: '',
      content: text,
      tags: []
    }
  }
  // Ensure archive_number is never empty
  if (!String(raw.archive_number).trim()) raw.archive_number = stem(name)
  return insertRecord(normalize(raw), ctx)
}

export async function runCommand(raw, ctx) {
  const input = (raw || '').trim()
  if (!input) return []
  const parts = input.split(/\s+/)
  const name = parts[0].toLowerCase()
  const args = parts.slice(1)

  switch (name) {
    case 'help':
      return HELP
    case 'access':
      return access(args, ctx)
    case 'list':
      return list(args, ctx)
    case 'search':
      return search(args, ctx)
    case 'create':
      return {
        lines: [
          { cls: 'ok', text: 'NEW DOCUMENT WIZARD — answer each prompt.' },
          { cls: 'dim', text: 'type "cancel" at any prompt to abort.' }
        ],
        wizard: { idx: 0, data: {} }
      }
    case 'load':
    case 'import':
      return {
        lines: [
          { cls: 'ok', text: 'IMPORT DOCUMENT — choose a file in the dialog.' },
          { cls: 'dim', text: '.json uses its fields; .txt/.md uses the filename as title.' }
        ],
        needFile: true
      }
    case 'login':
      return doLogin(args[0], args[1], ctx)
    case 'register':
      return doRegister(args, ctx)
    case 'logout':
      return doLogout(ctx)
    case 'whoami':
      if (!ctx.user) return [{ cls: 'dim', text: 'not authenticated.' }]
      return [
        { cls: 'sys', text: `operator: ${ctx.user.email} (${ctx.user.id})` },
        { cls: 'dim', text: `clearance level: ${getClearance(ctx)}` }
      ]
    case 'about':
      return [
        { cls: 'ok', text: 'CCDT — CORPORATE CENTRAL DATA TERMINAL' },
        {
          cls: 'dim',
          text: 'A company document archive, accessed the CCDT way: type a number, get the dossier.'
        },
        {
          cls: 'dim',
          text: 'Documents are gated by clearance level: 1 PUBLIC, 2 CONFIDENTIAL, 3 SECRET, 4 TOP SECRET.'
        },
        { cls: 'dim', text: 'Backend: Supabase (Auth + Postgres). Type "help" for commands.' }
      ]
    case 'clear':
      return [{ clear: true }]
    default:
      return [{ cls: 'err', text: `command not found: ${parts[0]}. type "help".` }]
  }
}
