// Presence — who is currently online.
//
// We use a Supabase Realtime *broadcast* channel (no DB writes), since it
// works anonymously and doesn't depend on any RLS profile row existing. Each
// tab announces itself on join, sends a heartbeat every 15s, and announces
// departure on `beforeunload`. Other tabs learn about everyone by listening
// to the same channel.
//
// This is intentionally best-effort: it's "who is online *in the SPA*",
// not the kind of guaranteed-delivery presence a chat service would need.
// Stale entries are pruned by the heartbeat (anything older than 30s is
// considered gone).

const CHANNEL = 'ccdt:presence'
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const HEARTBEAT_MS = 15_000
const STALE_AFTER_MS = 30_000

// In-memory map keyed by tab id. We don't put this in state — it's a
// purely client-side cache. Commands that need the list query this directly.
const _peers = new Map()

let _channel = null
let _heartbeat = null
let _expirySweep = null
let _myProfile = null  // { id, email, username, clearance_level }

function _getRealtime(supabase) {
  // supabase-js exposes `.channel()` whether the underlying client has
  // realtime configured or not, but `send()`/`on('broadcast')` only work
  // when it does. We feature-detect by looking at .realtime.
  return supabase?.realtime ? supabase.realtime : null
}

function _profileFromUser(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email,
    username: user.user_metadata?.username || null,
    clearance_level: Number(
      user.clearance_level ??
      user.user_metadata?.clearance_level ??
      user.app_metadata?.clearance_level
    ) || 1
  }
}

function _payload() {
  return {
    tab: TAB_ID,
    profile: _myProfile,
    ts: Date.now()
  }
}

function _handleBroadcast(payload) {
  if (!payload) return
  const { tab, profile, ts } = payload
  if (!tab || tab === TAB_ID) return  // ignore our own echoes
  _peers.set(tab, { tab, profile, ts, lastSeen: Date.now() })
}

// Auto-reply to "who" queries by re-broadcasting our own join, so the
// requester gets a fresh snapshot even from peers that haven't pinged
// recently. Guarded against loops: we only respond if the query came
// from someone else, and we send a regular join (not a who), so it
// just updates the requester's peer cache.
function _handleWhoQuery(fromTab) {
  if (!fromTab || fromTab === TAB_ID) return
  if (!_channel || !_myProfile) return
  try {
    _channel.send({ type: 'broadcast', event: 'join', payload: _payload() })
  } catch {}
}

function _pruneStale(now) {
  for (const [tab, peer] of _peers) {
    if (now - (peer.lastSeen || peer.ts || 0) > STALE_AFTER_MS) {
      _peers.delete(tab)
    }
  }
}

// Public: attach presence to a Supabase client + user. Pass `user`=null on
// logout to detach. Safe to call repeatedly — only the first call per session
// wires things up; subsequent calls just update the profile and re-broadcast.
export function bindPresence(supabase, user) {
  if (!supabase) return
  if (user === null) { unbindPresence(); return }

  const rt = _getRealtime(supabase)
  if (!rt) return  // supabase-js loaded without the realtime client (DEMO mode)

  const profile = _profileFromUser(user)
  // Always update the local profile — even if we're already subscribed —
  // so a username claim shows up immediately on every peer's list.
  _myProfile = profile
  if (!profile) return

  if (_channel) {
    // Already subscribed: just re-announce so the new profile propagates.
    try { _channel.send({ type: 'broadcast', event: 'join', payload: _payload() }) } catch {}
    return
  }

  _channel = supabase.channel(CHANNEL, { config: { broadcast: { ack: false } } })
    .on('broadcast', { event: '*' }, (msg) => {
      const payload = msg?.payload
      // Differentiate event types since we subscribed with event:'*'
      const evt = msg?.event || payload?.event
      if (evt === 'who') {
        // Someone is asking who's here — auto-reply with our own profile.
        _handleWhoQuery(payload?.from)
      }
      _handleBroadcast(payload)
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        try { _channel.send({ type: 'broadcast', event: 'join', payload: _payload() }) } catch {}
      }
    })

  _heartbeat = setInterval(() => {
    try { _channel && _channel.send({ type: 'broadcast', event: 'ping', payload: _payload() }) } catch {}
  }, HEARTBEAT_MS)

  _expirySweep = setInterval(() => _pruneStale(Date.now()), HEARTBEAT_MS)

  // Announce departure when this tab is closed / reloaded.
  const leave = () => {
    try { _channel && _channel.send({ type: 'broadcast', event: 'leave', payload: _payload() }) } catch {}
    // best-effort — the realtime socket is about to die anyway
  }
  window.addEventListener('beforeunload', leave)
  window.addEventListener('pagehide', leave)

  // Also handle in-tab navigations (React unmounts). Caller is expected to
  // invoke unbindPresence() on logout.
}

export function unbindPresence() {
  if (_channel) {
    try { _channel.send({ type: 'broadcast', event: 'leave', payload: _payload() }) } catch {}
    try { _channel.unsubscribe() } catch {}
    _channel = null
  }
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null }
  if (_expirySweep) { clearInterval(_expirySweep); _expirySweep = null }
  _myProfile = null
  _peers.clear()
}

// Public: refresh the local peer cache by broadcasting a "who-here" ping
// and waiting a short window for everyone to respond. Returns the updated
// peer list. This is what the `who` command calls so the user sees a live
// snapshot at command time, not whatever was last broadcast.
let _querySeq = 0
export async function refreshPeers(supabase, waitMs = 800) {
  if (!supabase || !_channel || !_myProfile) return getOnlinePeers()
  const seq = ++_querySeq
  try {
    _channel.send({ type: 'broadcast', event: 'who', payload: { seq, from: TAB_ID } })
  } catch {}
  // Wait briefly so peers can respond (they each auto-reply with their profile).
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  // Stale-sweep before returning so dropped tabs don't show up.
  _pruneStale(Date.now())
  return getOnlinePeers()
}

// Public: get the current snapshot of online peers. Includes the current
// tab. Each entry: { tab, profile, ts } where profile is null until the
// peer has broadcast at least once.
export function getOnlinePeers() {
  const peers = [..._peers.values()]
  // Always include self — the broadcast echo isn't realiably received in
  // the same tab, so add ourselves explicitly if we have a profile.
  if (_myProfile && !peers.some((p) => p.profile?.id === _myProfile.id)) {
    peers.push({ tab: TAB_ID, profile: _myProfile, ts: Date.now(), self: true })
  }
  return peers
}

export function getMyPresenceId() { return TAB_ID }
