// O5 emergency broadcast popup.
//
// When the inbox poller detects a priority:o5 message, it calls
// triggerO5Broadcast(msg, ctx). We:
//   1. freeze the terminal with a fullscreen overlay
//   2. show a red-bordered SCiPNet-style warning panel
//   3. wait for either a click OR a 10s timeout
//   4. dismiss → open mailbox + jump to the message
//
// The popup is plain DOM (no WinBox) so it can sit above every modal,
// intercept every pointer event, and reliably freeze the screen. WinBox
// windows are hidden behind the overlay but kept alive — they re-appear
// when the overlay closes.

import { openInboxWindow, openMessageWindow } from './mailboxWindow'
import { fetchMessage, doMarkRead } from './terminal/commands'

let _overlay = null
let _timeoutHandle = null
let _currentMsg = null
let _currentCtx = null

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function _dismiss() {
  if (_timeoutHandle) { clearTimeout(_timeoutHandle); _timeoutHandle = null }
  if (_overlay && _overlay.parentNode) {
    _overlay.parentNode.removeChild(_overlay)
  }
  _overlay = null
  // Open mailbox + jump to the message after dismiss.
  if (_currentMsg && _currentCtx) {
    _openMailboxAndJump(_currentMsg, _currentCtx)
  }
  _currentMsg = null
  _currentCtx = null
}

async function _openMailboxAndJump(msg, ctx) {
  try {
    await doMarkRead(msg.id, ctx)
    // openInboxWindow takes (ctx, onOpen) — when a row is clicked it
    // forwards to openMessageWindow. We instead pre-fetch and open
    // the message directly so it auto-redirects as the spec requires.
    const full = await fetchMessage(msg.id, ctx) || msg
    openMessageWindow(full, ctx)
  } catch {
    openInboxWindow(ctx, (m) => openMessageWindow(m, ctx))
  }
}

export function triggerO5Broadcast(msg, ctx) {
  // If a popup is already up, ignore duplicates — the existing 10s timer
  // handles the next dismiss.
  if (_overlay) return
  _currentMsg = msg
  _currentCtx = ctx

  const overlay = document.createElement('div')
  overlay.className = 'ccdt-o5-overlay'
  overlay.innerHTML = `
    <div class="ccdt-o5-card" role="alertdialog" aria-modal="true">
      <svg class="ccdt-o5-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3 L22 21 L2 21 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <line x1="12" y1="10" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <circle cx="12" cy="18" r="1.1" fill="currentColor"/>
      </svg>
      <div class="ccdt-o5-title">WARNING — ONE (1) EMERGENT MESSAGE TRANSMISSION RECEIVED</div>
      <div class="ccdt-o5-sub">PRIORITY: LEVEL O5/COUNCIL — IMMEDIATE ATTENTION REQUIRED</div>
      <div class="ccdt-o5-from">FROM <strong>${esc(msg.sender_username || msg.sender_email || 'O5 council')}</strong></div>
      <div class="ccdt-o5-subj">"${esc(msg.subject || '(no subject)')}"</div>
      <div class="ccdt-o5-meta">classification: ${esc((msg.classification || 'O5').toUpperCase())} · click anywhere or wait 10s to open</div>
    </div>
  `
  overlay.addEventListener('click', _dismiss, { once: true })
  document.body.appendChild(overlay)
  _overlay = overlay

  // 10-second auto-dismiss.
  _timeoutHandle = setTimeout(_dismiss, 10_000)
}

// Programmatic close — used by tests or manual API.
export function dismissO5Broadcast() {
  if (_overlay) _dismiss()
}

export function isO5PopupActive() {
  return !!_overlay
}
