// Mailbox windows — modeled after SCiPNet Communications.
// `openInboxWindow` shows Inbox + Sent tabs; `openComposeWindow` shows the
// composer; `openMessageWindow` shows a single message and marks it read.
import WinBox from 'winbox/src/js/winbox.js'
import 'winbox/dist/css/winbox.min.css'

import {
  fetchInbox, fetchSent, doSendMessage, doMarkRead, getClearance,
  doResolveJoinRequest, setActiveVault
} from './terminal/commands'
import { isO5 } from './o5'
import { nextZIndex, registerWindow, focusIfExists } from './windowStack'

const CLASS_COLOR = {
  SECRET: '#ff4d6d',
  'TOP SECRET': '#ff4d6d',
  CONFIDENTIAL: '#ffd166',
  PUBLIC: '#38ff9a'
}
const PRIO_COLOR = { urgent: '#ff4d6d', important: '#ffd166', normal: '#888' }

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
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function messageRowHTML(m, folder) {
  const cls = (m.classification || 'PUBLIC').toUpperCase()
  const color = CLASS_COLOR[cls] || '#38ff9a'
  const priColor = PRIO_COLOR[(m.priority || 'normal').toLowerCase()] || '#888'
  const unread = !m.read_at && folder === 'inbox'
  const from = folder === 'inbox'
    ? (m.sender_email || m.sender_username || 'unknown')
    : `to ${esc(m.recipient)}`
  return `
    <div class="ccdt-msg ${unread ? 'ccdt-msg--unread' : ''}" data-id="${esc(m.id)}" data-folder="${folder}">
      <div class="ccdt-msg__head">
        <span class="ccdt-msg__from">${esc(from)}</span>
        <span class="ccdt-msg__prio" style="color:${priColor}">${esc(m.priority || 'normal')}</span>
      </div>
      <div class="ccdt-msg__subj">${esc(m.subject)}</div>
      <div class="ccdt-msg__meta">
        <span class="ccdt-msg__cls" style="color:${color};border-color:${color}">${esc(cls)}</span>
        <span class="ccdt-msg__date">${esc(fmtDate(m.created_at))}</span>
      </div>
    </div>`
}

function renderList(messages, folder) {
  if (!messages.length) {
    return `<div class="ccdt-mail__empty">${folder === 'inbox' ? 'inbox is empty.' : 'no sent messages.'}</div>`
  }
  return messages.map((m) => messageRowRow(m, folder)).join('')
}

// aliasing to avoid name shadowing
function messageRowRow(m, folder) { return messageRowHTML(m, folder) }

export function openInboxWindow(ctx, openMessageWindow) {
  // Dedup: if the inbox is already open, focus it instead of spawning a duplicate.
  if (focusIfExists('mail:inbox')) return

  const html = `
    <div class="ccdt-mail">
      <div class="ccdt-mail__bar">
        <span class="ccdt-mail__title">CCDT MAIL</span>
        <button class="ccdt-mail__compose" id="ccdt-mail-compose">+ NEW MESSAGE</button>
      </div>
      <div class="ccdt-mail__tabs">
        <button class="ccdt-mail__tab ccdt-mail__tab--active" data-tab="inbox">INBOX <span id="ccdt-mail-inbox-count">0</span></button>
        <button class="ccdt-mail__tab" data-tab="sent">SENT <span id="ccdt-mail-sent-count">0</span></button>
      </div>
      <div class="ccdt-mail__list" id="ccdt-mail-list"><div class="ccdt-mail__loading">loading…</div></div>
    </div>`

  const wb = new WinBox({
    title: 'CCDT MAIL — ' + (ctx.user?.email || 'guest'),
    class: 'ccdt-win ccdt-win--mail',
    html,
    background: '#05080a',
    border: '2px solid #11331f',
    x: 'center', y: 'center',
    width: '780px',
    height: '80%',
    minheight: 320,
    index: nextZIndex(),
    // onclose intentionally undefined — see windowStack.js for the inverted
    // semantics gotcha. registerWindow() sets wb.onclose to a wrapper that
    // returns false so WinBox actually unmounts.
    onclose: undefined
  })
  registerWindow('mail:inbox', wb, () => {
    // Cleanup when the window closes (this runs after WinBox unmounts).
    try { wb.body && wb.body.removeEventListener('ccdt:mail:refresh', onRefresh) } catch {}
  })

  const $list = wb.body.querySelector('#ccdt-mail-list')
  const $tabs = wb.body.querySelectorAll('.ccdt-mail__tab')
  const $compose = wb.body.querySelector('#ccdt-mail-compose')
  let currentFolder = 'inbox'

  async function loadFolder(folder) {
    $list.innerHTML = '<div class="ccdt-mail__loading">loading…</div>'
    const rows = folder === 'inbox' ? await fetchInbox(ctx) : await fetchSent(ctx)
    if (!rows.length) {
      $list.innerHTML = `<div class="ccdt-mail__empty">${folder === 'inbox' ? 'inbox is empty.' : 'no sent messages.'}</div>`
    } else {
      $list.innerHTML = rows.map((m) => messageRowHTML(m, folder)).join('')
      $list.querySelectorAll('.ccdt-msg').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.dataset.id
          if (folder === 'inbox') {
            doMarkRead(id, ctx)
          }
          const m = rows.find((r) => r.id === id)
          if (m) openMessageWindow(m, ctx, openInboxWindow.bind(null, ctx, openMessageWindow))
        })
      })
    }
    wb.body.querySelector('#ccdt-mail-inbox-count').textContent =
      folder === 'inbox' ? rows.length : await fetchInbox(ctx).then((r) => r.length)
    wb.body.querySelector('#ccdt-mail-sent-count').textContent =
      folder === 'sent' ? rows.length : await fetchSent(ctx).then((r) => r.length)
  }

  $tabs.forEach((t) => {
    t.addEventListener('click', () => {
      $tabs.forEach((x) => x.classList.remove('ccdt-mail__tab--active'))
      t.classList.add('ccdt-mail__tab--active')
      currentFolder = t.dataset.tab
      loadFolder(currentFolder)
    })
  })

  $compose.addEventListener('click', () => {
    openComposeWindow(ctx, {}, () => loadFolder(currentFolder))
  })

  // Soft refresh — fired by App.jsx's 10s inbox poller when new mail arrives
  // while this window is open. Silently reloads the current folder so the user
  // sees new rows without having to click anything. The registerWindow() call
  // above wires onclose to remove this listener automatically.
  const onRefresh = () => loadFolder(currentFolder)
  wb.body.addEventListener('ccdt:mail:refresh', onRefresh)

  // Initial load
  loadFolder('inbox')

  return wb
}

export function openComposeWindow(ctx, prefill, onSent) {
  prefill = prefill || {}
  const o5 = isO5(ctx)
  const toPlaceholder = o5 ? 'recipient username — or type all / ALL for broadcast' : 'recipient username'
  const html = `
    <div class="ccdt-compose${o5 ? ' ccdt-compose--o5' : ''}">
      <div class="ccdt-compose__title">${o5 ? 'O5 COMPOSE — PLATFORM BROADCAST ENABLED' : 'COMPOSE MESSAGE'}</div>
      <label class="ccdt-compose__lbl">TO <span class="ccdt-compose__hint">${o5 ? '(username or "all" to broadcast)' : '(username)'}</span>
        <input class="ccdt-compose__inp" id="ccdt-c-to" placeholder="${esc(toPlaceholder)}" value="${esc(prefill.recipient || '')}" />
      </label>
      <label class="ccdt-compose__lbl">SUBJECT
        <input class="ccdt-compose__inp" id="ccdt-c-sub" maxlength="200" placeholder="message subject" value="${esc(prefill.subject || '')}" />
      </label>
      <div class="ccdt-compose__row">
        <label class="ccdt-compose__lbl ccdt-compose__lbl--half">PRIORITY
          <select class="ccdt-compose__inp" id="ccdt-c-prio">
            <option value="normal" ${prefill.priority === 'urgent' ? '' : 'selected'}>normal</option>
            <option value="important">important</option>
            <option value="urgent" ${prefill.priority === 'urgent' ? 'selected' : ''}>urgent</option>
            ${o5 ? `<option value="o5" ${prefill.priority === 'o5' ? 'selected' : ''}>o5 (council broadcast)</option>` : ''}
          </select>
        </label>
        <label class="ccdt-compose__lbl ccdt-compose__lbl--half">CLASSIFICATION
          <select class="ccdt-compose__inp" id="ccdt-c-cls">
            <option value="PUBLIC">PUBLIC</option>
            <option value="CONFIDENTIAL">CONFIDENTIAL</option>
            <option value="SECRET">SECRET</option>
            <option value="TOP SECRET">TOP SECRET</option>
            ${o5 ? `<option value="O5">O5 (council-only)</option>` : ''}
          </select>
        </label>
      </div>
      ${o5 ? `<div class="ccdt-compose__o5-hint">O5 — typing <strong>all</strong> in TO broadcasts this message to every user whose clearance &ge; the chosen classification. Subject is auto-tagged <code>[O5 BROADCAST]</code>; priority is forced to <code>o5</code>.</div>` : ''}
      <label class="ccdt-compose__lbl">MESSAGE
        <textarea class="ccdt-compose__inp ccdt-compose__ta" id="ccdt-c-body" maxlength="4000" placeholder="Type your message here…"></textarea>
      </label>
      <div class="ccdt-compose__actions">
        <button class="ccdt-compose__btn" id="ccdt-c-send">${o5 ? 'BROADCAST' : 'SEND'}</button>
        <button class="ccdt-compose__btn ccdt-compose__btn--ghost" id="ccdt-c-cancel">CANCEL</button>
        <span class="ccdt-compose__status" id="ccdt-c-status"></span>
      </div>
    </div>`

  const wb = new WinBox({
    title: o5 ? 'O5 COMPOSE — PLATFORM BROADCAST' : 'COMPOSE MESSAGE',
    class: 'ccdt-win ccdt-win--mail',
    html,
    background: '#05080a',
    border: o5 ? '2px solid #ff4d6d' : '2px solid #11331f',
    x: 'center', y: 'center',
    width: '640px',
    height: '80%',
    minheight: 360,
    index: nextZIndex()
  })

  const $status = wb.body.querySelector('#ccdt-c-status')
  wb.body.querySelector('#ccdt-c-send').addEventListener('click', async () => {
    const recipient = wb.body.querySelector('#ccdt-c-to').value.trim()
    const subject = wb.body.querySelector('#ccdt-c-sub').value.trim()
    const body = wb.body.querySelector('#ccdt-c-body').value
    const priority = wb.body.querySelector('#ccdt-c-prio').value
    const classification = wb.body.querySelector('#ccdt-c-cls').value
    if (!recipient || !subject || !body) {
      $status.textContent = 'recipient, subject, and message are required'
      $status.style.color = '#ff5b5b'
      return
    }
    // O5 broadcast hint: warn if recipient is "all" but priority isn't o5
    const isBroadcast = /^(all|everyone)$/i.test(recipient)
    if (isBroadcast && o5 && priority !== 'o5') {
      $status.textContent = 'broadcast detected — auto-promoting priority to o5.'
      $status.style.color = '#ffd166'
    }
    $status.textContent = isBroadcast ? 'broadcasting…' : 'sending…'
    $status.style.color = '#ffd166'
    const res = await doSendMessage({ recipient, subject, body, priority, classification }, ctx)
    if (res.ok) {
      if (res.broadcast) {
        $status.textContent = `broadcast sent to ${res.broadcast} user(s).`
      } else {
        $status.textContent = `sent to ${res.recipient}`
      }
      $status.style.color = '#38ff9a'
      if (onSent) onSent(res)
      setTimeout(() => wb.close(), 900)
    } else {
      $status.textContent = `failed: ${res.reason}`
      $status.style.color = '#ff5b5b'
    }
  })
  wb.body.querySelector('#ccdt-c-cancel').addEventListener('click', () => wb.close())

  return wb
}

// Detect vault-flow mail types by subject prefix.
// Returns { kind, token } or null if this is a regular message.
function detectVaultMail(msg) {
  const subj = String(msg.subject || '')
  const body = String(msg.body || '')
  // Pull a 36-char UUID-shaped token out of the body for any of the kinds below.
  const tok = (body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0]
  if (subj.startsWith('[VAULT INVITE]')) {
    return { kind: 'invite', token: tok }
  }
  if (subj.startsWith('[VAULT TRANSFER]')) {
    return { kind: 'transfer', token: tok }
  }
  if (subj.startsWith('[JOIN REQUEST]')) {
    // body has 'REQUEST ID: <uuid>' — match that specific label too
    const m = body.match(/REQUEST ID:\s*([0-9a-f-]{36})/i)
    return { kind: 'join_request', token: m ? m[1] : tok }
  }
  if (subj.startsWith('[JOIN REQUEST]') && body.match(/APPROVED|DECLINED/)) {
    return { kind: 'join_request_result', token: null }
  }
  return null
}

export function openMessageWindow(msg, ctx, onBack) {
  const cls = (msg.classification || 'PUBLIC').toUpperCase()
  const color = CLASS_COLOR[cls] || '#38ff9a'
  const priColor = PRIO_COLOR[(msg.priority || 'normal').toLowerCase()] || '#888'
  const isInbox = !!(msg.recipient && !msg.sender_email)
  const senderLabel = msg.sender_email || msg.sender_username || 'unknown'
  const vaultMail = detectVaultMail(msg)
  const actionBar = vaultMail ? renderVaultMailActions(vaultMail, msg, ctx, onBack) : ''

  const html = `
    <div class="ccdt-msgview">
      <div class="ccdt-msgview__bar" style="color:${color};border-color:${color}">${esc(cls)} — ${esc((msg.priority || 'normal').toUpperCase())}</div>
      <div class="ccdt-msgview__subj">${esc(msg.subject)}</div>
      <div class="ccdt-msgview__meta">
        <div><span>FROM</span> ${esc(senderLabel)}</div>
        <div><span>TO</span> ${esc(msg.recipient || '')}</div>
        <div><span>WHEN</span> ${esc(fmtDate(msg.created_at))}</div>
        <div><span>STATUS</span> ${msg.read_at ? 'READ' : 'UNREAD'}</div>
      </div>
      <hr class="ccdt-msgview__rule" />
      <pre class="ccdt-msgview__body">${esc(msg.body)}</pre>
      ${actionBar}
      <div class="ccdt-msgview__actions">
        <button class="ccdt-compose__btn" id="ccdt-msg-reply">REPLY</button>
        <button class="ccdt-compose__btn ccdt-compose__btn--ghost" id="ccdt-msg-close">CLOSE</button>
      </div>
    </div>`

  const wb = new WinBox({
    title: 'MESSAGE — ' + (msg.subject || '').slice(0, 50),
    class: 'ccdt-win ccdt-win--mail',
    html,
    background: '#05080a',
    border: vaultMail ? '2px solid #ffd166' : '2px solid #11331f',
    x: 'center', y: 'center',
    width: '640px',
    height: '74%',
    minheight: 240,
    index: nextZIndex()
  })

  wb.body.querySelector('#ccdt-msg-close').addEventListener('click', () => wb.close())
  wb.body.querySelector('#ccdt-msg-reply').addEventListener('click', () => {
    const replyTo = msg.sender_username || msg.sender_email
    openComposeWindow(ctx, {
      recipient: replyTo,
      subject: 'Re: ' + (msg.subject || '').replace(/^Re:\s*/i, '')
    })
  })

  // Wire the vault-flow buttons
  if (vaultMail) wireVaultMailActions(wb, vaultMail, msg, ctx, onBack)

  return wb
}

// Render the action bar inside the message view based on mail kind.
// Each button gets a data-action attribute the wire-up step reads.
function renderVaultMailActions(vaultMail, msg, ctx) {
  if (vaultMail.kind === 'invite') {
    if (!vaultMail.token) {
      return `<div class="ccdt-msgview__vault-actions">
        <div class="ccdt-msgview__vault-banner">VAULT INVITE — token missing or already used</div>
      </div>`
    }
    return `<div class="ccdt-msgview__vault-actions">
      <div class="ccdt-msgview__vault-banner">VAULT INVITE — click ACCEPT to join, or DECLINE.</div>
      <button class="ccdt-compose__btn ccdt-compose__btn--accept" data-action="acceptinvite" data-token="${esc(vaultMail.token)}">ACCEPT — JOIN VAULT</button>
      <button class="ccdt-compose__btn ccdt-compose__btn--ghost" data-action="close">DISMISS</button>
    </div>`
  }
  if (vaultMail.kind === 'transfer') {
    if (!vaultMail.token) {
      return `<div class="ccdt-msgview__vault-actions">
        <div class="ccdt-msgview__vault-banner">VAULT TRANSFER — token missing or already used</div>
      </div>`
    }
    return `<div class="ccdt-msgview__vault-actions">
      <div class="ccdt-msgview__vault-banner ccdt-msgview__vault-banner--warn">OWNERSHIP TRANSFER — accepting will remove the previous owner.</div>
      <button class="ccdt-compose__btn ccdt-compose__btn--accept" data-action="accepttransfer" data-token="${esc(vaultMail.token)}">ACCEPT — BECOME OWNER</button>
      <button class="ccdt-compose__btn ccdt-compose__btn--danger" data-action="declinetransfer" data-token="${esc(vaultMail.token)}">DECLINE</button>
    </div>`
  }
  if (vaultMail.kind === 'join_request') {
    if (!vaultMail.token) {
      return `<div class="ccdt-msgview__vault-actions">
        <div class="ccdt-msgview__vault-banner">JOIN REQUEST — id missing</div>
      </div>`
    }
    return `<div class="ccdt-msgview__vault-actions">
      <div class="ccdt-msgview__vault-banner">JOIN REQUEST — approve to admit as a permanent member.</div>
      <button class="ccdt-compose__btn ccdt-compose__btn--accept" data-action="approvejoin" data-token="${esc(vaultMail.token)}">APPROVE</button>
      <button class="ccdt-compose__btn ccdt-compose__btn--danger" data-action="declinejoin" data-token="${esc(vaultMail.token)}">DECLINE</button>
    </div>`
  }
  if (vaultMail.kind === 'join_request_result') {
    return `<div class="ccdt-msgview__vault-actions">
      <div class="ccdt-msgview__vault-banner ccdt-msgview__vault-banner--info">JOIN REQUEST UPDATE — see body.</div>
    </div>`
  }
  return ''
}

// Wire the data-action buttons. Each action:
//   1. Calls the matching do*() wrapper (returns { ok, reason, vault_id, ... })
//   2. Re-renders the action bar with the result
//   3. Sets the active vault when applicable
async function wireVaultMailActions(wb, vaultMail, msg, ctx, onBack) {
  const bar = wb.body.querySelector('.ccdt-msgview__vault-actions')
  if (!bar) return

  const showResult = (text, ok) => {
    bar.innerHTML = `<div class="ccdt-msgview__vault-banner ${ok ? 'ccdt-msgview__vault-banner--ok' : 'ccdt-msgview__vault-banner--err'}">${esc(text)}</div>`
  }

  const buttons = wb.body.querySelectorAll('[data-action]')
  buttons.forEach((b) => {
    b.addEventListener('click', async () => {
      const action = b.dataset.action
      const token = b.dataset.token
      // Disable all buttons while we work
      buttons.forEach((x) => { x.disabled = true })
      const setStatus = (t) => { showResult(t, false); bar.querySelector('button')?.remove() }
      if (action === 'close') { wb.close(); return }

      try {
        if (action === 'acceptinvite') {
          const res = await ctx.supabase.rpc('peek_accept_vault_invite', { p_token: token })
          if (res.error) { showResult(`accept failed: ${res.error.message}`, false); return }
          if (res.data?.status !== 'ok') { showResult(`accept denied: ${res.data?.reason || 'unknown'}`, false); return }
          setActiveVault(res.data.vault_id)
          showResult(`joined vault "${res.data.vault_id}" as ${res.data.role}. active vault updated.`, true)
        } else if (action === 'accepttransfer') {
          const res = await ctx.supabase.rpc('peek_accept_transfer', { p_token: token })
          if (res.error) { showResult(`transfer accept failed: ${res.error.message}`, false); return }
          if (res.data?.status !== 'ok') { showResult(`transfer denied: ${res.data?.reason || 'unknown'}`, false); return }
          setActiveVault(res.data.vault_id)
          showResult(`ownership of "${res.data.vault_id}" accepted. previous owner removed.`, true)
        } else if (action === 'declinetransfer') {
          const res = await ctx.supabase.rpc('peek_decline_transfer', { p_token: token })
          if (res.error) { showResult(`decline failed: ${res.error.message}`, false); return }
          if (res.data?.status !== 'ok') { showResult(`decline denied: ${res.data?.reason || 'unknown'}`, false); return }
          showResult(`transfer declined.`, true)
        } else if (action === 'approvejoin' || action === 'declinejoin') {
          const ok = action === 'approvejoin'
          const res = await doResolveJoinRequest(token, ok, ctx)
          if (!res.ok) { showResult(`${action} failed: ${res.reason}`, false); return }
          showResult(ok ? 'join request approved — requester is now a permanent member.' : 'join request declined.', true)
        } else {
          showResult(`unknown action: ${action}`, false)
        }
      } catch (e) {
        showResult(`unexpected error: ${e.message || e}`, false)
      }
    })
  })
}