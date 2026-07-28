// Spawns a draggable WinBox window rendering an archive dossier — the same
// "access XXX spawns a browser on screen" UX as the original SCiPNET terminal.
import WinBox from 'winbox/src/js/winbox.js'
import 'winbox/dist/css/winbox.min.css'
import { md2html } from './markdown'

const CLASS_COLOR = {
  SECRET: '#ff4d6d',
  'TOP SECRET': '#ff4d6d',
  CONFIDENTIAL: '#ffd166',
  PUBLIC: '#38ff9a'
}

// Same map the SQL function `public.required_clearance(text)` uses.
const CLASS_LEVEL = {
  PUBLIC: 1,
  CONFIDENTIAL: 2,
  SECRET: 3,
  'TOP SECRET': 4
}

function requiredLevel(cls) {
  return CLASS_LEVEL[String(cls || 'PUBLIC').toUpperCase()] || 1
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function openDossierWindow(row, opts = {}) {
  if (!row) return null
  const cls = (row.classification || 'PUBLIC').toUpperCase()
  const color = CLASS_COLOR[cls] || '#38ff9a'
  const tags = Array.isArray(row.tags) ? row.tags.join(', ') : row.tags || '—'
  const created = row.created_at
    ? new Date(row.created_at).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      })
    : '—'
  const photos = Array.isArray(row.photos) ? row.photos : []
  const photoGrid = photos.length
    ? `<div class="ccdt-dossier__photos">${photos
        .map(
          (p) =>
            `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="ccdt-dossier__photo"><img src="${esc(
              p.url
            )}" alt="${esc(p.name || '')}" /></a>`
        )
        .join('')}</div>`
    : ''

  const need = requiredLevel(cls)
  const have = Number(opts.operatorClearance)
  const haveKnown = Number.isFinite(have) && have > 0
  const sufficient = haveKnown && have >= need
  const clearanceNote = haveKnown
    ? (sufficient
        ? `requires clearance ${need} · you have ${have}`
        : `requires clearance ${need} · you have ${have} — ACCESS DENIED`)
    : `requires clearance ${need} · your clearance is unknown — sign in again`

  const html = `
    <div class="ccdt-dossier">
      <div class="ccdt-dossier__banner" style="color:${color};border-color:${color}">
        ${esc(cls)} — ${esc(clearanceNote)}
      </div>
      <div class="ccdt-dossier__num">ARCHIVE ${esc(row.archive_number)}</div>
      <div class="ccdt-dossier__title">${esc(row.title)}</div>
      <div class="ccdt-dossier__meta"><span>Department</span>${esc(row.department || '—')}</div>
      <div class="ccdt-dossier__meta"><span>Tags</span>${esc(tags)}</div>
      <div class="ccdt-dossier__meta"><span>Created</span>${esc(created)}</div>
      <hr class="ccdt-dossier__rule" />
      ${photoGrid}
      <div class="ccdt-dossier__content">${md2html(row.content) || '<em>(no content)</em>'}</div>
    </div>`

  return new WinBox({
    title: `ARCHIVE ${row.archive_number} — ${esc(row.title).slice(0, 40)}`,
    class: 'ccdt-win',
    html,
    background: '#0a0f12',
    border: '2px solid #11331f',
    x: 'center',
    y: 'center',
    width: '640px',
    height: '72%',
    minheight: 240,
    index: 9999
  })
}