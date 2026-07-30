import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Treat the app as "configured" only when a real Supabase project URL is present,
// so the placeholder in .env.example / .env falls back to DEMO mode instead of
// trying to talk to a dead host.
const looksReal =
  url &&
  url.includes('supabase.co') &&
  !url.includes('YOUR-PROJECT-REF')

export const isConfigured = Boolean(looksReal && anonKey)
export const SUPABASE_URL = url
export const SUPABASE_ANON_KEY = anonKey

export const supabase = isConfigured ? createClient(url, anonKey) : null
