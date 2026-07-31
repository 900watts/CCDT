// O5 (Council) clearance helpers. The O5 tier is the top of the clearance
// hierarchy: it exists alongside the public L1..L4 levels and unlocks a few
// commands (view-all, promote/demote, broadcast, logs).
//
// Live mode:
//   - O5 is granted by setting `clearance_level: 5` in the auth user's
//     raw_user_meta_data (see migration 004). The user_clearance() SQL
//     function reads it from there.
//   - Promotion/demotion RPC (peek_set_clearance) is O5-only at the SQL
//     layer — non-O5 callers get an "o5_only" reason regardless.
//
// DEMO mode:
//   - O5 is reserved for one email: Suuupercharge900watts@hotmail.com
//     (the founder). Everyone else is capped at MAX_DEMO_CLEARANCE = 4.
//   - Demo promote/demote is a no-op stub that simulates the success path
//     so the UI flow can be exercised.

export const O5_LEVEL = 5
export const MAX_DEMO_CLEARANCE = 4
export const O5_FOUNDER_EMAIL = 'suuupercharge900watts@hotmail.com'

// Resolves the current operator's clearance. In live mode it reflects the
// O5 tier (5); in demo mode it's capped at MAX_DEMO_CLEARANCE unless the
// signed-in email matches the founder address.
export function getClearance(ctx) {
  if (!ctx || !ctx.user) return 1
  const u = ctx.user
  const raw =
    u.clearance_level ??
    u.user_metadata?.clearance_level ??
    u.app_metadata?.clearance_level
  const lvl = Number(raw)
  if (!Number.isFinite(lvl) || lvl <= 0) return 1
  // In demo mode, only the founder email can hold O5; everyone else caps at 4.
  if (!ctx.isConfigured) {
    const email = (u.email || '').toLowerCase()
    if (email !== O5_FOUNDER_EMAIL.toLowerCase()) {
      return Math.min(lvl, MAX_DEMO_CLEARANCE)
    }
  }
  return Math.min(lvl, O5_LEVEL)
}

export function isO5(ctx) {
  return getClearance(ctx) >= O5_LEVEL
}

// Stable display label. "O5 COUNCIL" for level 5, otherwise the L1..L4 form.
export function clearanceLabel(lvl) {
  if (lvl >= O5_LEVEL) return 'O5 COUNCIL'
  if (lvl === 4) return 'L4 TOP SECRET'
  if (lvl === 3) return 'L3 SECRET'
  if (lvl === 2) return 'L2 CONFIDENTIAL'
  return 'L1 PUBLIC'
}
