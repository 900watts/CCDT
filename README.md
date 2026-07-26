# CCDT — Corporate Central Data Terminal

A command terminal for browsing a **company document archive**.
Type a number, get the dossier — same logic as `access [archive number]` in CCDT,
but for internal company records. Backend: **Supabase** (Auth for accounts/passwords + Postgres for the documents).

## Commands

| command | action |
|---------|--------|
| `access <number>` | open archive record `#<number>` (the dossier) |
| `list [n]` | list the `n` most recent archives (default 10) |
| `search <query>` | search archives by title / content |
| `create` | **guided wizard** to author a new archive document |
| `load` / `import` | **import a document from a file** (`.json` / `.txt` / `.md`) |
| `login [email pw]` | authenticate (prompts if no args) |
| `register <email> <pw> <level>` | create an operator account (clearance level 1-4) |
| `logout` | end session |
| `whoami` | show current operator |
| `about` | what this is |
| `clear` | clear screen |
| `help` | command list |

> `access` / `list` / `search` / `create` / `load` require login (it's an internal archive).

### Clearance levels (access control)

Every archive has a **classification** that maps to a required clearance level:

| level | classification |
|-------|---------------|
| 1 | PUBLIC |
| 2 | CONFIDENTIAL |
| 3 | SECRET |
| 4 | TOP SECRET |

An operator can only `access` / `list` / `search` an archive whose required level is
**≤ their own clearance level**. Enforcement is twofold:
- **Server-side (authoritative):** the `archives_read_clearance` RLS policy filters rows
  by `required_clearance(classification) <= user_clearance()`; the `access_archive(p_num)`
  SECURITY DEFINER RPC returns `denied` vs `not_found` precisely.
- **Client-side:** the terminal shows `CLEARANCE INSUFFICIENT` instead of leaking a denied doc.

An operator's clearance level is stored in their Supabase Auth **user metadata**
(`clearance_level`). Set it when you create the account:
- **Dashboard → Authentication → Users → Add user** → set User Metadata to `{ "clearance_level": 2 }`, or
- **`register you@co.com pw 2`** in the terminal (self-service sign-up; needs email confirm off).

### `create` — new document wizard
`create` asks, step by step:
```
ARCHIVE NUMBER:      unique id, e.g. 042
TITLE:               short title
CLASSIFICATION:      PUBLIC | CONFIDENTIAL | SECRET | TOP SECRET
DEPARTMENT:          owning team (optional)
CONTENT:             multi-line body — type, then a blank line to finish
TAGS:                comma separated (optional)
```
Type `cancel` at any prompt to abort. The document is committed to Supabase
(or to the local session in DEMO mode) and is then retrievable with `access <number>`.

### `load` — import a file
`load` opens a file picker. Supported inputs:
- **`.json`** using fields `archive_number, title, classification, department, content, tags`
- **`.txt` / `.md`** — filename becomes the title, file text becomes the content (classification `PUBLIC`)

Imported documents are committed the same way as `create`.

## Quick start (runs immediately, no backend needed)

```bash
npm install
npm run dev
```

Open the printed URL. It boots in **DEMO MODE** with sample archives — try `login`,
then `access 173`, `list`, `search printer`.

## Connect your Supabase backend

1. Create a Supabase project (free tier is fine).
2. Run `supabase/schema.sql` in **SQL Editor** (creates the `archives` table, RLS, sample data).
3. **Authentication → Users → Add user** to create operator accounts (passwords are hashed by Supabase — you never store them).
4. Copy `.env.example` → `.env` and fill in:
   ```
   VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```
   (found at **Project Settings → API**). The app only goes "live" once a real
   `supabase.co` URL is set; the placeholder stays in DEMO MODE.

> A publishable/anon key is already present in `.env` — just replace the
> `VITE_SUPABASE_URL` placeholder with your project's URL.

## Customizing the archive schema

The default `archives` table has: `archive_number, title, classification,
department, content, tags, created_at, updated_at`. If you have a different field
list, edit `supabase/schema.sql` and the dossier renderer in `src/App.jsx`
(`known`/`order` in the `Dossier` component) — the rest of the terminal is schema-agnostic.

## Build

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build
```
