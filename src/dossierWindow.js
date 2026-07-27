// Spawns a draggable WinBox window rendering an archive dossier — the same
// "access XXX spawns a browser on screen" UX as the original SCiPNET terminal.
import WinBox from 'winbox/src/js/winbox.js'
import 'winbox/dist/css/winbox.min.css'

const CLASS_COLOR = {
  SECRET: '#ff4d6d',
  'TOP SECRET': '#ff4d6d',
  CONFIDENTIAL: '#ffd166',
  PUBLIC: '#38ff9a'
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function openDossierWindow(row) {
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

  const html = `
    <div class="ccdt-dossier">
      <div class="ccdt-dossier__banner" style="color:${color};border-color:${color}">
        ${esc(cls)} — CLEARANCE REQUIRED
      </div>
      <div class="ccdt-dossier__num">ARCHIVE ${esc(row.archive_number)}</div>
      <div class="ccdt-dossier__title">${esc(row.title)}</div>
      <div class="ccdt-dossier__meta"><span>Department</span>${esc(row.department || '—')}</div>
      <div class="ccdt-dossier__meta"><span>Tags</span>${esc(tags)}</div>
      <div class="ccdt-dossier__meta"><span>Created</span>${esc(created)}</div>
      <hr class="ccdt-dossier__rule" />
      <pre class="ccdt-dossier__content">${esc(row.content || '(no content)')}</pre>
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