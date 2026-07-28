// Mutable demo store. When Supabase is not configured, created/loaded
// documents, usernames, and messages live here so the terminal can demonstrate
// the full flow without a backend.
import { DEMO_ARCHIVES } from './demoData'

export const demoStore = [...DEMO_ARCHIVES]
export const demoUsernames = new Map() // lowercase username -> { email, id }
export const demoMessages = [] // { id, sender_id, sender_email, recipient, subject, body, priority, classification, read_at, created_at }

export function addDemoArchive(a) {
  demoStore.push(a)
  return a
}

export function removeDemoArchive(num) {
  const i = demoStore.findIndex((a) => a.archive_number === String(num))
  if (i >= 0) demoStore.splice(i, 1)
  return i >= 0
}

// Update an existing demo archive in place. `originalNumber` is the lookup key
// (the archive_number may have been changed in the editor form); `fields` holds
// the new column values.
export function updateDemoArchive(originalNumber, fields) {
  const a = demoStore.find((x) => x.archive_number === String(originalNumber))
  if (!a) return false
  const keys = ['archive_number', 'title', 'classification', 'department', 'content', 'tags', 'photos']
  for (const k of keys) {
    if (fields[k] !== undefined) a[k] = fields[k]
  }
  return true
}

export function demoUsernameTaken(username) {
  return demoUsernames.has(String(username).toLowerCase())
}

export function demoRegisterUsername(userId, email, username) {
  demoUsernames.set(String(username).toLowerCase(), { email, id: userId })
  return true
}

export function demoLookupByUsername(username) {
  return demoUsernames.get(String(username).toLowerCase()) || null
}

export function demoEmailToId(email) {
  for (const [un, info] of demoUsernames.entries()) {
    if (info.email.toLowerCase() === String(email).toLowerCase()) return info.id
  }
  return null
}

let nextDemoMsgId = 1
export function demoAddMessage(m) {
  const row = { id: `demo-msg-${nextDemoMsgId++}`, read_at: null, ...m }
  demoMessages.push(row)
  return row
}

export function demoMarkRead(msgId) {
  const m = demoMessages.find((x) => x.id === msgId)
  if (m && !m.read_at) {
    m.read_at = new Date().toISOString()
    return true
  }
  return false
}