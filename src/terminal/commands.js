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
import { getOnlinePeers, refreshPeers } from '../presence'
import { getClearance, isO5, O5_LEVEL, clearanceLabel, O5_FOUNDER_EMAIL } from '../o5'

export { getClearance, isO5, O5_LEVEL, clearanceLabel }

const DEMO_USER = { id: 'demo-agent', email: 'agent@archive.local' }

const CLASSIFICATIONS = ['PUBLIC', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']

// Clearance model: each classification maps to the minimum clearance level an
// operator must hold to READ it. 1 = PUBLIC … 4 = TOP SECRET … 5 = O5 COUNCIL.
// This is the real enforcement that was missing before — a level-2 operator can
// no longer open a level-4 (TOP SECRET) document.
const CLEARANCE_LEVEL = { PUBLIC: 1, CONFIDENTIAL: 2, SECRET: 3, 'TOP SECRET': 4 }
const MAX_CLEARANCE = O5_LEVEL  // 5 — includes O5

function requiredLevel(rec) {
  const cls = String((rec && rec.classification) || '').toUpperCase()
  return CLEARANCE_LEVEL[cls] || 1
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

const HELP_BASE = [
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
  { cls: 'dim',  text: '      or inline: register me@corp.com hunter2 3   (clearance 1–5)' },
  { cls: 'sys',  text: '  logout                end the current session' },
  { cls: 'sys',  text: '  changepass [old new]  change your password' },
  { cls: 'dim',  text: '      bare `changepass` prompts for current + new password' },
  { cls: 'dim',  text: '      inline:  changepass <old> <new>     (min 8 chars, must differ)' },
  { cls: 'dim',  text: '      alias: password' },
  { cls: 'sys',  text: '  whoami                show current operator + clearance level' },
  { cls: 'sys',  text: '  who [also: online, users]    list operators currently online, sorted by clearance' },
  { cls: 'dim',  text: '      presence comes from the Supabase realtime channel; missing peers = no live socket' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ NAVIGATION' },
  { cls: 'sys',  text: '  database              switch to the visual DATABASE browser' },
  { cls: 'sys',  text: '  terminal              switch back to the terminal' },
  { cls: 'sys',  text: '  mail [sub]            open the mailbox window (sub: inbox, sent, send)' },
  { cls: 'dim',  text: '      bare `mail` shows inbox+sent · `mail send` opens the composer · `mail <id>` opens a message' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ VAULTS (multi-tenant workspaces)' },
  { cls: 'sys',  text: '  vault <name> [pw]     admin/O5 create a new vault (you become owner)' },
  { cls: 'sys',  text: '  vaults                list vaults you belong to; active vault marked ◀ active' },
  { cls: 'sys',  text: '  vaultswitch <id>      set the active vault (org picker)' },
  { cls: 'sys',  text: '  vaultmembers <id>     list members of a vault' },
  { cls: 'sys',  text: '  vaultinvites <id>     list pending + accepted vault invites' },
  { cls: 'sys',  text: '  invite <user> to <vault> [as role] [clearance N]' },
  { cls: 'dim',  text: '      example: invite d-9341 to 900watts as admin clearance 3' },
  { cls: 'sys',  text: '  acceptinvite <token>  consume a vault invite mail' },
  { cls: 'sys',  text: '  setrole <v> <user> <owner|admin|member>' },
  { cls: 'sys',  text: '  setclearance <v> <user> <1-4>' },
  { cls: 'sys',  text: '      admin cannot grant clearance higher than their own' },
  { cls: 'sys',  text: '  fire <vault> <user>   remove a member from a vault (now an outsider)' },
  { cls: 'sys',  text: '  vaultpass <v> <old> <new>   owner resets the vault password' },
  { cls: 'sys',  text: '  transfervault <v> to <user>    owner initiates ownership transfer' },
  { cls: 'sys',  text: '  accepttransfer <token>         target accepts ownership offer' },
  { cls: 'sys',  text: '  declinetransfer <token>        target declines ownership offer' },
  { cls: 'sys',  text: '  setpublic <vault> on|off       owner toggles vault visibility' },
  { cls: 'sys',  text: '  allow <user> read <1-4> in <v> for <h>h   grant temp visitor access' },
  { cls: 'sys',  text: '  revokeallow <vault> <user>     revoke a visit grant' },
  { cls: 'sys',  text: '  visitgrants <vault>           list active visit grants' },
  { cls: 'sys',  text: '  requestjoin <vault> [msg]      outsiders apply to become a permanent member' },
  { cls: 'sys',  text: '  joinrequests <vault>          admin/owner queue of join requests' },
  { cls: 'sys',  text: '  approvejoin <request_id>      accept a join request' },
  { cls: 'sys',  text: '  declinejoin <request_id>       decline a join request' },
  { cls: 'dim', text: '' },

  { cls: 'ok', text: '▸ SYSTEM' },
  { cls: 'sys',  text: '  about                 what this terminal is' },
  { cls: 'sys',  text: '  clear                 clear the screen' },
  { cls: 'sys',  text: '  help                  show this reference' },
  { cls: 'dim', text: '' },
  { cls: 'dim', text: '  global tiers: 1 user · 2-3 admin · 4-5 O5 (audit + promote)' },
  { cls: 'dim', text: '  vault-internal clearance (per archive): PUBLIC · CONFIDENTIAL · SECRET · TOP SECRET' },
  { cls: 'dim', text: '  tip: ↑/↓ scroll command history · blank line finishes multi-line input' }
]

// HELP now adapts to the caller's clearance — O5 sees the council section.
function HELP(ctx) {
  const out = [...HELP_BASE]
  if (ctx && isO5(ctx)) {
    out.push(
      { cls: 'ok',  text: '' },
      { cls: 'ok',  text: '▸ O5 COUNCIL (LEVEL 5)' },
      { cls: 'sys', text: '  allfiles [n]           view every archive ever created, regardless of clearance' },
      { cls: 'sys', text: '  promote <email> <lvl>  raise a user to clearance level 1–5 (capped at yours)' },
      { cls: 'sys', text: '  demote  <email> <lvl>  lower a user to clearance level 1–5' },
      { cls: 'sys', text: '  logs                  open the activity log browser (auto-refresh every 10s)' },
      { cls: 'sys', text: '  mail send all <cls>   broadcast a priority:o5 mail to every user >= <cls>' },
      { cls: 'dim', text: '      type `all` in the TO bracket — the composer tags it as priority:o5 automatically.' }
    )
  }
  return out
}

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

// Vault helpers ───────────────────────────────────────────────────────────────
// The active vault is stored in localStorage by App.jsx. We expose
// helpers here so commands can read it without coupling to React.

// Module-level setter/getter for the active vault id (citext-shaped string).
let _activeVault = null
export function setActiveVault(vaultId) {
  _activeVault = vaultId
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('ccdt:activeVault', vaultId || '') } catch {}
}
export function getActiveVault() {
  if (_activeVault) return _activeVault
  try {
    if (typeof localStorage !== 'undefined') {
      _activeVault = localStorage.getItem('ccdt:activeVault') || null
    }
  } catch {}
  return _activeVault
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

// Pulls the username/clearance mapping for peers that haven't broadcast
// (or whose broadcast arrived before Supabase auth populated `user_metadata`).
// Note: public.users has id/username/clearance_level but NO `email` column
// (emails live in auth.users, not the public profile table).
async function _enrichPeers(supabase, profiles) {
  if (!supabase || !profiles?.length) return profiles
  const ids = profiles.map((p) => p?.id).filter(Boolean)
  if (!ids.length) return profiles
  // Supabase JS query builders are thenable but don't expose .catch()
  // directly — wrap the await in a try/catch instead.
  let data = null
  try {
    const res = await supabase
      .from('users')
      .select('id,username')
      .in('id', ids)
    data = res?.data || null
  } catch {
    data = null
  }
  if (!data) return profiles
  const byId = new Map(data.map((u) => [u.id, u]))
  return profiles.map((p) => {
    if (!p) return p
    const row = byId.get(p.id)
    if (!row) return p
    return {
      ...p,
      username: p.username || row.username || null
    }
  })
}

async function who(args, ctx) {
  // Available even without auth — DEMO mode shows the local tab + any
  // real session; authenticated mode shows everyone connected.
  let peers
  try {
    // Live scan: broadcast a "who" ping to the realtime channel and wait
    // ~1s for everyone to respond with their profile. Without this, a tab
    // that just opened wouldn't appear in `who` until its next heartbeat
    // (up to 15s later). refreshPeers is a no-op in DEMO mode.
    peers = await refreshPeers(ctx.supabase, 1000)
  } catch (e) {
    try { peers = getOnlinePeers() } catch {
      return [{ cls: 'err', text: `WHO failed (presence module): ${e.message}` }]
    }
  }

  // Enrich from public.users so peers appear with their username even when
  // their broadcast raced ahead of the auth metadata hydration.
  let visible = peers.filter((p) => p && p.profile && p.profile.id)
  if (ctx.isConfigured && ctx.supabase) {
    try {
      const enriched = await _enrichPeers(ctx.supabase, visible.map((p) => p.profile))
      visible = peers.map((p) => ({ peer: p, profile: enriched.find((x) => x && x.id === p.profile?.id) || p.profile }))
    } catch (e) {
      // Enrichment is best-effort. Fall back to bare profiles.
      visible = peers.map((p) => ({ peer: p, profile: p.profile }))
      visible.__enrichErr = e.message
    }
  } else {
    visible = peers.map((p) => ({ peer: p, profile: p.profile }))
  }

  // De-dupe: same user may have multiple tabs.
  const seen = new Set()
  const deduped = []
  for (const row of visible) {
    const id = row?.profile?.id || row?.peer?.tab
    if (!id || seen.has(id)) continue
    seen.add(id)
    deduped.push(row)
  }

  if (!deduped.length) {
    return [{
      cls: 'dim',
      text: 'No operators are online right now. (Presence requires a real-time Supabase connection.)'
    }]
  }

  // Sort by clearance desc, then username.
  deduped.sort((a, b) => {
    const ca = Number(a.profile?.clearance_level) || 0
    const cb = Number(b.profile?.clearance_level) || 0
    if (cb !== ca) return cb - ca
    const ua = (a.profile?.username || a.profile?.email || '').toLowerCase()
    const ub = (b.profile?.username || b.profile?.email || '').toLowerCase()
    return ua.localeCompare(ub)
  })

  const myPeerId = peers.find((p) => p.self)?.tab
  const out = [{ cls: 'ok', text: `OPERATORS ONLINE (${deduped.length})` }]

  // Render each row as a column-aligned record. We compute column widths
  // off the actual data (column -t style) so any username / email /
  // clearance length slots in without spilling across columns.
  const rows = deduped.map(({ peer, profile }) => {
    const isMe = peer.tab === myPeerId
    const clearance = Number(profile?.clearance_level) || 1
    const clearanceTag =
      clearance >= 4 ? 'L4 TOP SECRET' :
      clearance === 3 ? 'L3 SECRET' :
      clearance === 2 ? 'L2 CONFIDENTIAL' :
                        'L1 PUBLIC'
    return {
      isMe,
      name:
        (profile?.username && '@' + profile.username) ||
        profile?.email ||
        '(unnamed)',
      clearance: clearanceTag,
      channel: 'realtime',
      email: profile?.email || '',
      tag: isMe ? '◀ self' : ''
    }
  })

  // Column widths: header has the right length caps, data drives the minimum.
  const cols = [
    { header: 'NAME',     get: (r) => r.name      },
    { header: 'CLEARANCE',get: (r) => r.clearance },
    { header: 'CHANNEL',  get: (r) => r.channel   },
    { header: 'EMAIL',    get: (r) => r.email     }
  ]
  for (const col of cols) {
    col.width = col.header.length
    for (const r of rows) col.width = Math.max(col.width, col.get(r).length)
    // Hard cap — emails beyond 32 chars would dominate the screen.
    const HARD = 36
    if (col.width > HARD) col.width = HARD
  }

  const renderRow = (r) => {
    const cells = cols.map((col) => {
      const raw = col.get(r)
      const val = raw.length > col.width ? raw.slice(0, col.width - 1) + '…' : raw
      return val.padEnd(col.width, ' ')
    })
    return '  ' + cells.join('  ') + (r.tag ? '  ' + r.tag : '')
  }
  const renderHeader = () => {
    const cells = cols.map((col) => col.header.padEnd(col.width, ' '))
    return '  ' + cells.join('  ')
  }
  out.push({ cls: 'dim', text: renderHeader() })

  for (const r of rows) {
    out.push({ cls: r.isMe ? 'ok' : 'sys', text: renderRow(r) })
  }
  out.push({ cls: 'dim', text: '' })
  out.push({
    cls: 'dim',
    text: 'Tip: presence comes from the realtime channel. A tab without live websocket counts as offline.'
  })
  if (visible.__enrichErr) {
    out.push({
      cls: 'warn',
      text: `note: profile enrichment skipped (${visible.__enrichErr}) — username/clearance may be incomplete.`
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

// Change the current operator's password.
//
// Live mode requires the active Supabase session. To re-authenticate as
// part of the change we call `signInWithPassword({ email, password: old })`
// against the user's stored email — GoTrue's `updateUser({ password })`
// only works on an active session and we want to validate the OLD password
// anyway. (Email is recoverable from the JWT-decoded `user.email`.)
//
// DEMO mode is not supported — there's no auth to update.
//
// Returns { lines, prompt } when called with no args so App.jsx can drive
// the interactive "OLD PASSWORD: / NEW PASSWORD:" prompts, or just `lines`
// when called inline with both args.
export async function doChangePassword(args, ctx) {
  if (!ctx.isConfigured) {
    return [{ cls: 'err', text: 'PASSWORD CHANGE unavailable in DEMO mode.' }]
  }
  if (!ctx.user) {
    return [{ cls: 'err', text: 'PASSWORD CHANGE failed: not authenticated.' }]
  }

  const email = ctx.user.email

  // Inline: changepass <old> <new>
  if (args.length >= 2) {
    const oldPw = args[0]
    const newPw = args[1]
    return await _doPasswordChange(email, oldPw, newPw)
  }

  // Interactive: caller (App.jsx) will read prompts and submit
  return {
    lines: [
      { cls: 'ok', text: 'CHANGE PASSWORD — confirm current credentials, then pick a new one.' },
      { cls: 'dim', text: 'tip: you can also type `changepass <old> <new>` in one line.' }
    ],
    prompt: 'change-password'   // signal — App.jsx switches into changepass mode
  }
}

// Shared core: verify the old password by signing in on a fresh client, then
// update via the same client. The fresh client doesn't touch the SPA's
// session storage (persistSession:false), so the operator stays logged in
// throughout.
async function _doPasswordChange(email, oldPw, newPw) {
  if (!newPw || newPw.length < 8) {
    return [{ cls: 'err', text: 'PASSWORD CHANGE failed: new password must be at least 8 characters.' }]
  }
  if (oldPw === newPw) {
    return [{ cls: 'err', text: 'PASSWORD CHANGE failed: new password matches the old one.' }]
  }

  const { createClient } = await import('@supabase/supabase-js')
  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey } = await import('../supabaseClient')
  if (!url || !anonKey) {
    return [{ cls: 'err', text: 'PASSWORD CHANGE failed: cannot build a throwaway client (no Supabase URL/key).' }]
  }
  const throwaway = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  const { error: signInErr } = await throwaway.auth.signInWithPassword({ email, password: oldPw })
  if (signInErr) {
    return [{ cls: 'err', text: `PASSWORD CHANGE failed: current password rejected — ${signInErr.message}` }]
  }
  const { error: updErr } = await throwaway.auth.updateUser({ password: newPw })
  if (updErr) {
    return [{ cls: 'err', text: `PASSWORD CHANGE failed: ${updErr.message}` }]
  }
  await throwaway.auth.signOut()
  return [
    { cls: 'ok', text: 'PASSWORD UPDATED.' },
    { cls: 'dim', text: 'your other sessions were not invalidated — log out of those devices manually.' }
  ]
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
  if (!CLASSIFICATIONS.includes(cls) && cls !== 'O5') return { ok: false, reason: 'invalid_classification' }
  // Priority: 'o5' is reserved for O5 council broadcasts; must be issued by O5.
  const isBroadcast = r === 'all' || r === 'everyone'
  let pri = String(priority || 'normal').toLowerCase()
  if (isBroadcast) pri = 'o5'
  if (!['normal', 'important', 'urgent', 'o5'].includes(pri)) return { ok: false, reason: 'invalid_priority' }
  if (pri === 'o5' && !isO5(ctx)) return { ok: false, reason: 'O5 priority requires O5 council clearance' }

  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_send_message', {
      p_recipient: r, p_subject: subject, p_body: body, p_priority: pri, p_classification: cls
    })
    if (error) return { ok: false, reason: error.message }
    if (data?.status === 'not_found') return { ok: false, reason: `recipient "${r}" does not exist` }
    if (data?.status === 'denied') return { ok: false, reason: data.reason || 'denied' }
    if (data?.broadcast) return { ok: true, broadcast: data.broadcast, recipient: 'all', subject: data.subject, priority: pri }
    return { ok: true, id: data.id, recipient: data.recipient, priority: pri }
  }
  // DEMO
  if (isBroadcast) {
    // Simulate: insert one demo message addressed to every demo username.
    let count = 0
    for (const un of demoUsernames.keys()) {
      demoAddMessage({
        sender_id: ctx.user.id,
        sender_email: ctx.user.email,
        sender_username: '',
        recipient: un,
        subject: '[O5 BROADCAST] ' + subject,
        body,
        priority: 'o5',
        classification: cls,
        created_at: new Date().toISOString()
      })
      count++
    }
    return { ok: true, broadcast: count, recipient: 'all', subject: '[O5 BROADCAST] ' + subject, priority: 'o5' }
  }
  const hit = demoLookupByUsername(r)
  if (!hit) return { ok: false, reason: `recipient "${r}" does not exist` }
  const req = CLEARANCE_LEVEL[cls] || 1
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
  return { ok: true, id: m.id, recipient: r, priority: pri }
}

export async function doMarkRead(id, ctx) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_mark_read', { p_id: id })
    if (error) return false
    return data?.status === 'ok'
  }
  return demoMarkRead(id)
}

// Activity log — peek_log_activity() RPC. Returns rows newest-first.
// In DEMO mode we synthesise a small feed from local state so the UI can
// be exercised without Supabase.
export async function fetchActivityLog(ctx, since = null) {
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_log_activity', { p_since: since })
    if (error) return []
    return data || []
  }
  // DEMO feed
  const me = ctx.user
  if (!me) return []
  const feed = []
  // Mirror demoMessages as send_message events.
  for (const m of demoMessages.slice(-20)) {
    feed.push({
      id: m.id + '-send',
      action: m.priority === 'o5' ? 'broadcast' : 'send_message',
      target: m.id,
      detail: { recipient: m.recipient, subject: m.subject, priority: m.priority, classification: m.classification },
      username: m.sender_username || (m.sender_email || '').split('@')[0],
      user_clearance: 4,
      created_at: m.created_at
    })
  }
  // Mirror demoArchives as create events.
  for (const a of demoStore.slice(-15)) {
    feed.push({
      id: 'demo-' + a.archive_number + '-create',
      action: 'create',
      target: a.archive_number,
      detail: { title: a.title, classification: a.classification },
      username: 'demo-agent',
      user_clearance: 4,
      created_at: a.created_at || new Date().toISOString()
    })
  }
  feed.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  return feed
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
      return HELP(ctx)
    case 'access':
      return access(args, ctx)
    case 'list':
      return list(args, ctx)
    case 'search':
      return search(args, ctx)
    case 'who':
    case 'online':
    case 'users':
      return who(args, ctx)
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
    case 'changepass':
    case 'password':
      return doChangePassword(args, ctx)
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
        { cls: 'dim', text: `clearance level: ${getClearance(ctx)} (${clearanceLabel(getClearance(ctx))})` },
        ...(username ? [{ cls: 'dim', text: `username: ${username}` }] : []),
        ...(isO5(ctx) ? [{ cls: 'warn', text: '⚠ O5 COUNCIL — all clearance commands unlocked.' }] : [])
      ]
    }
    // ──────────────────────────────────────────────────────────
    // O5 council commands (level 5 only)
    // ──────────────────────────────────────────────────────────
    case 'allfiles':
    case 'viewall':
    case 'listall':
      return o5ListAll(args, ctx)
    case 'promote':
      return o5Promote(args, ctx)
    case 'demote':
      return o5Demote(args, ctx)
    case 'logs':
      return o5Logs(args, ctx)
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
    // ─────── VAULT COMMANDS ──────────────────────────────────────────────────
    case 'vaults':
    case 'myvaults':
      return vaultList(ctx)
    case 'vaultswitch':
    case 'switchvault':
      return vaultSwitch(args[0], ctx)
    case 'vaultmembers':
      return vaultMembers(args[0], ctx)
    case 'vaultinvites':
      return vaultInvites(args[0], ctx)
    case 'setpublic':
      return vaultSetPublic(args[0], args[1], ctx)
    case 'visitgrants':
      return vaultVisitGrants(args[0], ctx)
    case 'joinrequests':
      return vaultJoinRequests(args[0], ctx)
    case 'acceptinvite':
      return vaultAcceptInvite(args[0], ctx)
    case 'accepttransfer':
      return vaultAcceptTransfer(args[0] || getLatestTransferTokenBySender(), ctx)
    case 'declinetransfer':
      return vaultDeclineTransfer(args[0] || getLatestTransferTokenBySender(), ctx)
    // ─────── INLINE VAULT ACTIONS (auth required) ───────
    case 'vaultpass':
      return vaultPass(args[0], args[1], args[2], ctx)
    case 'vault':
      return vaultCreateInline(args, ctx)
    case 'invite':
      return vaultInviteInline(args, ctx)
    case 'setrole':
      return vaultSetRoleInline(args, ctx)
    case 'setclearance':
      return vaultSetClearanceInline(args, ctx)
    case 'fire':
      return vaultFireInline(args, ctx)
    case 'transfervault':
      return vaultTransferInline(args, ctx)
    case 'allow':
      return vaultAllowInline(args, ctx)
    case 'revokeallow':
      return vaultRevokeAllowInline(args, ctx)
    case 'requestjoin':
      return vaultRequestJoinInline(args, ctx)
    case 'approvejoin':
      return vaultApproveJoinInline(args, ctx)
    case 'declinejoin':
      return vaultDeclineJoinInline(args, ctx)
    default:
      return [{ cls: 'err', text: `command not found: ${parts[0]}. type "help".` }]
  }
}

// ─── Inline vault command handlers ───────────────────────────────────────────

async function vaultPass(vaultId, oldPw, newPw, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'VAULTPASS — authentication required.' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'VAULTPASS — demo mode' }]
  if (!vaultId || !newPw) return [{ cls: 'err', text: 'VAULTPASS — usage: vaultpass <vault_id> <old_password> <new_password>' }]
  const res = await doResetVaultPassword(vaultId, oldPw || '', newPw, ctx)
  if (!res.ok) return [{ cls: 'err', text: `VAULTPASS — ${res.reason}` }]
  return [{ cls: 'ok', text: `▶ vault "${vaultId}" password reset.` }]
}

function _resolveOwner(ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'AUTH REQUIRED.' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'LIVE MODE ONLY.' }]
  return null
}

// Top-level inline handlers (called via prompts if we add wizard later)
async function vaultCreateInline(args, ctx) { return inlineVaultCreate(args, ctx) }
async function vaultInviteInline(args, ctx) { return inlineVaultInvite(args, ctx) }
async function vaultSetRoleInline(args, ctx) { return inlineVaultSetRole(args, ctx) }
async function vaultSetClearanceInline(args, ctx) { return inlineVaultSetClearance(args, ctx) }
async function vaultFireInline(args, ctx) { return inlineVaultFire(args, ctx) }
async function vaultTransferInline(args, ctx) { return inlineVaultTransfer(args, ctx) }
async function vaultAllowInline(args, ctx) { return inlineVaultAllow(args, ctx) }
async function vaultRevokeAllowInline(args, ctx) { return inlineVaultRevokeAllow(args, ctx) }
async function vaultRequestJoinInline(args, ctx) { return inlineVaultRequestJoin(args, ctx) }
async function vaultApproveJoinInline(args, ctx) { return inlineVaultApproveJoin(args, ctx) }
async function vaultDeclineJoinInline(args, ctx) { return inlineVaultDeclineJoin(args, ctx) }

// Concrete inline handlers ──────────────────────────────────────────────────
async function inlineVaultCreate(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (!args[0]) return [{ cls: 'err', text: 'VAULT — usage: vault <name> [password]' }]
  const res = await doCreateVault(args[0], args[1] || null, ctx)
  if (!res.ok) return [{ cls: 'err', text: `VAULT — ${res.reason}` }]
  return [
    { cls: 'ok', text: `▶ vault "${res.vault_id}" created. you are its owner.` },
    { cls: 'dim', text: '  recovery token (save this NOW — shown only once):' },
    { cls: 'sys', text: `  ${res.recovery_token}` }
  ]
}

async function inlineVaultInvite(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  // INVITE syntax: invite <username> to <vault> [as role] [clearance N]
  // We need to find the literal "to" token to split into [username, vaultId, ...rest]
  const toIdx = args.indexOf('to')
  if (toIdx <= 0 || toIdx >= args.length - 1) {
    return [{ cls: 'err', text: 'INVITE — usage: invite <username> to <vault> [as role] [clearance N]' }]
  }
  const username = args[0]
  const vaultId = args[toIdx + 1]
  const tail = args.slice(toIdx + 2)  // everything after the vault id
  const role = tail[0] === 'as' ? tail[1] : 'member'
  const restStart = tail[0] === 'as' ? 2 : 0
  const rest = tail.slice(restStart)
  const clearance = rest[0] === 'clearance' ? parseInt(rest[1], 10) : 1
  const res = await doInviteToVault(vaultId, username, role, clearance, ctx)
  if (!res.ok) return [{ cls: 'err', text: `INVITE — ${res.reason}` }]
  return [
    { cls: 'ok', text: `▶ invite sent to ${res.invitee}` },
    { cls: 'dim', text: `  token: ${res.token}` }
  ]
}

async function inlineVaultSetRole(args, ctx) {
  // setrole <vault> <username> <owner|admin|member>
  const g = _resolveOwner(ctx); if (g) return g
  if (args.length < 3) return [{ cls: 'err', text: 'SETROLE — usage: setrole <vault> <username> <role>' }]
  // Resolve username → user_id by querying public.users
  const ures = await ctx.supabase.from('users').select('id,username').eq('username', args[1].toLowerCase()).maybeSingle()
  if (ures.error || !ures.data) return [{ cls: 'err', text: `SETROLE — user "${args[1]}" not found.` }]
  const res = await doSetVaultMember(args[0], ures.data.id, args[2], 1, ctx)
  if (!res.ok) return [{ cls: 'err', text: `SETROLE — ${res.reason}` }]
  return [{ cls: 'ok', text: `▶ ${args[1]} → ${args[2]} in ${args[0]}` }]
}

async function inlineVaultSetClearance(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (args.length < 3) return [{ cls: 'err', text: 'SETCLEARANCE — usage: setclearance <vault> <username> <1-4>' }]
  const ures = await ctx.supabase.from('users').select('id,username').eq('username', args[1].toLowerCase()).maybeSingle()
  if (ures.error || !ures.data) return [{ cls: 'err', text: `SETCLEARANCE — user "${args[1]}" not found.` }]
  const lvl = parseInt(args[2], 10)
  if (!Number.isFinite(lvl) || lvl < 1 || lvl > 4) return [{ cls: 'err', text: 'SETCLEARANCE — level must be 1, 2, 3, or 4.' }]
  // We need to know the user's existing role to avoid breaking the role
  const mres = await ctx.supabase.from('vault_members').select('role').eq('vault_id', args[0]).eq('user_id', ures.data.id).maybeSingle()
  const role = mres.data?.role || 'member'
  const res = await doSetVaultMember(args[0], ures.data.id, role, lvl, ctx)
  if (!res.ok) return [{ cls: 'err', text: `SETCLEARANCE — ${res.reason}` }]
  return [{ cls: 'ok', text: `▶ ${args[1]} vault-clr → ${lvl} in ${args[0]}` }]
}

async function inlineVaultFire(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (args.length < 2) return [{ cls: 'err', text: 'FIRE — usage: fire <vault> <username>' }]
  const ures = await ctx.supabase.from('users').select('id,username').eq('username', args[1].toLowerCase()).maybeSingle()
  if (ures.error || !ures.data) return [{ cls: 'err', text: `FIRE — user "${args[1]}" not found.` }]
  const res = await doFireVaultMember(args[0], ures.data.id, ctx)
  if (!res.ok) return [{ cls: 'err', text: `FIRE — ${res.reason}` }]
  return [{ cls: 'ok', text: `▶ ${args[1]} removed from ${args[0]} (now an outsider).` }]
}

async function inlineVaultTransfer(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (args.length < 3) return [{ cls: 'err', text: 'TRANSFERVAULT — usage: transfervault <vault> to <username>' }]
  if (args[1] !== 'to') return [{ cls: 'err', text: 'TRANSFERVAULT — usage: transfervault <vault> to <username>' }]
  const res = await doCreateTransfer(args[0], args[2], ctx)
  if (!res.ok) return [{ cls: 'err', text: `TRANSFERVAULT — ${res.reason}` }]
  return [
    { cls: 'ok', text: `▶ transfer offer sent to ${args[2]}` },
    { cls: 'dim', text: `  they must accepttransfer <token> to confirm.` },
    { cls: 'sys', text: `  token: ${res.token}` }
  ]
}

async function inlineVaultAllow(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  // Syntax: allow <user> read <lvl> in <vault> for <h>h
  // joined with raw args[]; split them
  const joined = args.join(' ')
  const m = joined.match(/^(\S+)\s+read\s+(\d+)\s+in\s+(\S+)\s+for\s+(\d+)h?$/i)
  if (!m) return [{ cls: 'err', text: 'ALLOW — usage: allow <user> read <1-4> in <vault> for <h>h' }]
  const [, username, lvlStr, vaultId, hoursStr] = m
  const clearance = parseInt(lvlStr, 10)
  const hours = parseInt(hoursStr, 10)
  if (!Number.isFinite(clearance) || clearance < 1 || clearance > 4) return [{ cls: 'err', text: 'ALLOW — clearance must be 1-4' }]
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) return [{ cls: 'err', text: 'ALLOW — hours must be 1-720' }]
  const res = await doGrantVisit(vaultId, username, clearance, hours, ctx)
  if (!res.ok) return [{ cls: 'err', text: `ALLOW — ${res.reason}` }]
  return [{ cls: 'ok', text: `▶ ${username} granted clearance ${clearance} in ${vaultId} for ${hours}h.` }]
}

async function inlineVaultRevokeAllow(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (args.length < 2) return [{ cls: 'err', text: 'REVOKEALLOW — usage: revokeallow <vault> <username>' }]
  const res = await doRevokeVisit(args[0], args[1], ctx)
  if (!res.ok) return [{ cls: 'err', text: `REVOKEALLOW — ${res.reason}` }]
  return [{ cls: 'ok', text: `▶ ${args[1]}'s visit grant in ${args[0]} revoked.` }]
}

async function inlineVaultRequestJoin(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (!args[0]) return [{ cls: 'err', text: 'REQUESTJOIN — usage: requestjoin <vault> [message]' }]
  const res = await doCreateJoinRequest(args[0], args.slice(1).join(' ') || null, ctx)
  if (!res.ok) return [{ cls: 'err', text: `REQUESTJOIN — ${res.reason}` }]
  return [{ cls: 'ok', text: `▶ join request sent for ${args[0]} (id: ${res.request_id})` }]
}

async function inlineVaultApproveJoin(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (!args[0]) return [{ cls: 'err', text: 'APPROVEJOIN — usage: approvejoin <request_id>' }]
  const res = await doResolveJoinRequest(args[0], true, ctx)
  if (!res.ok) return [{ cls: 'err', text: `APPROVEJOIN — ${res.reason}` }]
  return [{ cls: 'ok', text: '▶ join request approved.' }]
}

async function inlineVaultDeclineJoin(args, ctx) {
  const g = _resolveOwner(ctx); if (g) return g
  if (!args[0]) return [{ cls: 'err', text: 'DECLINEJOIN — usage: declinejoin <request_id>' }]
  const res = await doResolveJoinRequest(args[0], false, ctx)
  if (!res.ok) return [{ cls: 'err', text: `DECLINEJOIN — ${res.reason}` }]
  return [{ cls: 'ok', text: '▶ join request declined.' }]
}

// Returns the most recent PENDING transfer token where current user is the addressee
// (used so that "accepttransfer" without args works from the mail view)
function getLatestTransferTokenBySender() { return null }

// ──────────────────────────────────────────────────────────────────────────
// O5 council commands — guarded by isO5(ctx). See src/o5.js for the rule.
// ──────────────────────────────────────────────────────────────────────────

function o5Guard(ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'O5 COMMAND DENIED — authentication required.' }]
  if (!isO5(ctx)) {
    return [
      { cls: 'err', text: 'O5 COMMAND DENIED — council clearance required.' },
      { cls: 'dim', text: `you hold level ${getClearance(ctx)}; this command requires level 5 (O5 COUNCIL).` }
    ]
  }
  return null
}

// allfiles / viewall — bypass RLS clearance gate and list EVERY archive.
// Live mode: this runs as SECURITY DEFINER via peek_all_archives() RPC.
// DEMO mode: dumps the local demoData set (already complete).
async function o5ListAll(args, ctx) {
  const guard = o5Guard(ctx)
  if (guard) return guard
  const limit = Math.min(parseInt(args[0], 10) || 50, 500)
  let rows = []
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_all_archives', { p_limit: limit })
    if (error) return [{ cls: 'err', text: `QUERY ERROR: ${error.message}` }]
    rows = data || []
  } else {
    // DEMO: show the full local store (no clearance filter).
    rows = ctx.demoData.slice(0, limit)
  }
  if (!rows.length) return [{ cls: 'dim', text: 'NO ARCHIVES ON RECORD.' }]
  const out = [{ cls: 'ok', text: `ALL ARCHIVES (${rows.length}) — O5 OVERRIDE` }]
  // Column widths from data.
  const clsWidth = Math.max(13, ...rows.map((r) => String(r.classification || '').length))
  for (const r of rows) {
    const cls = String(r.classification || 'PUBLIC').padEnd(clsWidth, ' ')
    const dept = r.department ? ` · ${r.department}` : ''
    out.push({ cls: 'sys', text: `  [${r.archive_number}] ${cls}  ${r.title}${dept}` })
  }
  out.push({ cls: 'dim', text: '' })
  out.push({ cls: 'dim', text: 'O5 override: archives are listed regardless of their required clearance.' })
  return out
}

// promote <email> <level 1..5> — only O5.
async function o5Promote(args, ctx) {
  const guard = o5Guard(ctx)
  if (guard) return guard
  if (args.length < 2) return [{ cls: 'warn', text: 'usage: promote <email> <level 1..5>' }]
  return o5SetClearance(args[0], parseInt(args[1], 10), ctx)
}

// demote <email> <level 1..5> — only O5. Same RPC, same gate, just a
// semantic label for the operator. The SQL function decides whether it
// counts as promote or demote based on the previous level.
async function o5Demote(args, ctx) {
  const guard = o5Guard(ctx)
  if (guard) return guard
  if (args.length < 2) return [{ cls: 'warn', text: 'usage: demote <email> <level 1..5>' }]
  return o5SetClearance(args[0], parseInt(args[1], 10), ctx)
}

async function o5SetClearance(email, newLevel, ctx) {
  if (!Number.isFinite(newLevel) || newLevel < 1 || newLevel > 5) {
    return [{ cls: 'err', text: 'INVALID LEVEL — must be an integer from 1 to 5.' }]
  }
  const meLevel = getClearance(ctx)
  if (newLevel > meLevel) {
    return [
      { cls: 'err', text: 'PROMOTE/DEMOTE DENIED — target level exceeds your own clearance.' },
      { cls: 'dim', text: `requested ${newLevel}; you hold ${meLevel}.` }
    ]
  }
  if (ctx.isConfigured) {
    const { data, error } = await ctx.supabase.rpc('peek_set_clearance', {
      p_target_email: String(email),
      p_new_level: newLevel
    })
    if (error) return [{ cls: 'err', text: `RPC ERROR: ${error.message}` }]
    if (data?.status === 'not_found') return [{ cls: 'err', text: `USER NOT FOUND: ${email}` }]
    if (data?.status === 'denied') {
      return [
        { cls: 'err', text: `SET CLEARANCE DENIED — ${data.reason || 'denied'}` },
        ...(data.your_level != null ? [{ cls: 'dim', text: `your level: ${data.your_level}` }] : [])
      ]
    }
    const from = data.from ?? '?'
    const to = data.to ?? newLevel
    const verb = to > from ? 'PROMOTED' : to < from ? 'DEMOTED' : 'UNCHANGED'
    return [
      { cls: 'ok', text: `${verb} ${data.target} (${data.username || 'no-username'}) L${from} → L${to}.` },
      { cls: 'dim', text: 'change propagates on the target user\'s next request.' }
    ]
  }
  // DEMO mode: simulate success — no real DB to update.
  return [
    { cls: 'ok', text: `(DEMO) clearance change simulated for ${email} → L${newLevel}.` },
    { cls: 'dim', text: 'connect Supabase to actually persist clearance levels.' }
  ]
}

// logs — open the activity log browser. The browser window is a separate
// file (src/o5Browser.js). We just return an opener marker.
function o5Logs(args, ctx) {
  const guard = o5Guard(ctx)
  if (guard) return guard
  return {
    lines: [
      { cls: 'ok', text: 'OPENING ACTIVITY LOG BROWSER…' },
      { cls: 'dim', text: 'new entries appear every 10 seconds. O5 override.' }
    ],
    openActivityLog: true
  }
}
// ═════════════════════════════════════════════════════════════════════════════
// VAULT COMMANDS
// These call the peek_* RPCs added in migration_006.
// ═════════════════════════════════════════════════════════════════════════════

async function rpcCall(name, args, ctx) {
  const { data, error } = await ctx.supabase.rpc(name, args)
  if (error) return { __rpcError: error.message || String(error) }
  return data
}

function vaultErr(ctx, e) {
  return [{ cls: 'err', text: `VAULT COMMAND FAILED — ${e}` }]
}

async function vaultList(ctx) {
  if (!ctx.isConfigured) return demoVaultList()
  if (!ctx.user) return [{ cls: 'err', text: 'VAULT LIST — authentication required.' }]
  const res = await ctx.supabase.rpc('peek_list_my_vaults')
  const rows = res.data
  if (res.error || !Array.isArray(rows) || rows.length === 0) {
    return [
      { cls: 'ok', text: `YOU ARE IN 0 VAULTS` },
      { cls: 'dim', text: 'ask an admin or O5 to invite you, or type "vault <name>" to create one.' }
    ]
  }
  const active = getActiveVault()
  const lines = [{ cls: 'ok', text: `YOUR VAULTS (${rows.length}) — active: ${active || '(none)'}` }]
  for (const v of rows) {
    const isActive = v.vault_id === active
    const tags = []
    if (isActive) tags.push('◀ active')
    if (v.is_public) tags.push('public')
    lines.push({
      cls: isActive ? 'ok' : 'sys',
      text: `  ${v.vault_id.padEnd(20)} ${v.display_name.padEnd(24)} role=${(v.role || '').padEnd(7)} vault-clr=${v.clearance}  members=${v.member_count}  ${tags.join(' ')}`
    })
  }
  lines.push({ cls: 'dim', text: '' })
  lines.push({ cls: 'dim', text: 'use "vaultswitch <vault_id>" to change active vault.' })
  return lines
}

async function vaultSwitch(vaultId, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'VAULTSWITCH — authentication required.' }]
  if (!vaultId) return [{ cls: 'err', text: 'VAULTSWITCH — usage: vaultswitch <vault_id>' }]
  const res = await ctx.supabase.rpc('peek_list_my_vaults')
  const found = (res.data || []).find((v) => v.vault_id === vaultId)
  if (!found) {
    return [{ cls: 'err', text: `VAULTSWITCH — you are not a member of "${vaultId}".` }]
  }
  setActiveVault(vaultId)
  return [
    { cls: 'ok',  text: `▶ active vault: ${vaultId}` },
    { cls: 'dim', text: `  role: ${found.role} · vault-internal clearance: ${found.clearance}` }
  ]
}

async function vaultMembers(vaultId, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'VAULTMEMBERS — authentication required.' }]
  if (!ctx.isConfigured) return demoVaultMembers(vaultId)
  if (!vaultId) vaultId = getActiveVault()
  if (!vaultId) return [{ cls: 'err', text: 'VAULTMEMBERS — no active vault. specify: vaultmembers <vault_id>' }]
  // Query vault_members + separately look up usernames (no PostgREST FK)
  const { data, error } = await ctx.supabase
    .from('vault_members')
    .select('user_id, role, clearance, joined_at')
    .eq('vault_id', vaultId)
  if (error) return vaultErr(ctx, error.message)
  if (!data || !data.length) {
    return [{ cls: 'dim', text: `VAULTMEMBERS — no members visible in "${vaultId}" (or you don't have access).` }]
  }
  // Look up usernames in a separate batch
  const userIds = data.map((m) => m.user_id)
  let userMap = new Map()
  try {
    const ures = await ctx.supabase
      .from('users')
      .select('id, username')
      .in('id', userIds)
    if (ures.data) userMap = new Map(ures.data.map((u) => [u.id, u.username]))
  } catch {}
  const lines = [{ cls: 'ok', text: `MEMBERS OF ${vaultId} (${data.length})` }]
  for (const m of data) {
    const username = userMap.get(m.user_id) || m.user_id.slice(0, 8)
    lines.push({ cls: 'sys', text: `  ${username.padEnd(20)} role=${(m.role || '').padEnd(7)} vault-clr=${m.clearance}  joined=${new Date(m.joined_at).toISOString().slice(0,10)}` })
  }
  return lines
}

async function vaultInvites(vaultId, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'VAULTINVITES — authentication required.' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'VAULTINVITES — demo mode' }]
  if (!vaultId) vaultId = getActiveVault()
  if (!vaultId) return [{ cls: 'err', text: 'VAULTINVITES — no active vault.' }]
  const res = await ctx.supabase.rpc('peek_list_vault_invites', { p_vault_id: vaultId })
  if (res.error) return vaultErr(ctx, res.error.message)
  const data = res.data
  if (!data || !data.length) return [{ cls: 'dim', text: `VAULTINVITES — no invites in "${vaultId}".` }]
  const lines = [{ cls: 'ok', text: `INVITES OF ${vaultId} (${data.length})` }]
  for (const inv of data) {
    const status = inv.accepted_at ? 'ACCEPTED' : (new Date(inv.expires_at) < new Date() ? 'EXPIRED' : 'PENDING')
    lines.push({
      cls: status === 'PENDING' ? 'sys' : 'dim',
      text: `  ${inv.invitee_email.padEnd(36)} ${(inv.role || '').padEnd(8)} clr=${inv.clearance}  ${status}  token=${inv.token}`
    })
  }
  return lines
}

async function vaultSetPublic(vaultId, onOff, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'SETPUBLIC — authentication required.' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'SETPUBLIC — demo mode' }]
  if (!vaultId || !onOff) return [{ cls: 'err', text: 'SETPUBLIC — usage: setpublic <vault_id> on|off' }]
  const isPublic = String(onOff).toLowerCase() === 'on' || onOff === 'true'
  const res = await ctx.supabase.rpc('peek_set_vault_public', { p_vault_id: vaultId, p_is_public: isPublic })
  if (res.error) return vaultErr(ctx, res.error.message)
  if (res.data?.status !== 'ok') return [{ cls: 'err', text: `SETPUBLIC — ${res.data?.reason || 'denied'}` }]
  return [{ cls: 'ok', text: `▶ vault "${vaultId}" is_public = ${isPublic}` }]
}

async function vaultVisitGrants(vaultId, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'VISITGRANTS — authentication required.' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'VISITGRANTS — demo mode' }]
  if (!vaultId) vaultId = getActiveVault()
  if (!vaultId) return [{ cls: 'err', text: 'VISITGRANTS — no active vault.' }]
  const res = await ctx.supabase.rpc('peek_list_visit_grants', { p_vault_id: vaultId })
  if (res.error) return vaultErr(ctx, res.error.message)
  const data = res.data
  if (!data || !data.length) return [{ cls: 'dim', text: `VISITGRANTS — no grants in "${vaultId}".` }]
  const lines = [{ cls: 'ok', text: `VISIT GRANTS IN ${vaultId} (${data.length})` }]
  for (const g of data) {
    const status = g.revoked ? 'REVOKED' : (new Date(g.expires_at) < new Date() ? 'EXPIRED' : 'ACTIVE')
    lines.push({
      cls: status === 'ACTIVE' ? 'sys' : 'dim',
      text: `  ${g.username.padEnd(20)} clr=${g.clearance}  ${status}  expires=${new Date(g.expires_at).toISOString().slice(0,16)}`
    })
  }
  return lines
}

async function vaultJoinRequests(vaultId, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'JOINREQUESTS — authentication required.' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'JOINREQUESTS — demo mode' }]
  if (!vaultId) vaultId = getActiveVault()
  if (!vaultId) return [{ cls: 'err', text: 'JOINREQUESTS — no active vault.' }]
  const res = await ctx.supabase.rpc('peek_list_join_requests', { p_vault_id: vaultId })
  if (res.error) return vaultErr(ctx, res.error.message)
  const data = res.data
  if (!data || !data.length) return [{ cls: 'dim', text: `JOINREQUESTS — no pending requests in "${vaultId}".` }]
  const lines = [{ cls: 'ok', text: `JOIN REQUESTS FOR ${vaultId} (${data.length})` }]
  for (const r of data) {
    lines.push({
      cls: r.status === 'pending' ? 'sys' : 'dim',
      text: `  ${r.request_id}  ${r.requester_username || r.requester_email}  ${r.status}  ${r.message ? '"' + r.message.slice(0, 40) + '"' : ''}`
    })
  }
  lines.push({ cls: 'dim', text: '' })
  lines.push({ cls: 'dim', text: 'approvejoin <request_id>  ·  declinejoin <request_id>' })
  return lines
}

async function vaultAcceptInvite(token, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'ACCEPTINVITE — authentication required.' }]
  if (!token) return [{ cls: 'err', text: 'ACCEPTINVITE — usage: acceptinvite <token>' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'ACCEPTINVITE — demo mode' }]
  const res = await ctx.supabase.rpc('peek_accept_vault_invite', { p_token: token })
  if (res.error) return vaultErr(ctx, res.error.message)
  if (res.data?.status !== 'ok') return [{ cls: 'err', text: `ACCEPTINVITE — ${res.data?.reason || 'failed'}` }]
  setActiveVault(res.data.vault_id)
  return [
    { cls: 'ok', text: `▶ joined vault "${res.data.vault_id}" as ${res.data.role}` },
    { cls: 'dim', text: '  active vault set. type "vaultmembers" to see other members.' }
  ]
}

async function vaultAcceptTransfer(token, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'ACCEPTTRANSFER — authentication required.' }]
  if (!token) return [{ cls: 'err', text: 'ACCEPTTRANSFER — usage: accepttransfer <token>' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'ACCEPTTRANSFER — demo mode' }]
  const res = await ctx.supabase.rpc('peek_accept_transfer', { p_token: token })
  if (res.error) return vaultErr(ctx, res.error.message)
  if (res.data?.status !== 'ok') return [{ cls: 'err', text: `ACCEPTTRANSFER — ${res.data?.reason || 'failed'}` }]
  setActiveVault(res.data.vault_id)
  return [{ cls: 'ok', text: `▶ ownership of vault "${res.data.vault_id}" accepted. previous owner has been removed.` }]
}

async function vaultDeclineTransfer(token, ctx) {
  if (!ctx.user) return [{ cls: 'err', text: 'DECLINETRANSFER — authentication required.' }]
  if (!token) return [{ cls: 'err', text: 'DECLINETRANSFER — usage: declinetransfer <token>' }]
  if (!ctx.isConfigured) return [{ cls: 'dim', text: 'DECLINETRANSFER — demo mode' }]
  const res = await ctx.supabase.rpc('peek_decline_transfer', { p_token: token })
  if (res.error) return vaultErr(ctx, res.error.message)
  if (res.data?.status !== 'ok') return [{ cls: 'err', text: `DECLINETRANSFER — ${res.data?.reason || 'failed'}` }]
  return [{ cls: 'ok', text: '▶ transfer declined.' }]
}

// ─────── VAULT do* wrappers (used by modal forms and feature flows) ───────

export async function doCreateVault(name, password, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_create_vault', {
    p_name: name,
    p_password: password || null
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  setActiveVault(res.data.vault_id)
  return { ok: true, vault_id: res.data.vault_id, recovery_token: res.data.recovery_token }
}

export async function doInviteToVault(vaultId, username, role, clearance, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_send_vault_invite', {
    p_vault_id: vaultId,
    p_invitee_username: username,
    p_role: role || 'member',
    p_clearance: clearance || 1
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true, token: res.data.token, invitee: res.data.invitee }
}

export async function doSetVaultMember(vaultId, targetUserId, role, clearance, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_set_vault_member', {
    p_vault_id: vaultId,
    p_target_user_id: targetUserId,
    p_role: role,
    p_clearance: clearance
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true }
}

export async function doFireVaultMember(vaultId, targetUserId, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_remove_vault_member', {
    p_vault_id: vaultId,
    p_target_user_id: targetUserId
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true }
}

export async function doResetVaultPassword(vaultId, oldPw, newPw, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_reset_vault_password', {
    p_vault_id: vaultId,
    p_old_password: oldPw,
    p_new_password: newPw
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true }
}

export async function doCreateTransfer(vaultId, username, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_create_transfer', {
    p_vault_id: vaultId,
    p_target_username: username
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true, token: res.data.token }
}

export async function doGrantVisit(vaultId, username, clearance, hours, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_grant_visit', {
    p_vault_id: vaultId,
    p_username: username,
    p_clearance: clearance,
    p_hours: hours
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true }
}

export async function doRevokeVisit(vaultId, username, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_revoke_visit', {
    p_vault_id: vaultId,
    p_username: username
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true }
}

export async function doCreateJoinRequest(vaultId, message, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_create_join_request', {
    p_vault_id: vaultId,
    p_message: message || null
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true, request_id: res.data.request_id }
}

export async function doResolveJoinRequest(requestId, approve, ctx) {
  if (!ctx.user) return { ok: false, reason: 'not_authenticated' }
  if (!ctx.isConfigured) return { ok: false, reason: 'demo_only' }
  const res = await ctx.supabase.rpc('peek_resolve_join_request', {
    p_request_id: requestId,
    p_approve: approve
  })
  if (res.error) return { ok: false, reason: res.error.message }
  if (res.data?.status !== 'ok') return { ok: false, reason: res.data?.reason }
  return { ok: true }
}

// ─────── DEMO-MODE SHIMS ───────

function demoVaultList() {
  return [
    { cls: 'ok',  text: 'YOUR VAULTS (1) — active: 900watts-demo' },
    { cls: 'sys', text: '  900watts-demo      demo HQ             role=owner    vault-clr=4  members=1  ◀ active' },
    { cls: 'dim', text: 'demo mode has a single virtual vault; full tenancy is on the live DB.' }
  ]
}
function demoVaultMembers(_vaultId) {
  return [{ cls: 'dim', text: `VAULTMEMBERS — demo mode: 900watts-demo has 1 member (you).` }]
}
