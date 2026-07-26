// Sample archive records used when Supabase is not configured (DEMO mode).
// These mirror the default `archives` schema; replace with your own once the
// real backend is connected.
export const DEMO_ARCHIVES = [
  {
    archive_number: '001',
    title: 'Project Onboarding Dossier',
    classification: 'PUBLIC',
    department: 'Human Resources',
    content:
      'Standard onboarding record for new personnel.\n' +
      'Covers badge issuance, network access, and mandatory briefings.\n' +
      'No special clearance required for reading.',
    tags: ['hr', 'onboarding'],
    created_at: '2026-01-12T09:00:00Z'
  },
  {
    archive_number: '173',
    title: 'Incident Report — Unattended Output Device',
    classification: 'CONFIDENTIAL',
    department: 'Facilities',
    content:
      'A floor printer continued producing documents after logout.\n' +
      'Investigation inconclusive; recommend power-down policy revision.\n' +
      'Access restricted to cleared personnel.',
    tags: ['facilities', 'incident'],
    created_at: '2026-03-04T14:22:00Z'
  },
  {
    archive_number: '682',
    title: 'Legacy System Decommission Plan',
    classification: 'SECRET',
    department: 'Information Technology',
    content:
      'Phased shutdown of the 2009 records mainframe.\n' +
      'Data migration to the Supabase archive completed 2026-Q2.\n' +
      'Contains infrastructure coordinates — handle accordingly.',
    tags: ['it', 'migration', 'infra'],
    created_at: '2026-05-19T11:05:00Z'
  },
  {
    archive_number: '900',
    title: 'Executive Continuity Protocol',
    classification: 'TOP SECRET',
    department: 'Office of the Director',
    content:
      'Succession and continuity plan, activated only on director-level trigger.\n' +
      'Contains physical vault coordinates and recall codes — clearance level 4 required.',
    tags: ['director', 'continuity', 'vault'],
    created_at: '2026-06-30T08:00:00Z'
  }
]
