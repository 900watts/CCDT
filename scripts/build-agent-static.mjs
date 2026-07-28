// Pre-renders the agent-facing static files into dist/ so any AI agent can
// read CCDT over plain HTTP — no auth, no Vercel function, no MCP, just files
// on a CDN. Run by `npm run prebuild` so the files are always fresh.
//
// Outputs (relative to dist/):
//   llms.txt                site manifest
//   llms-full.txt           every PUBLIC archive as markdown
//   sitemap.xml             standard XML sitemap
//   api/agent.json          machine-readable site card
//   api/archives.json       all PUBLIC archives as JSON
//   api/archives/<n>.json   one PUBLIC archive as JSON
//   api/archives/<n>.md    one PUBLIC archive as markdown
//   api/archives/<n>.html  one PUBLIC archive as rendered HTML
//   api/archives/<n>.full.json  (omitted; only built when an env var is set)
//
// Public means PUBLIC classification only. CONFIDENTIAL/SECRET/TOP SECRET
// records are never exported here — those require a JWT and live behind
// the SPA's login.

import { createClient } from '@supabase/supabase-js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Try to load .env so we can run `node scripts/build-agent-static.mjs` standalone
try {
  const env = await import('node:fs/promises').then(m => m.readFile('.env', 'utf8'))
  for (const line of env.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m) process.env[m[1]] = m[2]
  }
} catch { /* .env optional in build context */ }

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY
const SITE_URL = 'https://company-archive-terminal.vercel.app'
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing; skipping agent static build.')
  process.exit(0)
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: false } })

const CLASS_LEVEL = { PUBLIC: 1, CONFIDENTIAL: 2, SECRET: 3, 'TOP SECRET': 4 }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

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

async function main() {
  console.log('Fetching PUBLIC archives from Supabase…')
  const { data: archives, error } = await sb.from('archives')
    .select('archive_number,title,classification,department,content,tags,photos,created_at,updated_at')
    .eq('classification', 'PUBLIC')
    .order('archive_number', { ascending: true })
  if (error) { console.error('Query failed:', error.message); process.exit(1) }
  console.log(`  found ${archives.length} PUBLIC archive(s).`)

  // Wipe previous agent-facing dir so deleted archives disappear too.
  if (existsSync(resolve(OUT_DIR, 'api'))) {
    rmSync(resolve(OUT_DIR, 'api'), { recursive: true, force: true })
  }
  mkdirSync(resolve(OUT_DIR, 'api', 'archives'), { recursive: true })

  // llms.txt
  const llms = `# CCDT — Corporate Central Data Terminal

> A live corporate archive, publicly readable by any AI agent.

## What this is
CCDT is a public-facing read interface to a Supabase-backed corporate archive.
The SPA at ${SITE_URL} is the human interface; this file (and the endpoints it
lists) is the AI-agent interface.

## What you can read
- ${archives.length} PUBLIC archives, full content.
- Site metadata: who runs it, when it was last updated, how to cite it.
- Structured JSON for every archive and for the site itself.

## What you can NOT read here
- CONFIDENTIAL, SECRET, and TOP SECRET records (gated by clearance, require a
  Supabase JWT — see the SPA at ${SITE_URL}).
- Mailbox content (per-user, requires a JWT).
- The live editor / write tools (requires a JWT).

## URLs

- ${SITE_URL}/llms.txt            (this file)
- ${SITE_URL}/llms-full.txt       (full PUBLIC corpus as markdown)
- ${SITE_URL}/api/agent.json      (machine-readable site card)
- ${SITE_URL}/api/archives.json   (all PUBLIC archives as JSON)
- ${SITE_URL}/api/archives/<n>.json   (one archive as JSON)
- ${SITE_URL}/api/archives/<n>.md     (one archive as markdown)
- ${SITE_URL}/api/archives/<n>.html   (one archive as rendered HTML)
- ${SITE_URL}/sitemap.xml         (XML sitemap for crawlers)

## Authentication (for write access)

The agent interface is read-only and public. To get write access (create /
edit / delete archives, send messages, read your clearance's records), the
SPA at ${SITE_URL} uses Supabase auth — sign up there, get a session token,
and the SPA will use it directly. Agents that need to call Supabase on a
user's behalf can use the same flow programmatically:

  POST {SUPABASE_URL}/auth/v1/token?grant_type=password
    { "email": "...", "password": "..." }
  -> { "access_token": "eyJ…" }

  GET ${SITE_URL}/api/archives/001.json
    Authorization: Bearer eyJ…
  -> 200 with the full record (if your clearance allows)

## License / citation
No formal license; please attribute the source as
"CCDT (${SITE_URL})" if you re-publish the content.

## Contact
- Operator: 900watts
- GitHub: https://github.com/900watts/CCDT
`
  writeFileSync(resolve(OUT_DIR, 'llms.txt'), llms, 'utf8')

  // llms-full.txt
  const llmsFull = `# CCDT — full public corpus

> ${archives.length} PUBLIC archives. Ingested ${new Date().toISOString()}.
> Source: ${SITE_URL}/llms.txt

` + archives.map(renderArchiveMd).join('\n\n---\n\n')
  writeFileSync(resolve(OUT_DIR, 'llms-full.txt'), llmsFull, 'utf8')

  // sitemap.xml
  const urls = [
    `${SITE_URL}/`,
    `${SITE_URL}/llms.txt`,
    `${SITE_URL}/llms-full.txt`,
    `${SITE_URL}/api/agent.json`,
    `${SITE_URL}/api/archives.json`,
    ...archives.map(a => `${SITE_URL}/api/archives/${encodeURIComponent(a.archive_number)}.json`)
  ]
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}
</urlset>`
  writeFileSync(resolve(OUT_DIR, 'sitemap.xml'), sitemap, 'utf8')

  // api/agent.json
  const latest = archives.length
    ? archives.map(a => a.updated_at || a.created_at).filter(Boolean).sort().slice(-1)[0]
    : null
  const card = {
    name: 'CCDT — Corporate Central Data Terminal',
    short_name: 'CCDT',
    url: SITE_URL,
    description: 'A live corporate archive readable by AI agents. PUBLIC records are open; ' +
                 'CONFIDENTIAL/SECRET/TOP SECRET records require a Supabase JWT (RLS-gated by clearance).',
    operator: '900watts',
    last_updated: latest,
    generated_at: new Date().toISOString(),
    public_archive_count: archives.length,
    endpoints: {
      llms_txt:        '/llms.txt',
      llms_full_txt:   '/llms-full.txt',
      agent_card:      '/api/agent.json',
      archives_json:   '/api/archives.json',
      archive_json:    '/api/archives/{n}.json',
      archive_md:      '/api/archives/{n}.md',
      archive_html:    '/api/archives/{n}.html',
      sitemap:         '/sitemap.xml'
    },
    citation: `CCDT (${SITE_URL}) — archive ingested from the public agent interface at /llms-full.txt`
  }
  writeFileSync(resolve(OUT_DIR, 'api', 'agent.json'), JSON.stringify(card, null, 2), 'utf8')

  // api/archives.json
  const listJson = {
    count: archives.length,
    generated_at: new Date().toISOString(),
    archives: archives.map(a => ({
      archive_number: a.archive_number,
      title: a.title,
      classification: a.classification,
      department: a.department,
      tags: a.tags || [],
      created_at: a.created_at,
      updated_at: a.updated_at
    }))
  }
  writeFileSync(resolve(OUT_DIR, 'api', 'archives.json'), JSON.stringify(listJson, null, 2), 'utf8')

  // per-archive JSON / MD / HTML
  for (const a of archives) {
    const num = a.archive_number
    const safe = encodeURIComponent(num)
    writeFileSync(
      resolve(OUT_DIR, 'api', 'archives', `${safe}.json`),
      JSON.stringify(a, null, 2),
      'utf8'
    )
    writeFileSync(
      resolve(OUT_DIR, 'api', 'archives', `${safe}.md`),
      renderArchiveMd(a),
      'utf8'
    )
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(a.title)} — ${esc(num)}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
           background: #05080a; color: #c8d3cd; max-width: 720px;
           margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
    h1, h2, h3 { color: #38ff9a; }
    a { color: #38ff9a; }
    hr { border-color: #11331f; }
    .meta { color: #ff4d6d; font-size: 12px; letter-spacing: 1px; }
    img { max-width: 100%; }
  </style>
</head>
<body>
<p class="meta">${esc(a.classification)} · ${esc(num)} · ${esc(a.department || '—')}</p>
<h1>${esc(a.title)}</h1>
<hr />
${md2html(a.content || '')}
<hr />
<p><a href="${SITE_URL}/">${esc(SITE_URL)}</a></p>
</body>
</html>
`
    writeFileSync(
      resolve(OUT_DIR, 'api', 'archives', `${safe}.html`),
      html,
      'utf8'
    )
  }

  console.log(`Wrote:`)
  console.log(`  /llms.txt`)
  console.log(`  /llms-full.txt`)
  console.log(`  /sitemap.xml`)
  console.log(`  /api/agent.json`)
  console.log(`  /api/archives.json`)
  console.log(`  /api/archives/<n>.{json,md,html}  (${archives.length} files)`)
  console.log('Done.')
}

main().catch((e) => { console.error(e); process.exit(1) })
