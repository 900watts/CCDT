# CCDT — agent interface

CCDT is a live corporate archive that exposes a read interface for any
external AI agent (Claude, GPT, Gemini, in-house agents, browser fetch,
curl, etc.). The SPA at https://company-archive-terminal.vercel.app is the
human interface; the `/llms.txt`, `/llms-full.txt`, and `/api/agent.json`
endpoints are the AI-agent interface.

## Two modes

**Public read** (no auth, no sign-up, CORS-open):
- `GET /llms.txt` — short site manifest.
- `GET /llms-full.txt` — every PUBLIC archive as markdown, ready to ingest.
- `GET /api/agent.json` — machine-readable site card (endpoints, counts, current version).
- `GET /api/archives.json` — list of PUBLIC archives as JSON.
- `GET /api/archives/<n>.json|.md|.html` — one PUBLIC archive in three formats.
- `GET /sitemap.xml` — XML sitemap for crawlers.

**Authenticated read/write** (Bearer token from `/api/auth/login` or `/api/auth/register`):
- RLS is enforced the same way as in the SPA: clearance 1 = PUBLIC only, 4 = everything.
- Send `Authorization: Bearer <token>` on any request. The token's user_metadata.clearance_level
  becomes the operator's clearance.
- `GET /api/me` — your id, email, clearance.
- `GET /api/archives.all.json` — list every archive RLS lets you see (including CONFIDENTIAL/SECRET/TOP SECRET up to your clearance).
- `GET /api/archives/<n>.full.json` — one archive at any class RLS allows.
- `POST /api/archives` — create a new archive (you can only create at your own clearance or below).
- `PATCH /api/archives/<n>` — modify (you must be the creator or have clearance >= the record's class).
- `DELETE /api/archives/<n>` — delete (same rules).
- `GET /api/mail/inbox` / `/api/mail/sent` — your messages.
- `GET /api/mail/<id>.json` — read one (auto-marks read).
- `POST /api/mail/send` — send a message to another operator by username.

## Quickstart for an agent

```python
import requests

BASE = "https://company-archive-terminal.vercel.app"
ANON = "<from your .env VITE_SUPABASE_ANON_KEY>"

# 1. Read the site card (no auth)
agent = requests.get(f"{BASE}/api/agent.json").json()
print(agent["name"], agent["public_archive_count"], "PUBLIC archives")

# 2. Pull the full PUBLIC corpus in one shot for ingestion
corpus = requests.get(f"{BASE}/llms-full.txt").text
# feed corpus to your context window

# 3. (Optional) Log in to read SECRET+ records or write
tok = requests.post(
    f"{BASE}/api/auth/login",
    json={"email": "you@example.com", "password": "…"},
).json()["access_token"]
H = {"Authorization": f"Bearer {tok}"}

# 4. Read your clearance
print(requests.get(f"{BASE}/api/me", headers=H).json())

# 5. List everything RLS allows (clearance 1 = PUBLIC only; 2 = +CONFIDENTIAL; etc.)
all_my_archives = requests.get(f"{BASE}/api/archives.all.json", headers=H).json()
for a in all_my_archives["archives"]:
    print(a["archive_number"], a["classification"], a["title"])

# 6. Read a SECRET record
row = requests.get(f"{BASE}/api/archives/682.full.json", headers=H).json()

# 7. Write a new record
new = requests.post(f"{BASE}/api/archives", headers=H, json={
    "archive_number": "AGENT-001",
    "title": "Posted by my agent",
    "classification": "PUBLIC",
    "department": "AI Lab",
    "content": "# Hello\n\nWritten by an MCP-aware agent.",
    "tags": ["agent", "demo"]
}).json()
print(new["archive_number"])
```

## How clearance works

CCDT defines four clearance levels, matching the four archive classifications:

| Level | Name | Can read | Can create |
|---|---|---|---|
| 1 | PUBLIC | PUBLIC | PUBLIC |
| 2 | CONFIDENTIAL | + CONFIDENTIAL | + CONFIDENTIAL |
| 3 | SECRET | + SECRET | + SECRET |
| 4 | TOP SECRET | + TOP SECRET | + TOP SECRET |

The level lives in `auth.user_metadata.clearance_level` of the operator. RLS
in Supabase enforces it on every read. The MCP server enforces the same
limits on every write. CONFIDENTIAL/SECRET/TOP SECRET records are never
visible without a Bearer token.

## Errors

| HTTP | `error` | What it means |
|---|---|---|
| 401 | `auth_required` | The endpoint needs a Bearer token. |
| 401 | `auth_failed` | Token is missing, malformed, or expired. Re-login. |
| 403 | `clearance_insufficient` | Your clearance is too low for this record. |
| 404 | `not_found` | Row doesn't exist or you can't see it. |
| 400 | `bad_request` | Required field missing. |
| 500 | `internal_error` | Server-side bug; the response includes a `message` and a truncated `stack`. |

## URL surface (live)

- https://company-archive-terminal.vercel.app/llms.txt
- https://company-archive-terminal.vercel.app/llms-full.txt
- https://company-archive-terminal.vercel.app/api/agent.json
- https://company-archive-terminal.vercel.app/sitemap.xml
- https://company-archive-terminal.vercel.app/api/archives.json
- https://company-archive-terminal.vercel.app/api/archives/<n>.json
- https://company-archive-terminal.vercel.app/api/archives/<n>.md
- https://company-archive-terminal.vercel.app/api/archives/<n>.html

## License / citation

No formal license. If you re-publish the corpus, please attribute the
source as "CCDT (https://company-archive-terminal.vercel.app)".

## Contact

- Operator: 900watts
- GitHub: https://github.com/900watts/CCDT
