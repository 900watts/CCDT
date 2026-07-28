// Terminal command logic. Each handler returns either:
//   - an array of "lines"   (normal commands)
//   - { lines, wizard }     (start an interactive multi-step wizard, e.g. create)
//   - { lines, needFile }   (App should open a file picker, e.g. load)
//
// A line is: { cls, text } | { clear: true } | { cls: 'dossier', data }

import {
  addDemoArchive, removeDemoArchive, updateDemoArchive,
  demoUsernameTaken, demoRegisterUsername, demoLookupByUsername,
  demoUsernames, demoMessages,
  demoAddMessage, demoMarkRead
} from '../store'

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
export function getClearance(ctx) {
  if (!ctx || !ctx.user) return 1
  const u = ctx.user
  // Supabase stores signUp({ options: { data } }) into user_metadata, but
  // auth.admin.createUser and some flows write to app_metadata. Probe both
  // plus the rare top-level placement, in priority order.
  const raw =
    u.clearance_level ??
    u.user_metadata?.clearance_level ??
    u.app_metadata?.clearance_level
  const lvl = Number(raw)
  return Number.isFinite(lvl) && lvl > 0 ? Math.min(lvl, MAX_CLEARANCE) : 1
}

// Username validation: 3-32 chars, [a-z0-9_-], case-insensitive stored.
export function validUsername(u) {
  const s = String(u || '')
  return s.length >= 3 && s.length <= 32 && /^[a-z0-9_-]+$/i.test(s)
}

// Resolve a login input (email or username) -> email. Live mode looks up via
// peek_user_by_username RPC; DEMO mode uses the in-memory registry.
export async function resolveLogin(input, ctx) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const looksLikeEmail = raw.includes('@') && raw.indexOf('@') > 0 && raw.indexOf('@') < raw.length - 1
  if (looksLikeEmail) return raw
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_user_by_username', { p_username: raw })
    if (error || !data) return null
    return data.email
  }
  const hit = demoLookupByUsername(raw)
  return hit ? hit.email : null
}

// Claim a username for the current operator. Returns { ok, taken, reason }.
export async function claimUsername(username, ctx) {
  const u = String(username || '').trim()
  if (!validUsername(u)) return { ok: false, reason: 'invalid_format' }
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_register_username', { p_username: u })
    if (error) return { ok: false, reason: error.message }
    if (data?.status === 'taken') return { ok: false, reason: 'taken', username: data.username }
    return { ok: true, username: data?.username || u.toLowerCase() }
  }
  if (demoUsernameTaken(u)) return { ok: false, reason: 'taken' }
  demoRegisterUsername(ctx.user?.id || DEMO_USER.id, ctx.user?.email || '', u)
  return { ok: true, username: u.toLowerCase() }
}

const HELP = [
  { cls: 'ok', text: '═══════════════ CCDT COMMAND REFERENCE ═══════════════' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ ACCESS' },
  { cls: 'sys',  text: '  access <number>       open archive #<number> in a viewer window' },
  { cls: 'dim',  text: '      e.g. access 173   ·  access usernames' },
  { cls: 'sys',  text: '  list [n]              list the n most recent archives (default 10)' },
  { cls: 'sys',  text: '  search <query>        full-text search across title + content' },
  { cls: 'dim',  text: '      e.g. search payroll · search "q3 report"' },
  { cls: 'sys',  text: '  delete <number>       delete an archive (must be yours or clearance >= its level)' },
  { cls: 'dim',  text: '      asks you to type "I\'m sure" before removing the record' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ AUTHORING' },
  { cls: 'sys',  text: '  create [num "title"]   open the document editor (Word-style window with photos)' },
  { cls: 'dim',  text: '      fill the form, type Markdown, drag photos or use 📷 PHOTO' },
  { cls: 'sys',  text: '  edit <number>          open an existing archive in the editor to modify + save' },
  { cls: 'dim',  text: '      you must have access (clearance) to the record you edit' },
  { cls: 'sys',  text: '  load                  import a document from a file (.json/.txt/.md)' },
  { cls: 'dim',  text: '      .json maps fields · .txt/.md use filename as title + body as content' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ SESSION' },
  { cls: 'sys',  text: '  login [email pw]      authenticate (prompts if no args given)' },
  { cls: 'sys',  text: '  register              create an operator account (guided: email, password, clearance)' },
  { cls: 'dim',  text: '      or inline: register me@corp.com hunter2 3   (clearance 1-4)' },
  { cls: 'sys',  text: '  logout                end the current session' },
  { cls: 'sys',  text: '  whoami                show current operator + clearance level' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ NAVIGATION' },
  { cls: 'sys',  text: '  database              switch to the visual DATABASE browser' },
  { cls: 'sys',  text: '  terminal              switch back to the terminal' },
  { cls: 'sys',  text: '  mail [sub]            open the mailbox window (sub: inbox, sent, send)' },
  { cls: 'dim',  text: '      bare `mail` shows inbox+sent · `mail send` opens the composer · `mail <id>` opens a message' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ SYSTEM' },
  { cls: 'sys',  text: '  about                 what this terminal is' },
  { cls: 'sys',  text: '  clear                 clear the screen' },
  { cls: 'sys',  text: '  help                  show this reference' },
  { cls: 'dim', text: '' },
  { cls: 'dim', text: '  clearance levels: 1 PUBLIC · 2 CONFIDENTIAL · 3 SECRET · 4 TOP SECRET' },
  { cls: 'dim', text: '  tip: ↑/↓ scroll command history · blank line finishes multi-line input' }
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
    { cls: 'ok', text: `ACCESS GRANTED // ARCHIVE ${row.archive_number} — opening viewer window…` },
    { cls: 'window', data: row }
  ]
}

// Used by the DATABASE tab to fetch the readable archive list (RLS filters
// live mode; DEMO mode filters client-side by clearance).
export async function fetchList(ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase
      .from('archives')
      .select('archive_number,title,classification,department,created_at')
      .order('archive_number', { ascending: true })
      .limit(200)
    if (error) return []
    return data || []
  }
  return ctx.demoData
    .filter((a) => requiredLevel(a) <= getClearance(ctx))
    .map((a) => ({
      archive_number: a.archive_number,
      title: a.title,
      classification: a.classification,
      department: a.department,
      created_at: a.created_at
    }))
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
    tags,
    photos: Array.isArray(raw.photos) ? raw.photos : []
  }
}

export async function insertRecord(record, ctx) {
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

// Update an existing archive. `originalNumber` is the lookup key (the
// archive_number may have been changed in the editor form). Clearance/auth is
// already enforced by the caller (edit command) before this is reached.
export async function updateRecord(record, originalNumber, ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase
      .from('archives')
      .update(record)
      .eq('archive_number', String(originalNumber))
      .select()
      .single()
    if (error) return [{ cls: 'err', text: `UPDATE FAILED: ${error.message}` }]
    return [
      { cls: 'ok', text: `DOCUMENT UPDATED // ARCHIVE ${data.archive_number}` },
      { cls: 'dim', text: 'changes persisted to Supabase (archives table).' }
    ]
  }
  updateDemoArchive(originalNumber, record)
  return [
    { cls: 'ok', text: `DOCUMENT UPDATED (DEMO) // ARCHIVE ${record.archive_number}` },
    { cls: 'dim', text: 'updated in local session only — connect Supabase to persist.' }
  ]
}

// Fetch a single full archive record (clearance-respecting). Used by the
// DATABASE tab when a card is clicked. Returns { ok, data, reason }.
export async function fetchOne(num, ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase
      .from('archives')
      .select('*')
      .eq('archive_number', String(num))
      .maybeSingle()
    if (error) return { ok: false, reason: error.message }
    if (!data) return { ok: false, reason: 'not_found' }
    return { ok: true, data }
  }
  const row = ctx.demoData.find((a) => a.archive_number === String(num))
  if (!row) return { ok: false, reason: 'not_found' }
  if (requiredLevel(row) > getClearance(ctx)) return { ok: false, reason: 'denied' }
  return { ok: true, data: row }
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

export async function doLogin(emailOrUsername, password, ctx) {
  if (!emailOrUsername || !password) return [{ cls: 'err', text: 'LOGIN FAILED: need email/username + password' }]
  const resolved = await resolveLogin(emailOrUsername, ctx)
  if (!resolved) return [{ cls: 'err', text: `LOGIN FAILED: no user with that email or username` }]
  const email = resolved
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
  // inline: <email> <password> <lvl> [username]
  const [email, password, lvlArg, usernameArg] = args
  if (!email || !password || !lvlArg) {
    return [{ cls: 'warn', text: 'usage: register <email> <password> <clearance 1-4> [username]' }]
  }
  const level = Math.max(1, Math.min(MAX_CLEARANCE, parseInt(lvlArg, 10) || 1))
  const wantsUsername = usernameArg ? String(usernameArg).trim() : ''
  if (wantsUsername && !validUsername(wantsUsername)) {
    return [{ cls: 'err', text: `REGISTER FAILED: username "${wantsUsername}" must be 3-32 chars, [a-z0-9_-]` }]
  }
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
    const out = [
      { cls: 'ok', text: `REGISTRATION OK // ${email} (clearance level ${level})` }
    ]
    if (wantsUsername && data.session?.user) {
      const claim = await claimUsername(wantsUsername, ctx)
      if (!claim.ok) {
        out.push({ cls: 'err', text: `REGISTER OK but username "${wantsUsername}" is ${claim.reason || 'unavailable'}. claim it later via: mail` })
      } else {
        out.push({ cls: 'dim', text: `username claimed: ${claim.username}` })
      }
    }
    out.push({
      cls: 'dim',
      text: data.session
        ? 'session established — you may now access archives.'
        : 'confirm your email, then run: login'
    })
    return out
  }
  // DEMO mode
  if (wantsUsername && demoUsernameTaken(wantsUsername)) {
    return [{ cls: 'err', text: `REGISTER FAILED: username "${wantsUsername}" is already taken.` }]
  }
  const user = { ...DEMO_USER, email, clearance_level: level, username: wantsUsername ? wantsUsername.toLowerCase() : '' }
  ctx.setUser(user)
  if (wantsUsername) demoRegisterUsername(user.id, email, wantsUsername)
  const out = [{ cls: 'ok', text: `REGISTRATION OK (DEMO) // ${email} (clearance level ${level})` }]
  if (wantsUsername) out.push({ cls: 'dim', text: `username claimed: ${wantsUsername.toLowerCase()}` })
  return out
}

export async function doLogout(ctx) {
  if (ctx.isConfigured) {
    const { error } = await ctx.supabase.auth.signOut()
    if (error) return [{ cls: 'err', text: `LOGOUT FAILED: ${error.message}` }]
  }
  ctx.setUser(null)
  return [{ cls: 'ok', text: 'SESSION TERMINATED.' }]
}

// delete <num> — check eligibility (you created it OR your clearance >= the
// record's required clearance) and, if allowed, ask the operator to type
// "I'm sure" before the row is removed.
export async function doDelete(args, ctx) {
  const guard = authGuard(ctx)
  if (guard) return guard
  const num = args[0]
  if (!num) return [{ cls: 'warn', text: 'usage: delete <number>' }]

  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_delete', { p_num: num })
    if (error) return [{ cls: 'err', text: `QUERY ERROR: ${error.message}` }]
    if (!data || data.status === 'not_found')
      return [{ cls: 'err', text: `ARCHIVE ${num} NOT FOUND` }]
    if (data.status === 'denied') {
      return [
        { cls: 'err', text: `DELETE DENIED // ARCHIVE ${num}` },
        {
          cls: 'dim',
          text: `requires level ${data.required} (${data.classification}) or ownership; you hold level ${data.have}.`
        }
      ]
    }
    const mine = data.created_by_me ? '(created by you)' : '(clearance override)'
    return {
      lines: [
        { cls: 'warn', text: `DELETE ARCHIVE ${num} — ${data.title} [${data.classification}] ${mine}` },
        { cls: 'dim', text: `this is permanent. type "I'm sure" to confirm, or anything else to cancel.` }
      ],
      confirmDelete: num
    }
  }

  // DEMO: authorize by clearance only (demo records have no creator tracking).
  const row = ctx.demoData.find((a) => a.archive_number === String(num))
  if (!row) return [{ cls: 'err', text: `ARCHIVE ${num} NOT FOUND` }]
  const have = getClearance(ctx)
  if (requiredLevel(row) > have) {
    return [
      { cls: 'err', text: `DELETE DENIED // ARCHIVE ${num}` },
      { cls: 'dim', text: `requires level ${requiredLevel(row)} (${row.classification}); you hold level ${have}.` }
    ]
  }
  return {
    lines: [
      { cls: 'warn', text: `DELETE ARCHIVE ${num} — ${row.title} [${row.classification}]` },
      { cls: 'dim', text: `this is permanent. type "I'm sure" to confirm, or anything else to cancel.` }
    ],
    confirmDelete: num
  }
}

// Called after the operator types "I'm sure".
export async function doDeleteConfirm(num, ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('delete_archive', { p_num: num })
    if (error) return [{ cls: 'err', text: `DELETE FAILED: ${error.message}` }]
    if (!data || data.status === 'not_found')
      return [{ cls: 'err', text: `ARCHIVE ${num} NOT FOUND (already gone?)` }]
    if (data.status === 'denied')
      return [{ cls: 'err', text: `DELETE DENIED // ARCHIVE ${num} — eligibility changed.` }]
    return [{ cls: 'ok', text: `ARCHIVE ${num} DELETED — "${data.title}" removed.` }]
  }
  const ok = removeDemoArchive(num)
  return ok
    ? [{ cls: 'ok', text: `ARCHIVE ${num} DELETED (DEMO).` }]
    : [{ cls: 'err', text: `ARCHIVE ${num} NOT FOUND` }]
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

// ──────────────────────────────────────────────────────────────────────────
// Mailbox — handlers. The actual windows are opened by App via the
// { openMailbox, openMessageWindow } markers in the returned result.
// ──────────────────────────────────────────────────────────────────────────

async function getMyUsername(ctx) {
  if (ctx.isConfigured) {
    const { data } = await ctx.supabase.from('users').select('username').eq('id', ctx.user.id).maybeSingle()
    return data?.username || ''
  }
  // DEMO: lookup by email (DEMO users share the same placeholder id)
  const email = ctx.user?.email || ''
  for (const [un, info] of demoUsernames.entries()) {
    if (info.email && info.email.toLowerCase() === email.toLowerCase()) return un
  }
  return ''
}

export async function fetchInbox(ctx) {
  const username = await getMyUsername(ctx)
  if (!username) return []
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_inbox', { p_username: username })
    if (error) return []
    return data || []
  }
  return demoMessages
    .filter((m) => m.recipient && m.recipient.toLowerCase() === username)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function fetchSent(ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_sent', { p_userid: ctx.user.id })
    if (error) return []
    return data || []
  }
  return demoMessages
    .filter((m) => m.sender_id === ctx.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function fetchMessage(id, ctx) {
  if (ctx.isConfigured) {
    const username = await getMyUsername(ctx)
    if (!username) return null
    const { data, error } = await ctx.supabase.rpc('peek_inbox', { p_username: username })
    if (error || !data) return null
    return data.find((m) => m.id === id) || null
  }
  return demoMessages.find((m) => m.id === id) || null
}

export async function doSendMessage({ recipient, subject, body, priority, classification }, ctx) {
  const r = String(recipient || '').trim().toLowerCase()
  if (!r) return { ok: false, reason: 'recipient_required' }
  if (!subject) return { ok: false, reason: 'subject_required' }
  if (!body) return { ok: false, reason: 'body_required' }
  const cls = String(classification || 'PUBLIC').toUpperCase()
  if (!CLASSIFICATIONS.includes(cls)) return { ok: false, reason: 'invalid_classification' }
  const pri = String(priority || 'normal').toLowerCase()
  if (!['normal', 'important', 'urgent'].includes(pri)) return { ok: false, reason: 'invalid_priority' }

  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_send_message', {
      p_recipient: r, p_subject: subject, p_body: body, p_priority: pri, p_classification: cls
    })
    if (error) return { ok: false, reason: error.message }
    if (data?.status === 'not_found') return { ok: false, reason: `recipient "${r}" does not exist` }
    if (data?.status === 'denied') return { ok: false, reason: data.reason || 'denied' }
    return { ok: true, id: data.id, recipient: data.recipient }
  }
  // DEMO
  const hit = demoLookupByUsername(r)
  if (!hit) return { ok: false, reason: `recipient "${r}" does not exist` }
  const req = CLEARANCE_LEVEL[cls]
  if (req > getClearance(ctx)) return { ok: false, reason: `requires level ${req}` }
  const m = demoAddMessage({
    sender_id: ctx.user.id,
    sender_email: ctx.user.email,
    sender_username: '',
    recipient: r,
    subject, body,
    priority: pri,
    classification: cls,
    created_at: new Date().toISOString()
  })
  return { ok: true, id: m.id, recipient: r }
}

export async function doMarkRead(id, ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_mark_read', { p_id: id })
    if (error) return false
    return data?.status === 'ok'
  }
  return demoMarkRead(id)
}

async function mailCmd(args, ctx) {
  const guard = authGuard(ctx)
  if (guard) return guard
  // No username yet? Prompt to set one (live mode only — DEMO is forgiving).
  const sub = (args[0] || '').toLowerCase()
  if (sub === 'send' || sub === 'compose') {
    return {
      lines: [
        { cls: 'ok', text: 'OPENING MAIL COMPOSER…' }
      ],
      openCompose: true
    }
  }
  if (sub === 'inbox') {
    const rows = await fetchInbox(ctx)
    return [
      { cls: 'ok', text: `INBOX (${rows.length})` },
      ...rows.slice(0, 30).map((r) => ({
        cls: 'sys',
        text: `  [${r.id.slice(0, 8)}] (${r.classification}) ${r.subject} — from ${r.sender_email || r.sender_username || 'unknown'}${r.read_at ? '' : '  ★'}`
      }))
    ]
  }
  if (sub === 'sent') {
    const rows = await fetchSent(ctx)
    return [
      { cls: 'ok', text: `SENT (${rows.length})` },
      ...rows.slice(0, 30).map((r) => ({
        cls: 'sys',
        text: `  [${r.id.slice(0, 8)}] (${r.classification}) to ${r.recipient} — ${r.subject}`
      }))
    ]
  }
  // bare `mail` or `mail <id-prefix>` -> open the inbox window
  return {
    lines: [{ cls: 'dim', text: 'opening mailbox…' }],
    openMailbox: true,
    openMsgId: args[0] || null
  }
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
    case 'create': {
      const guard = authGuard(ctx)
      if (guard) return guard
      // Pre-fill with optional inline args: create <number> "<title>"
      const prefill = {}
      const titleArgs = []
      for (let i = 1; i < args.length; i++) titleArgs.push(args[i])
      if (args[0]) prefill.archive_number = args[0]
      if (titleArgs.length) prefill.title = titleArgs.join(' ')
      return {
        lines: [
          { cls: 'ok', text: 'OPENING DOCUMENT EDITOR…' },
          { cls: 'dim', text: 'fill the form, write content in markdown, drag photos onto the editor.' }
        ],
        openEditor: prefill
      }
    }
    case 'edit': {
      const guard = authGuard(ctx)
      if (guard) return guard
      const num = args[0]
      if (!num) return [{ cls: 'warn', text: 'usage: edit <number>' }]
      const found = await fetchOne(num, ctx)
      if (!found.ok) {
        if (found.reason === 'not_found') return [{ cls: 'err', text: `ARCHIVE ${num} NOT FOUND` }]
        if (found.reason === 'denied') {
          return [{ cls: 'err', text: `EDIT DENIED // ARCHIVE ${num} — insufficient clearance.` }]
        }
        return [{ cls: 'err', text: `ARCHIVE ${num} UNAVAILABLE` }]
      }
      return {
        lines: [
          { cls: 'ok', text: `OPENING EDITOR FOR ARCHIVE ${num}…` },
          { cls: 'dim', text: 'modify the fields, then SAVE to commit your changes.' }
        ],
        openEditor: {
          ...found.data,
          photos: Array.isArray(found.data.photos) ? found.data.photos.map((p) => ({ ...p })) : [],
          _editing: true,
          _originalNumber: String(num)
        }
      }
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
    case 'delete':
      return doDelete(args, ctx)
    case 'logout':
      return doLogout(ctx)
    case 'whoami': {
      if (!ctx.user) return [{ cls: 'dim', text: 'not authenticated.' }]
      let username = ''
      if (ctx.isConfigured) {
        const { data } = await ctx.supabase.from('users').select('username').eq('id', ctx.user.id).maybeSingle()
        username = data?.username || ''
      } else {
        for (const [un, info] of demoUsernames.entries()) {
          if (info.email && info.email.toLowerCase() === ctx.user.email.toLowerCase()) { username = un; break }
        }
      }
      return [
        { cls: 'sys', text: `operator: ${ctx.user.email} (${ctx.user.id})` },
        { cls: 'dim', text: `clearance level: ${getClearance(ctx)}` },
        ...(username ? [{ cls: 'dim', text: `username: ${username}` }] : [])
      ]
    }
    case 'mail':
      return await mailCmd(args, ctx)
    case 'about':
      return [
        { cls: 'ok', text: 'CCDT — CORPORATE CENTRAL DATA TERMINAL' },
        {
          cls: 'dim',
          text: 'SECURE, CONTAIN, PROTECT'
        },
        {
          cls: 'dim',
          text: 'A company document archive. Type a number or keyword to access records.'
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
