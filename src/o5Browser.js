// O5 activity log browser — internal window that polls the activity_log
// table every 10s and renders new entries as they arrive.
//
// Live mode: peek_log_activity() RPC (migration 004) — O5 sees everything;
// non-O5 sees only their own activity.
// DEMO mode: synthesises a small log from local state so the UI flow can
// be exercised without Supabase.

import WinBox from 'winbox/src/js/winbox.js'
import 'winbox/dist/css/winbox.min.css'

import { fetchActivityLog } from './terminal/commands'
import { nextZIndex, registerWindow, focusIfExists } from './windowStack'
import { clearanceLabel } from './o5'

const POLL_MS = 10_000

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

const ACTION_COLOR = {
  login: 'var(--fg)',
  logout: 'var(--fg-dim)',
  access: 'var(--fg-bright)',
  create: 'var(--pub)',
  edit: 'var(--pub)',
  delete: 'var(--err)',
  send_message: 'var(--fg)',
  broadcast: 'var(--err)',
  promote: 'var(--warn)',
  demote: 'var(--warn)',
  register: 'var(--fg-dim)',
  register_username: 'var(--fg-dim)',
  change_password: 'var(--fg-dim)'
}

function rowHTML(r) {
  const color = ACTION_COLOR[r.action] || 'var(--fg)'
  const actor = r.username ? '@' + r.username : '(unknown)'
  const lvl = r.user_clearance || 1
  let desc = r.target || ''
  if (r.detail) {
    if (r.action === 'create' && r.detail.title) desc = `${r.target} — ${r.detail.title}`
    if (r.action === 'edit' && r.detail.classification) desc = `${r.target} [${r.detail.classification}]`
    if (r.action === 'send_message' && r.detail.subject) desc = `to ${r.detail.recipient} — "${r.detail.subject}"`
    if (r.action === 'broadcast' && r.detail.subject) desc = `to ${r.detail.recipient} — "${r.detail.subject}"`
    if ((r.action === 'promote' || r.action === 'demote') && r.detail.from != null) {
      desc = `${r.target} L${r.detail.from} → L${r.detail.to}`
    }
  }
  return `
    <tr class="ccdt-log__row" data-action="${esc(r.action)}">
      <td class="ccdt-log__time">${esc(fmtDate(r.created_at))}</td>
      <td class="ccdt-log__actor">${esc(actor)} <span class="ccdt-log__lvl">${esc(clearanceLabel(lvl))}</span></td>
      <td class="ccdt-log__action" style="color:${color}">${esc(r.action)}</td>
      <td class="ccdt-log__target">${esc(desc)}</td>
    </tr>`
}

function renderBody(rows, isO5) {
  if (!rows.length) {
    return '<div class="ccdt-log__empty">no activity recorded yet. new entries appear within 10 seconds.</div>'
  }
  const head = `
    <thead>
      <tr>
        <th>TIME</th>
        <th>ACTOR</th>
        <th>ACTION</th>
        <th>TARGET</th>
      </tr>
    </thead>`
  const body = '<tbody>' + rows.map(rowHTML).join('') + '</tbody>'
  return `<table class="ccdt-log__table">${head}${body}</table>
    <div class="ccdt-log__foot">${isO5 ? 'O5 override — viewing the full activity log.' : 'viewing your own activity only.'} auto-refresh every ${POLL_MS / 1000}s.</div>`
}

export function openActivityLogWindow(ctx) {
  if (focusIfExists('o5:logs')) return
  const isO5 = (ctx.user?.clearance_level ?? ctx.user?.user_metadata?.clearance_level ?? 0) >= 5

  const html = `
    <div class="ccdt-log">
      <div class="ccdt-log__bar">
        <span class="ccdt-log__title">CCDT ACTIVITY LOG ${isO5 ? '— O5 OVERRIDE' : ''}</span>
        <span class="ccdt-log__status" id="ccdt-log-status">connecting…</span>
        <button class="ccdt-log__refresh" id="ccdt-log-refresh">REFRESH</button>
      </div>
      <div class="ccdt-log__body" id="ccdt-log-body">
        <div class="ccdt-log__loading">loading activity log…</div>
      </div>
    </div>`

  const wb = new WinBox({
    title: 'ACTIVITY LOG — O5',
    class: 'ccdt-win ccdt-win--o5',
    html,
    background: '#05080a',
    border: '2px solid #ff4d6d',
    x: 'center', y: 'center',
    width: '90%',
    height: '85%',
    minheight: 360,
    index: nextZIndex()
  })
  registerWindow('o5:logs', wb)

  const $body = wb.body.querySelector('#ccdt-log-body')
  const $status = wb.body.querySelector('#ccdt-log-status')
  const $refresh = wb.body.querySelector('#ccdt-log-refresh')
  let stopped = false
  let firstLoad = true

  async function tick() {
    if (stopped) return
    try {
      const rows = await fetchActivityLog(ctx)
      $body.innerHTML = renderBody(rows, isO5)
      $status.textContent = `last refresh: ${new Date().toLocaleTimeString()}`
      $status.style.color = 'var(--fg)'
      if (firstLoad) {
        // Subtle flash on first successful load so the operator sees it.
        $body.classList.add('ccdt-log__body--fresh')
        setTimeout(() => $body && $body.classList.remove('ccdt-log__body--fresh'), 600)
        firstLoad = false
      }
    } catch (e) {
      $status.textContent = `error: ${e?.message || e}`
      $status.style.color = 'var(--err)'
    }
  }

  $refresh.addEventListener('click', tick)
  tick()
  const timer = setInterval(tick, POLL_MS)
  // Stop polling when the window closes.
  wb.onclose = () => {
    stopped = true
    clearInterval(timer)
    return false
  }

  return wb
}
