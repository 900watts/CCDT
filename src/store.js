// Mutable demo store. When Supabase is not configured, created/loaded
// documents live here so `list` / `access` can show them during a session.
import { DEMO_ARCHIVES } from './demoData'

export const demoStore = [...DEMO_ARCHIVES]

export function addDemoArchive(a) {
  demoStore.push(a)
  return a
}
