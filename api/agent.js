// CCDT — agent interface.
//
// Public, no-auth endpoints let any AI agent discover and read the PUBLIC
// portion of the archive. Optional per-request Bearer auth upgrades the
// caller to a logged-in operator (RLS-gated by their JWT) so they can
// read their own clearance's records, write, and send messages.
//
// Public read (no auth, CORS-open, agents can read freely):
//   GET  /llms.txt                          short site manifest
//   GET  /llms-full.txt                     full PUBLIC corpus as markdown
//   GET  /api/agent.json                    machine-readable site card
//   GET  /api/archives.json                 PUBLIC archives list (JSON)
//   GET  /api/archives/<n>.json             one PUBLIC archive (JSON)
//   GET  /api/archives/<n>.md               one PUBLIC archive (markdown)
//   GET  /api/archives/<n>.html             one PUBLIC archive (rendered HTML)
//   GET  /sitemap.xml                       sitemap for crawlers
//
// Auth-aware (Bearer optional, RLS-gated by the caller's JWT):
//   GET  /api/me                            whoami (the caller's id/clearance)
//   GET  /api/archives.all.json             list including rows RLS allows
//   GET  /api/archives/<n>.full.json        one record (any class RLS allows)
//
// Auth + write (Bearer required):
//   POST /api/auth/register  { email, password, clearance_level, username? }
//   POST /api/auth/login     { email|username, password }
//   GET  /api/mail/inbox?limit=N            received messages
//   GET  /api/mail/sent?limit=N             sent messages
//   GET  /api/mail/<id>.json                one message (marks read)
//   POST /api/mail/send     { to, subject, body, classification?, priority? }
//   POST /api/archives       { archive_number, title, classification, department, content, tags?, photos? }
//   PATCH /api/archives/<n>  { title?, classification?, department?, content?, tags?, photos? }
//   DELETE /api/archives/<n>  creator-or-clearance delete
//
// Convention: pass the same Supabase access JWT the SPA uses
// (Authorization: Bearer <token>). RLS in Supabase still applies, so an
// agent with a level-1 token can never read SECRET/TOP SECRET records
// even by guessing an archive_number. Clearance is read from
// auth.user_metadata.clearance_level.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY
const SITE_URL = 'https://company-archive-terminal.vercel.app'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, User-Agent',
  'Access-Control-Max-Age': '86400'
}

const CLASSIFICATIONS = ['PUBLIC', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']
const CLASS_LEVEL = { PUBLIC: 1, CONFIDENTIAL: 2, SECRET: 3, 'TOP SECRET': 4 }
const requiredLevel = (cls) => CLASS_LEVEL[String(cls || 'PUBLIC').toUpperCase()] || 1
const clearanceFromUser = (u) => {
  const raw = u && (u.clearance_level ?? u.user_metadata?.clearance_level)
  const lvl = Number(raw)
  return Number.isFinite(lvl) && lvl > 0 ? Math.min(lvl, 4) : 1
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra }
  })
}

function textResponse(body, contentType = 'text/plain; charset=utf-8', status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': contentType, ...CORS } })
}

function xmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/xml; charset=utf-8', ...CORS } })
}

// Same Markdown -> HTML as the SPA's src/markdown.js, inlined for zero deps.
function md2html(md) {
  if (!md) return ''
  const lines = String(md).split('\n')
  let html = ''
  let inList = false, inQuote = false
  const closeList = () => { if (inList) { html += '</ul>'; inList = false } }
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false } }
  const inline = (s) => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  for (let raw of lines) {
    if (/^### /.test(raw))      { closeList(); closeQuote(); html += '<h3>' + inline(raw.slice(4)) + '</h3>'; continue }
    if (/^## /.test(raw))       { closeList(); closeQuote(); html += '<h2>' + inline(raw.slice(3)) + '</h2>'; continue }
    if (/^# /.test(raw))        { closeList(); closeQuote(); html += '<h1>' + inline(raw.slice(2)) + '</h1>'; continue }
    if (/^> /.test(raw))        { closeList(); if (!inQuote) { html += '<blockquote>'; inQuote = true } html += '<p>' + inline(raw.slice(2)) + '</p>'; continue }
    if (/^- /.test(raw))        { closeQuote(); if (!inList) { html += '<ul>'; inList = true } html += '<li>' + inline(raw.slice(2)) + '</li>'; continue }
    if (raw.trim() === '')      { closeList(); closeQuote(); continue }
    closeList(); closeQuote()
    html += '<p>' + inline(raw) + '</p>'
  }
  closeList(); closeQuote()
  return html
}

// Build a Supabase client. If a JWT was supplied, talk as the user (so RLS
// applies); otherwise use the anon key (which can only read PUBLIC, since
// the archives table policy is "required_clearance(class) <= user_clearance()"
// and anon defaults to clearance 1 = PUBLIC).
function clientFor(jwt) {
  if (jwt) {
    return createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    })
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

async function getBearerUser(jwt) {
  if (!jwt) return null
  const sb = clientFor(jwt)
  const { data, error } = await sb.auth.getUser(jwt)
  if (error || !data?.user) return null
  return data.user
}

function renderArchiveMd(a) {
  const tags = Array.isArray(a.tags) && a.tags.length ? a.tags.join(', ') : '—'
  const photos = Array.isArray(a.photos) && a.photos.length
    ? '\n\n## Attached photos\n' + a.photos.map(p => `- ![${esc(p.name || '')}](${esc(p.url)})`).join('\n')
    : ''
  return `# ${esc(a.title)}

- **Archive number:** ${esc(a.archive_number)}
- **Classification:** ${esc(a.classification)}
- **Department:** ${esc(a.department || '—')}
- **Tags:** ${esc(tags)}
- **Created:** ${esc(a.created_at || '—')}
- **Updated:** ${esc(a.updated_at || '—')}
- **Source URL:** ${SITE_URL}/api/archives/${encodeURIComponent(a.archive_number)}.json

---

${a.content || ''}
${photos}
`
}

function renderLlmsShort(count) {
  return `# CCDT — Corporate Central Data Terminal

> A live corporate archive, publicly readable by any AI agent.

## What this is
CCDT is a public-facing read interface to a Supabase-backed corporate archive.
The SPA at ${SITE_URL} is the human interface; this file (and the endpoints it
lists) is the AI-agent interface.

## What you can read
- ${count} PUBLIC archives, full content.
- Site metadata: who runs it, when it was last updated, how to cite it.
- Structured JSON for every archive and for the site itself.

## What you can NOT read here without a login
- CONFIDENTIAL, SECRET, and TOP SECRET records (gated by clearance).
- Mailbox content (per-user, requires a JWT).
- The live editor / write tools (requires a JWT).

## Authentication (optional for read, required for write)

To operate as a logged-in user, get a Supabase access token and send it
as \`Authorization: Bearer <token>\` on every request:

  curl -X POST "${SITE_URL}/api/auth/login" \\
       -H "Content-Type: application/json" \\
       -d '{"email":"you@example.com","password":"…"}'
  # -> { "access_token": "eyJ…", "user": { "id": "…", "clearance_level": 2 } }

Then:

  curl "${SITE_URL}/api/archives/002.json" \\
       -H "Authorization: Bearer eyJ…"
  # RLS will return the row only if your clearance is high enough.

Or sign up fresh from your agent:

  curl -X POST "${SITE_URL}/api/auth/register" \\
       -H "Content-Type: application/json" \\
       -d '{"email":"agent@example.com","password":"…","clearance_level":2}'

## URLs

- ${SITE_URL}/llms.txt
- ${SITE_URL}/llms-full.txt
- ${SITE_URL}/api/agent.json
- ${SITE_URL}/api/archives.json
- ${SITE_URL}/api/archives/<number>.json
- ${SITE_URL}/api/archives/<number>.md
- ${SITE_URL}/api/archives/<number>.html
- ${SITE_URL}/sitemap.xml
- ${SITE_URL}/api/me              (auth: who am I as this token?)
- ${SITE_URL}/api/archives.all.json  (auth: list RLS-allowed rows)
- ${SITE_URL}/api/archives/<n>.full.json  (auth: any class RLS allows)
- ${SITE_URL}/api/mail/inbox      (auth: my inbox)
- ${SITE_URL}/api/mail/sent       (auth: my sent)
- ${SITE_URL}/api/mail/send       (auth: send a message)
- ${SITE_URL}/api/archives         (auth: POST create, PATCH/DELETE per row)

## License / citation
No formal license; please attribute the source as
"CCDT (${SITE_URL})" if you re-publish the content.

## Contact
- Operator: 900watts
- GitHub: https://github.com/900watts/CCDT
`
}

function renderLlmsFull(archives) {
  const head = `# CCDT — full public corpus

> ${archives.length} PUBLIC archives. Ingested ${new Date().toISOString()}.
> Source: ${SITE_URL}/llms.txt

`
  return head + archives.map(renderArchiveMd).join('\n\n---\n\n')
}

async function readJson(request) {
  try { return await request.json() } catch { return null }
}

export default async function handler(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    return await route(request)
  } catch (e) {
    return jsonResponse({
      error: 'internal_error',
      message: String(e?.message || e),
      stack: String(e?.stack || '').slice(0, 1500)
    }, 500)
  }
}

async function route(request) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const authHeader = request.headers.get('authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  const jwt = m ? m[1] : null
  const user = await getBearerUser(jwt)
  const sb = clientFor(jwt)
  const clearance = user ? clearanceFromUser(user) : 1

  // ---- public read endpoints (no auth required) ----

  if (path === '/llms.txt') {
    const { data } = await sb.from('archives').select('id').eq('classification', 'PUBLIC')
    return textResponse(renderLlmsShort(data?.length ?? 0), 'text/plain; charset=utf-8')
  }
  if (path === '/llms-full.txt') {
    const { data } = await sb.from('archives')
      .select('archive_number,title,classification,department,content,tags,photos,created_at,updated_at')
      .eq('classification', 'PUBLIC')
      .order('archive_number', { ascending: true })
    return textResponse(renderLlmsFull(data || []), 'text/markdown; charset=utf-8')
  }
  if (path === '/api/agent' || path === '/api/agent.json') {
    const { data: pub } = await sb.from('archives').select('id').eq('classification', 'PUBLIC')
    const { data: all } = await sb.from('archives').select('id,updated_at,created_at')
    const latest = (all || [])
      .map(r => r.updated_at || r.created_at).filter(Boolean).sort().slice(-1)[0] || null
    return jsonResponse({
      name: 'CCDT — Corporate Central Data Terminal',
      short_name: 'CCDT',
      url: SITE_URL,
      description: 'A live corporate archive readable by AI agents. PUBLIC records are open; ' +
                   'CONFIDENTIAL/SECRET/TOP SECRET records require a Bearer token (RLS-gated by clearance).',
      operator: '900watts',
      last_updated: latest,
      generated_at: new Date().toISOString(),
      public_archive_count: pub?.length ?? 0,
      rls_visible_to_you: all?.length ?? 0,
      your_clearance: clearance,
      endpoints: {
        public: {
          llms_txt:        '/llms.txt',
          llms_full_txt:   '/llms-full.txt',
          agent_card:      '/api/agent.json',
          archives_json:   '/api/archives.json',
          archive_json:    '/api/archives/{n}.json',
          archive_md:      '/api/archives/{n}.md',
          archive_html:    '/api/archives/{n}.html',
          sitemap:         '/sitemap.xml'
        },
        auth_optional: {
          me:              '/api/me',
          archives_all:    '/api/archives.all.json',
          archive_full:    '/api/archives/{n}.full.json'
        },
        auth_required: {
          register:        'POST /api/auth/register',
          login:           'POST /api/auth/login',
          mail_inbox:      'GET  /api/mail/inbox',
          mail_sent:       'GET  /api/mail/sent',
          mail_read:       'GET  /api/mail/{id}.json',
          mail_send:       'POST /api/mail/send',
          archive_create:  'POST /api/archives',
          archive_update:  'PATCH /api/archives/{n}',
          archive_delete:  'DELETE /api/archives/{n}'
        }
      },
      auth: {
        type: 'bearer',
        description: 'Pass a Supabase access JWT (the same one the SPA uses) as `Authorization: Bearer <token>`.',
        how_to_login:  'POST /api/auth/login with { email|username, password }',
        how_to_register: 'POST /api/auth/register with { email, password, clearance_level, username? }'
      }
    })
  }

  // /api/archives.json (GET only; POST is handled by the write branch below)
  if (request.method === 'GET' && (path === '/api/archives' || path === '/api/archives.json')) {
    const { data, error } = await sb.from('archives')
      .select('archive_number,title,classification,department,tags,created_at,updated_at')
      .order('archive_number', { ascending: true })
    if (error) return jsonResponse({ error: 'query_failed', message: error.message }, 500)
    return jsonResponse({
      count: data?.length ?? 0,
      scope: user ? 'rls_visible_to_you' : 'public_only',
      your_clearance: clearance,
      generated_at: new Date().toISOString(),
      archives: data || []
    })
  }

  // /api/archives.all.json (auth optional, but useful)
  if (path === '/api/archives.all.json') {
    const { data, error } = await sb.from('archives')
      .select('archive_number,title,classification,department,tags,content,created_at,updated_at')
      .order('archive_number', { ascending: true })
    if (error) return jsonResponse({ error: 'query_failed', message: error.message }, 500)
    return jsonResponse({
      count: data?.length ?? 0,
      scope: user ? 'rls_visible_to_you' : 'public_only',
      your_clearance: clearance,
      generated_at: new Date().toISOString(),
      archives: data || []
    })
  }

  // /api/archives/<n>.<fmt>  OR  /api/archives/<n>  (GET only)
  // Routes:
  //   /api/archives/<n>         -> JSON, PUBLIC-only
  //   /api/archives/<n>.json    -> JSON, PUBLIC-only
  //   /api/archives/<n>.md      -> Markdown, PUBLIC-only
  //   /api/archives/<n>.html    -> HTML,    PUBLIC-only
  //   /api/archives/<n>.full.json -> JSON, RLS-allowed classes
  if (request.method === 'GET') {
    let num, fmt, allowAny
    const fullJson = /^\/api\/archives\/([^/]+?)\.full\.json$/.exec(path)
    const anyFmt   = /^\/api\/archives\/([^/]+?)\.(\w+)$/.exec(path)
    const bare     = /^\/api\/archives\/([^/]+)$/.exec(path)
    if (fullJson) { num = decodeURIComponent(fullJson[1]); fmt = 'json'; allowAny = true }
    else if (anyFmt) { num = decodeURIComponent(anyFmt[1]); fmt = anyFmt[2]; allowAny = false }
    else if (bare)   { num = decodeURIComponent(bare[1]);    fmt = 'json'; allowAny = false }
    if (num) {
      let q = sb.from('archives')
        .select('archive_number,title,classification,department,content,tags,photos,created_at,updated_at,created_by')
        .eq('archive_number', num)
      if (!allowAny) q = q.eq('classification', 'PUBLIC')
      const { data, error } = await q.maybeSingle()
      if (error) return jsonResponse({ error: 'query_failed', message: error.message }, 500)
      if (!data) {
        return jsonResponse({
          error: 'not_found',
          message: `Archive ${num} is not visible to you (PUBLIC-only mode: not PUBLIC; full mode: clearance too low or does not exist).`
        }, 404)
      }
      if (fmt === 'md' || fmt === 'markdown') return textResponse(renderArchiveMd(data), 'text/markdown; charset=utf-8')
      if (fmt === 'html') return textResponse(md2html(data.content || ''), 'text/html; charset=utf-8')
      return jsonResponse(data)
    }
  }

  // sitemap
  if (path === '/sitemap.xml') {
    const { data } = await sb.from('archives')
      .select('archive_number').eq('classification', 'PUBLIC')
      .order('archive_number', { ascending: true })
    const urls = [
      `${SITE_URL}/`,
      `${SITE_URL}/llms.txt`,
      `${SITE_URL}/llms-full.txt`,
      `${SITE_URL}/api/agent.json`,
      `${SITE_URL}/api/archives.json`,
      `${SITE_URL}/api/archives.all.json`,
      ...(data || []).map(a => `${SITE_URL}/api/archives/${encodeURIComponent(a.archive_number)}.json`)
    ]
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}
</urlset>`)
  }

  // ---- auth-aware endpoints ----

  if (path === '/api/me') {
    if (!user) return jsonResponse({ error: 'auth_required', hint: 'POST /api/auth/login or /api/auth/register' }, 401)
    return jsonResponse({
      id: user.id,
      email: user.email,
      clearance_level: clearance,
      user_metadata: user.user_metadata || {}
    })
  }

  if (path === '/api/auth/login' && request.method === 'POST') {
    const body = await readJson(request) || {}
    const { email, username, password } = body
    if (!password || (!email && !username)) {
      return jsonResponse({ error: 'bad_request', message: 'email or username, and password, are required' }, 400)
    }
    // If username given, resolve to email via the users table (read as anon — but
    // RLS may block that; fall back to treating username as email).
    let loginEmail = email
    if (!loginEmail && username) loginEmail = username
    const sb2 = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } })
    const { data, error } = await sb2.auth.signInWithPassword({ email: loginEmail, password })
    if (error) return jsonResponse({ error: 'login_failed', message: error.message }, 401)
    return jsonResponse({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: data.session.token_type,
      user: {
        id: data.user.id,
        email: data.user.email,
        clearance_level: clearanceFromUser(data.user)
      }
    })
  }

  if (path === '/api/auth/register' && request.method === 'POST') {
    const body = await readJson(request) || {}
    const { email, password, clearance_level, username } = body
    if (!email || !password) {
      return jsonResponse({ error: 'bad_request', message: 'email and password are required' }, 400)
    }
    const lvl = Number(clearance_level)
    if (!Number.isFinite(lvl) || lvl < 1 || lvl > 4) {
      return jsonResponse({ error: 'bad_request', message: 'clearance_level must be 1..4' }, 400)
    }
    const sb2 = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } })
    const { data, error } = await sb2.auth.signUp({
      email, password,
      options: { data: { clearance_level: lvl, username: username || '' } }
    })
    if (error) return jsonResponse({ error: 'register_failed', message: error.message }, 400)
    if (username) {
      // Try to claim the username in the users table (best-effort; RLS
      // requires a profile row, which the trigger should create).
      try {
        const sbAuth = createClient(SUPABASE_URL, SUPABASE_ANON, {
          global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
          auth: { persistSession: false }
        })
        await sbAuth.from('users').upsert({
          id: data.user.id,
          username: String(username).toLowerCase(),
          email: data.user.email
        })
      } catch { /* best-effort */ }
    }
    return jsonResponse({
      access_token: data.session?.access_token || null,
      refresh_token: data.session?.refresh_token || null,
      user: {
        id: data.user.id,
        email: data.user.email,
        clearance_level: lvl
      },
      note: data.session
        ? 'Logged in.'
        : 'Account created. Email confirmation may be required; check your inbox, then POST /api/auth/login.'
    })
  }

  // ---- write endpoints (auth required) ----

  if (path === '/api/archives' && request.method === 'POST') {
    if (!user) return jsonResponse({ error: 'auth_required' }, 401)
    const body = await readJson(request) || {}
    const { archive_number, title, classification, department, content, tags, photos } = body
    if (!archive_number || !title) return jsonResponse({ error: 'bad_request', message: 'archive_number and title required' }, 400)
    if (!CLASSIFICATIONS.includes(String(classification || 'PUBLIC').toUpperCase())) {
      return jsonResponse({ error: 'bad_request', message: 'classification must be PUBLIC/CONFIDENTIAL/SECRET/TOP SECRET' }, 400)
    }
    if (requiredLevel(classification) > clearance) {
      return jsonResponse({ error: 'clearance_insufficient',
        message: `You are clearance ${clearance}; cannot create ${classification} (requires ${requiredLevel(classification)}).` }, 403)
    }
    const record = {
      archive_number: String(archive_number).trim(),
      title: String(title).trim(),
      classification: String(classification).toUpperCase(),
      department: String(department || '').trim(),
      content: String(content || ''),
      tags: Array.isArray(tags) ? tags : [],
      photos: Array.isArray(photos) ? photos : []
    }
    const { data, error } = await sb.from('archives').insert(record).select().single()
    if (error) return jsonResponse({ error: 'write_failed', message: error.message }, 400)
    return jsonResponse(data, 201)
  }

  const updateMatch = /^\/api\/archives\/([^/]+)$/.exec(path)
  if (updateMatch && (request.method === 'PATCH' || request.method === 'DELETE' || request.method === 'PUT')) {
    if (!user) return jsonResponse({ error: 'auth_required' }, 401)
    const num = decodeURIComponent(updateMatch[1])
    const { data: existing, error: readErr } = await sb.from('archives')
      .select('classification,created_by').eq('archive_number', num).maybeSingle()
    if (readErr) return jsonResponse({ error: 'query_failed', message: readErr.message }, 500)
    if (!existing) return jsonResponse({ error: 'not_found' }, 404)
    if (requiredLevel(existing.classification) > clearance) {
      return jsonResponse({ error: 'clearance_insufficient',
        message: `Archive ${num} is ${existing.classification} (requires ${requiredLevel(existing.classification)}); you hold ${clearance}.` }, 403)
    }
    if (request.method === 'DELETE') {
      const { error } = await sb.from('archives').delete().eq('archive_number', num)
      if (error) return jsonResponse({ error: 'delete_failed', message: error.message }, 400)
      return jsonResponse({ deleted: num })
    }
    const body = await readJson(request) || {}
    if (body.classification && requiredLevel(body.classification) > clearance) {
      return jsonResponse({ error: 'clearance_insufficient',
        message: `Cannot raise to ${body.classification} (requires ${requiredLevel(body.classification)}); you hold ${clearance}.` }, 403)
    }
    const patch = {}
    for (const k of ['title', 'classification', 'department', 'content', 'tags', 'photos']) {
      if (body[k] !== undefined) patch[k] = body[k]
    }
    if (Object.keys(patch).length === 0) return jsonResponse({ error: 'bad_request', message: 'no patchable fields supplied' }, 400)
    const { data, error } = await sb.from('archives').update(patch).eq('archive_number', num).select().single()
    if (error) return jsonResponse({ error: 'update_failed', message: error.message }, 400)
    return jsonResponse(data)
  }

  // ---- mail ----

  if (path === '/api/mail/inbox') {
    if (!user) return jsonResponse({ error: 'auth_required' }, 401)
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100)
    // The recipient column is the operator's username (per the SQL trigger
    // that resolves it from the auth.uid() → users.username lookup).
    const sbUser = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false }
    })
    const { data: me } = await sbUser.from('users').select('username').eq('id', user.id).maybeSingle()
    if (!me?.username) return jsonResponse({ count: 0, messages: [] })
    const { data, error } = await sb.from('messages')
      .select('id,sender_id,subject,classification,priority,read_at,created_at')
      .eq('recipient', me.username)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) return jsonResponse({ error: 'query_failed', message: error.message }, 500)
    return jsonResponse({ count: data?.length ?? 0, messages: data || [] })
  }
  if (path === '/api/mail/sent') {
    if (!user) return jsonResponse({ error: 'auth_required' }, 401)
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100)
    const { data, error } = await sb.from('messages')
      .select('id,recipient,subject,classification,priority,created_at')
      .eq('sender_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) return jsonResponse({ error: 'query_failed', message: error.message }, 500)
    return jsonResponse({ count: data?.length ?? 0, messages: data || [] })
  }
  const msgMatch = /^\/api\/mail\/([^/]+?)(?:\.json)?$/.exec(path)
  if (msgMatch && request.method === 'GET') {
    if (!user) return jsonResponse({ error: 'auth_required' }, 401)
    const id = msgMatch[1]
    const { data, error } = await sb.from('messages')
      .select('id,sender_id,recipient,subject,body,classification,priority,read_at,created_at')
      .eq('id', id).maybeSingle()
    if (error) return jsonResponse({ error: 'query_failed', message: error.message }, 500)
    if (!data) return jsonResponse({ error: 'not_found' }, 404)
    if (!data.read_at && data.recipient === user.id) {
      await sb.from('messages').update({ read_at: new Date().toISOString() }).eq('id', id)
    }
    return jsonResponse(data)
  }
  if (path === '/api/mail/send' && request.method === 'POST') {
    if (!user) return jsonResponse({ error: 'auth_required' }, 401)
    const body = await readJson(request) || {}
    const { to, subject, body: mbody, classification, priority } = body
    if (!to || !subject || !mbody) {
      return jsonResponse({ error: 'bad_request', message: 'to, subject, body are required' }, 400)
    }
    const cls = String(classification || 'PUBLIC').toUpperCase()
    if (requiredLevel(cls) > clearance) {
      return jsonResponse({ error: 'clearance_insufficient',
        message: `You are clearance ${clearance}; cannot send ${cls} (requires ${requiredLevel(cls)}).` }, 403)
    }
    const { data, error } = await sb.from('messages').insert({
      sender_id: user.id, recipient: String(to).toLowerCase(),
      subject: String(subject), body: String(mbody),
      classification: cls, priority: priority === 'high' ? 'high' : 'normal'
    }).select().single()
    if (error) return jsonResponse({ error: 'send_failed', message: error.message }, 400)
    return jsonResponse(data, 201)
  }

  return jsonResponse({
    error: 'not_found',
    path,
    hint: 'See /api/agent.json for the full endpoint list.'
  }, 404)
}

export const config = {
  runtime: 'nodejs',
  regions: ['iad1'],
  maxDuration: 30
}
