// CCDT — Model Context Protocol (MCP) server endpoint.
//
// Exposes CCDT's command set to any external AI agent that speaks MCP
// Streamable HTTP (https://modelcontextprotocol.io). Authentication is
// per-request: the caller sends `Authorization: Bearer <supabase_access_token>`
// and the server runs the command with the caller's own JWT — so RLS still
// applies and the agent acts AS the operator, not as the platform.
//
// Endpoints:
//   GET  /api/mcp        — agent discovery card (no auth, human-readable)
//   ANY  /api/mcp        — MCP Streamable HTTP transport
//   GET  /api/mcp/health — liveness probe (no auth)
//
// Deploy: any Vercel project. The function reads VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY from the project env, which the SPA already uses.

import { createClient } from '@supabase/supabase-js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY
const IS_CONFIGURED = Boolean(
  SUPABASE_URL && SUPABASE_URL.includes('supabase.co') && SUPABASE_ANON
)

const CLASSIFICATIONS = ['PUBLIC', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']
const CLASS_LEVEL = {
  PUBLIC: 1, CONFIDENTIAL: 2, SECRET: 3, 'TOP SECRET': 4
}
const requiredLevel = (cls) =>
  CLASS_LEVEL[String(cls || 'PUBLIC').toUpperCase()] || 1

const getClearance = (user) => {
  const raw = user && (user.clearance_level ?? user.user_metadata?.clearance_level)
  const lvl = Number(raw)
  return Number.isFinite(lvl) && lvl > 0 ? Math.min(lvl, 4) : 1
}

// Build a per-request `ctx` object compatible with runCommand / fetchOne /
// fetchList / insertRecord / updateRecord / doDelete / doSendMessage / etc.
async function buildCtx(jwt) {
  if (!IS_CONFIGURED) {
    return { ok: false, reason: 'server misconfigured (no Supabase env)' }
  }
  // Use the caller's JWT to talk to Supabase, so RLS enforces the caller's
  // clearance and not the platform's.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt)
  if (userErr || !userData?.user) {
    return { ok: false, reason: 'invalid or expired token' }
  }
  return {
    ok: true,
    user: userData.user,
    supabase,
    isConfigured: true,
    clearance: getClearance(userData.user),
    username: null // populated lazily by callers that need it
  }
}

// Resolve the caller's username (server-side, RLS-gated by users table).
async function getMyUsername(ctx) {
  if (ctx.username) return ctx.username
  const { data } = await ctx.supabase
    .from('users').select('username').eq('id', ctx.user.id).maybeSingle()
  ctx.username = data?.username || ''
  return ctx.username
}

// Format a `lines[]` result as a single MCP text blob. Tool callers get
// {content:[{type:'text', text: '...'}]}; this preserves cls (ok/err/dim).
function linesToText(lines) {
  if (!Array.isArray(lines) || !lines.length) return '(no output)'
  return lines.map((l) => {
    const tag = l.cls ? `[${l.cls.toUpperCase()}] ` : ''
    return tag + (l.text || '')
  }).join('\n')
}

// --- MCP server factory ----------------------------------------------------

function buildMcpServer(ctx) {
  const server = new McpServer(
    {
      name: 'ccdt',
      version: '1.0.0',
      description:
        'CCDT (Corporate Central Data Terminal) — read/write access to a Supabase-backed corporate archive, ' +
        'mailbox, and clearance-gated document store. Speak MCP Streamable HTTP to /api/mcp and authenticate ' +
        'with `Authorization: Bearer <supabase_access_token>`. ' +
        'See https://modelcontextprotocol.io for the protocol and https://company-archive-terminal.vercel.app/api/mcp for this server card.'
    },
    { capabilities: { tools: {} } }
  )

  // ---- read-only tools ----
  server.registerTool('whoami', {
    title: 'Who am I',
    description:
      'Returns the authenticated operator: id, email, clearance level (1..4), and username (if set).',
    inputSchema: {}
  }, async () => {
    const username = await getMyUsername(ctx)
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: ctx.user.id,
          email: ctx.user.email,
          clearance: ctx.clearance,
          username
        }, null, 2)
      }]
    }
  })

  server.registerTool('help', {
    title: 'CCDT command reference',
    description:
      'Returns a short text reference for the most useful CCDT terminal commands. Use this before composing ' +
      'an action plan against a record.',
    inputSchema: {}
  }, async () => ({
    content: [{
      type: 'text',
      text:
`CCDT — quick command reference for AI agents
============================================

READ
  help                    this reference
  whoami                  your id, clearance, username
  database                list all archives you can read (cards)
  list                    short list of archives you can read
  access <number>         open archive <number> in a viewer (returns full record)
  search <text>           full-text search over titles, content, tags, departments
  mail inbox              list messages you received
  mail sent               list messages you sent
  mail read <id>          read a single message by id
  who                     see other operators

WRITE
  create <number> "title"   create a new archive
  edit   <number>           modify an existing archive
  delete <number>           delete an archive (creator or sufficient clearance)
  mail compose to=<username> subject="..." body="..." [class=<PUBLIC|CONFIDENTIAL|SECRET|TOP SECRET>]

CLEARANCE
  PUBLIC       level 1
  CONFIDENTIAL level 2
  SECRET       level 3
  TOP SECRET   level 4

NUMBERS / IDs
  archive_number is the operator-chosen identifier (e.g. "001", "HR-173"). Not an integer.
  message id is a UUID returned by mail inbox/sent.

USAGE NOTES
  - All write operations require a bearer token.
  - All read operations are filtered by your clearance. SECRET/TOP SECRET records are invisible to lower-clearance operators.
  - For long content, use search rather than walking the whole database.`
    }]
  }))

  server.registerTool('list_archives', {
    title: 'List archives (clearance-filtered)',
    description:
      'Returns all archive rows readable by the current operator (RLS-filtered). ' +
      'Each row: archive_number, title, classification, department, created_at. ' +
      'Use this to discover archive numbers; then `access` for the full body.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional()
        .describe('Max rows to return (default 200).')
    }
  }, async ({ limit }) => {
    const { data, error } = await ctx.supabase
      .from('archives')
      .select('archive_number,title,classification,department,created_at')
      .order('archive_number', { ascending: true })
      .limit(limit ?? 200)
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `LIST FAILED: ${error.message}` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  server.registerTool('access', {
    title: 'Read one archive',
    description:
      'Reads the full record for `archive_number` (clearance-gated). Returns the row ' +
      'as JSON: archive_number, title, classification, department, content (markdown), tags, ' +
      'photos[], created_at, created_by, updated_at. Returns an error if not found or clearance is insufficient.',
    inputSchema: {
      archive_number: z.string().min(1).describe('The archive number, e.g. "001" or "HR-173".')
    }
  }, async ({ archive_number }) => {
    const { data, error } = await ctx.supabase
      .from('archives')
      .select('*')
      .eq('archive_number', String(archive_number))
      .maybeSingle()
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `READ FAILED: ${error.message}` }] }
    }
    if (!data) {
      return { isError: true, content: [{ type: 'text',
        text: `ARCHIVE ${archive_number} NOT FOUND or clearance insufficient (you have level ${ctx.clearance}).` }] }
    }
    if (requiredLevel(data.classification) > ctx.clearance) {
      return { isError: true, content: [{ type: 'text',
        text: `CLEARANCE INSUFFICIENT // ARCHIVE ${archive_number} requires level ${requiredLevel(data.classification)} (${data.classification}); you hold level ${ctx.clearance}.` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  server.registerTool('search', {
    title: 'Full-text search',
    description:
      'Searches title, content, department, and tags for the given query (case-insensitive substring). ' +
      'Returns up to 50 clearance-filtered hits. Useful when you don\'t know the archive_number.',
    inputSchema: {
      query: z.string().min(1).describe('Search string (case-insensitive substring).'),
      classification: z.enum(CLASSIFICATIONS).optional()
        .describe('Optional: limit to this classification level or below.')
    }
  }, async ({ query, classification }) => {
    let q = ctx.supabase.from('archives')
      .select('archive_number,title,classification,department,tags,created_at')
    const like = `%${query}%`
    q = q.or(`title.ilike.${like},content.ilike.${like},department.ilike.${like},tags.cs.{${query}}`)
    const { data, error } = await q.limit(50)
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `SEARCH FAILED: ${error.message}` }] }
    }
    // RLS already filters by clearance, but we also filter the optional
    // `classification` parameter client-side (less than or equal to).
    const clsCap = classification ? requiredLevel(classification) : 4
    const hits = (data || []).filter((r) => requiredLevel(r.classification) <= clsCap)
    return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] }
  })

  // ---- write tools ----
  server.registerTool('create', {
    title: 'Create a new archive',
    description:
      'Inserts a new archive. All fields are required except tags and photos. ' +
      'You may only create records at your own clearance level or below (a level-1 ' +
      'operator can create a PUBLIC record; a level-3 can create up to SECRET). ' +
      'Returns the new row.',
    inputSchema: {
      archive_number: z.string().min(1).describe('Unique archive number, e.g. "HR-173".'),
      title:          z.string().min(1).describe('Document title.'),
      classification: z.enum(CLASSIFICATIONS)
                        .describe('PUBLIC | CONFIDENTIAL | SECRET | TOP SECRET'),
      department:     z.string().describe('Owning department, e.g. "Human Resources".'),
      content:        z.string().describe('Body in Markdown (supports #, **, *, lists, quotes, images, links).'),
      tags:           z.array(z.string()).optional()
                        .describe('Optional list of tags.'),
      photos:         z.array(z.object({
                         url:  z.string().url(),
                         name: z.string().optional()
                       })).optional()
                        .describe('Optional list of pre-uploaded photo URLs (e.g. from Supabase Storage).')
    }
  }, async (args) => {
    if (requiredLevel(args.classification) > ctx.clearance) {
      return { isError: true, content: [{ type: 'text',
        text: `CLEARANCE INSUFFICIENT // you are level ${ctx.clearance}, cannot create ${args.classification}.` }] }
    }
    const record = {
      archive_number: String(args.archive_number).trim(),
      title: String(args.title).trim(),
      classification: String(args.classification).toUpperCase(),
      department: String(args.department).trim(),
      content: String(args.content),
      tags: Array.isArray(args.tags) ? args.tags : [],
      photos: Array.isArray(args.photos) ? args.photos : []
    }
    const { data, error } = await ctx.supabase
      .from('archives').insert(record).select().single()
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `WRITE FAILED: ${error.message}` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  server.registerTool('edit', {
    title: 'Edit an existing archive',
    description:
      'Updates the record at `archive_number` (the lookup key). You must be the creator ' +
      'OR hold clearance >= the record\'s classification. Returns the updated row.',
    inputSchema: {
      archive_number: z.string().min(1).describe('The CURRENT archive_number to look up.'),
      title:          z.string().optional(),
      classification: z.enum(CLASSIFICATIONS).optional(),
      department:     z.string().optional(),
      content:        z.string().optional(),
      tags:           z.array(z.string()).optional(),
      photos:         z.array(z.object({ url: z.string().url(), name: z.string().optional() })).optional()
    }
  }, async (args) => {
    const num = String(args.archive_number)
    // Fetch first so we can check classification vs clearance.
    const { data: existing, error: readErr } = await ctx.supabase
      .from('archives').select('*').eq('archive_number', num).maybeSingle()
    if (readErr) {
      return { isError: true, content: [{ type: 'text', text: `READ FAILED: ${readErr.message}` }] }
    }
    if (!existing) {
      return { isError: true, content: [{ type: 'text', text: `ARCHIVE ${num} NOT FOUND.` }] }
    }
    if (requiredLevel(existing.classification) > ctx.clearance) {
      return { isError: true, content: [{ type: 'text',
        text: `CLEARANCE INSUFFICIENT // ARCHIVE ${num} requires level ${requiredLevel(existing.classification)}; you hold ${ctx.clearance}.` }] }
    }
    // Build the patch from the fields the caller actually passed.
    const patch = {}
    for (const k of ['title', 'classification', 'department', 'content', 'tags', 'photos']) {
      if (args[k] !== undefined) patch[k] = args[k]
    }
    if (Object.keys(patch).length === 0) {
      return { isError: true, content: [{ type: 'text',
        text: 'NO FIELDS TO UPDATE — supply at least one of title/classification/department/content/tags/photos.' }] }
    }
    if (patch.classification && requiredLevel(patch.classification) > ctx.clearance) {
      return { isError: true, content: [{ type: 'text',
        text: `CLEARANCE INSUFFICIENT // cannot raise classification to ${patch.classification} (you are level ${ctx.clearance}).` }] }
    }
    const { data, error } = await ctx.supabase
      .from('archives').update(patch).eq('archive_number', num).select().single()
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `UPDATE FAILED: ${error.message}` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  server.registerTool('delete', {
    title: 'Delete an archive',
    description:
      'Deletes the archive at `archive_number`. You must be the creator OR hold ' +
      'clearance >= the record\'s classification. Returns the deleted archive_number on success.',
    inputSchema: {
      archive_number: z.string().min(1).describe('The archive number to delete.')
    }
  }, async ({ archive_number }) => {
    const num = String(archive_number)
    const { data: existing, error: readErr } = await ctx.supabase
      .from('archives').select('classification,created_by').eq('archive_number', num).maybeSingle()
    if (readErr) {
      return { isError: true, content: [{ type: 'text', text: `READ FAILED: ${readErr.message}` }] }
    }
    if (!existing) {
      return { isError: true, content: [{ type: 'text', text: `ARCHIVE ${num} NOT FOUND.` }] }
    }
    if (requiredLevel(existing.classification) > ctx.clearance) {
      return { isError: true, content: [{ type: 'text',
        text: `CLEARANCE INSUFFICIENT // cannot delete ARCHIVE ${num} (requires level ${requiredLevel(existing.classification)}, you hold ${ctx.clearance}).` }] }
    }
    const { error } = await ctx.supabase
      .from('archives').delete().eq('archive_number', num)
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `DELETE FAILED: ${error.message}` }] }
    }
    return { content: [{ type: 'text', text: `DELETED // ARCHIVE ${num}` }] }
  })

  // ---- mailbox ----
  server.registerTool('mail_inbox', {
    title: 'List inbox messages',
    description: 'Returns the messages you have received, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() }
  }, async ({ limit }) => {
    const { data, error } = await ctx.supabase
      .from('messages')
      .select('id,sender_id,subject,classification,priority,is_read,created_at')
      .eq('recipient_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(limit ?? 50)
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `INBOX FAILED: ${error.message}` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  server.registerTool('mail_sent', {
    title: 'List sent messages',
    description: 'Returns the messages you have sent, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() }
  }, async ({ limit }) => {
    const { data, error } = await ctx.supabase
      .from('messages')
      .select('id,recipient_id,subject,classification,priority,created_at')
      .eq('sender_id', ctx.user.id)
      .order('created_at', { ascending: false })
      .limit(limit ?? 50)
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `SENT FAILED: ${error.message}` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  server.registerTool('mail_read', {
    title: 'Read a single message',
    description:
      'Reads the full body of a message and marks it read. `id` is the UUID returned by ' +
      'mail_inbox / mail_sent.',
    inputSchema: { id: z.string().uuid().describe('Message UUID.') }
  }, async ({ id }) => {
    const { data, error } = await ctx.supabase
      .from('messages')
      .select('id,sender_id,recipient_id,subject,body,classification,priority,is_read,created_at')
      .eq('id', id)
      .maybeSingle()
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `READ FAILED: ${error.message}` }] }
    }
    if (!data) {
      return { isError: true, content: [{ type: 'text', text: `MESSAGE ${id} NOT FOUND.` }] }
    }
    // Mark read (best-effort)
    if (data.recipient_id === ctx.user.id && !data.is_read) {
      await ctx.supabase.from('messages').update({ is_read: true }).eq('id', id)
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  server.registerTool('mail_compose', {
    title: 'Send a message',
    description:
      'Sends a message to another operator by username. The sender must hold clearance ' +
      '>= the message\'s classification.',
    inputSchema: {
      to:           z.string().describe('Recipient username (not email).'),
      subject:      z.string().min(1).describe('Message subject.'),
      body:         z.string().min(1).describe('Message body (Markdown).'),
      classification: z.enum(CLASSIFICATIONS).optional()
                       .describe('PUBLIC (default) | CONFIDENTIAL | SECRET | TOP SECRET.'),
      priority:     z.enum(['normal', 'high']).optional()
                       .describe('normal (default) | high')
    }
  }, async ({ to, subject, body, classification, priority }) => {
    const cls = (classification || 'PUBLIC').toUpperCase()
    if (requiredLevel(cls) > ctx.clearance) {
      return { isError: true, content: [{ type: 'text',
        text: `CLEARANCE INSUFFICIENT // cannot send ${cls} messages (you are level ${ctx.clearance}).` }] }
    }
    // Look up recipient
    const { data: rcpt } = await ctx.supabase
      .from('users').select('id').eq('username', String(to).toLowerCase()).maybeSingle()
    if (!rcpt) {
      return { isError: true, content: [{ type: 'text', text: `RECIPIENT @${to} NOT FOUND.` }] }
    }
    const { data, error } = await ctx.supabase
      .from('messages')
      .insert({
        sender_id: ctx.user.id,
        recipient_id: rcpt.id,
        subject: String(subject),
        body: String(body),
        classification: cls,
        priority: priority === 'high' ? 'high' : 'normal'
      })
      .select()
      .single()
    if (error) {
      return { isError: true, content: [{ type: 'text', text: `SEND FAILED: ${error.message}` }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  })

  return server
}

// --- Vercel function handler ----------------------------------------------

// Stateful mode: keep McpServer + Transport alive across requests, keyed
// on the Mcp-Session-Id. The handler resolves the right session for each
// request, or initializes a fresh one if the client didn't send a session
// header. Vercel function instances are reused across requests, so the
// module-level Map is durable for the lifetime of the instance.
const SESSIONS = new Map() // sessionId -> { server, transport, ctx, id, lastUsed }

// Cap concurrent sessions to avoid memory blow-up. Oldest evicted.
const MAX_SESSIONS = 200
const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes idle

function gcSessions() {
  const now = Date.now()
  for (const [id, sess] of SESSIONS) {
    if (now - sess.lastUsed > SESSION_TTL_MS) SESSIONS.delete(id)
  }
  while (SESSIONS.size > MAX_SESSIONS) {
    const oldest = SESSIONS.keys().next().value
    if (!oldest) break
    SESSIONS.delete(oldest)
  }
}

async function getOrCreateSession(request, ctx) {
  gcSessions()
  const incoming = request.headers.get('mcp-session-id')
  if (incoming && SESSIONS.has(incoming)) {
    const s = SESSIONS.get(incoming)
    s.lastUsed = Date.now()
    return s
  }
  const server = buildMcpServer(ctx)
  const session = { server, transport: null, ctx, id: null, lastUsed: Date.now() }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      session.id = id
      SESSIONS.set(id, session)
    }
  })
  session.transport = transport
  await server.connect(transport)
  return session
}

const SERVER_CARD = {
  name: 'ccdt',
  version: '1.0.0',
  transport: 'streamable-http',
  endpoint: '/api/mcp',
  auth: {
    type: 'bearer',
    description: 'Pass a Supabase access JWT as `Authorization: Bearer <token>`. ' +
                 'The token is used per-request; RLS still applies. Get a token by ' +
                 'calling supabase.auth.signInWithPassword({ email, password }) on the ' +
                 'client, or by signing up at https://company-archive-terminal.vercel.app/ ' +
                 'and then reading the session from the SPA.'
  },
  agent_guide: 'https://company-archive-terminal.vercel.app/api/mcp (this page)',
  mcp: {
    protocol: '2025-06-18',
    initialize: { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '0' } } } },
    tools_call: { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'help', arguments: {} } } }
  },
  tools: [
    'whoami', 'help', 'list_archives', 'access', 'search',
    'create', 'edit', 'delete',
    'mail_inbox', 'mail_sent', 'mail_read', 'mail_compose'
  ]
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, Last-Event-Id',
    'Access-Control-Max-Age': '86400'
  }
}

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extra
    }
  })
}

function authOrError(req) {
  const h = req.headers.get('authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m) {
    return { ok: false, res: jsonResponse({
      error: 'missing_bearer_token',
      message: 'Pass `Authorization: Bearer <supabase_access_token>`. ' +
               'Get one by logging in to the SPA at https://company-archive-terminal.vercel.app/ ' +
               'and reading the session, or by calling supabase.auth.signInWithPassword from your agent.'
    }, 401) }
  }
  return { ok: true, jwt: m[1] }
}

export default async function handler(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  const url = new URL(request.url)

  // Discovery
  if (request.method === 'GET' && (url.pathname === '/api/mcp' || url.pathname === '/api/mcp/')) {
    return jsonResponse(SERVER_CARD)
  }
  if (url.pathname === '/api/mcp/health' || url.pathname === '/api/mcp/health/') {
    return jsonResponse({
      ok: true,
      configured: IS_CONFIGURED,
      supabase_url: SUPABASE_URL ? SUPABASE_URL.replace(/\/\/.+@/, '//***@') : null,
      time: new Date().toISOString()
    })
  }

  // MCP transport
  if (!IS_CONFIGURED) {
    return jsonResponse({ error: 'server_misconfigured',
      message: 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set on this Vercel project.' }, 503)
  }
  const a = authOrError(request)
  if (!a.ok) return a.res
  const ctx = await buildCtx(a.jwt)
  if (!ctx.ok) {
    return jsonResponse({ error: 'auth_failed', message: ctx.reason }, 401)
  }
  const session = await getOrCreateSession(request, ctx)
  return session.transport.handleRequest(request)
}
