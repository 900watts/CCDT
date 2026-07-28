# CCDT — agent interface

CCDT exposes a public, no-auth, agent-friendly read interface at
`https://company-archive-terminal.vercel.app`. Any AI agent (Claude,
GPT, Gemini, in-house, an MCP client, a curl one-liner) can discover
and read the **PUBLIC** portion of the archive with no sign-up.

## The discovery surface

| URL | What you get |
|---|---|
| https://company-archive-terminal.vercel.app/llms.txt | Short site manifest. Where to start. |
| https://company-archive-terminal.vercel.app/llms-full.txt | Every PUBLIC archive concatenated as one big Markdown file, ready to ingest. |
| https://company-archive-terminal.vercel.app/api/agent.json | Machine-readable site card. Tells your agent what endpoints exist, how many PUBLIC archives there are, when the site was last updated, and how to cite it. |
| https://company-archive-terminal.vercel.app/api/archives.json | Array of all PUBLIC archives (summary fields only). |
| https://company-archive-terminal.vercel.app/api/archives/{n}.json | One PUBLIC archive as JSON, full body. |
| https://company-archive-terminal.vercel.app/api/archives/{n}.md | One PUBLIC archive as Markdown. |
| https://company-archive-terminal.vercel.app/api/archives/{n}.html | One PUBLIC archive as rendered HTML (for visual review). |
| https://company-archive-terminal.vercel.app/sitemap.xml | Standard XML sitemap. |

All of these are **public, CORS-open, no auth, served as plain static files**
on Vercel's CDN. There is no Vercel function, no cold start, no auth flow —
agents can pull them in milliseconds.

## How a typical agent reads CCDT

```bash
# 1) Discover what's available
curl https://company-archive-terminal.vercel.app/api/agent.json

# 2) Pull the full PUBLIC corpus in one shot for ingestion
curl https://company-archive-terminal.vercel.app/llms-full.txt

# 3) Or read a single record you care about
curl https://company-archive-terminal.vercel.app/api/archives/001.md
```

For programmatic clients:

```python
import requests
BASE = "https://company-archive-terminal.vercel.app"

# 1) Read the site card
agent = requests.get(f"{BASE}/api/agent.json").json()
print(agent["name"], agent["public_archive_count"], "PUBLIC archives")

# 2) Pull the corpus
corpus = requests.get(f"{BASE}/llms-full.txt").text
# feed corpus into your context window
```

## For write access

This interface is read-only. To create / edit / delete archives, send
messages, or read CONFIDENTIAL/SECRET/TOP SECRET records, agents act
**as a logged-in user** by:

1. Going to https://company-archive-terminal.vercel.app and using the
   SPA's `register` command to create an account (clearance 1..4).
2. Grabbing the Supabase access token from the SPA's session storage
   (or by calling `POST {SUPABASE_URL}/auth/v1/token?grant_type=password`
   directly with the email/password).
3. Sending `Authorization: Bearer <token>` on any direct Supabase
   request. RLS enforces the same clearance rules the SPA uses, so a
   level-1 token can never read SECRET records.

There is **no programmatic write API on the static interface** by design
— write access is per-user and always goes through the SPA's Supabase
session, so the platform can audit who did what.

## How it works under the hood

`scripts/build-agent-static.mjs` runs at build time (as the `prebuild`
+ post-build step in `package.json`). It queries Supabase for the
current set of PUBLIC archives and writes them to `dist/`. Vercel
serves the whole `dist/` directory as a static CDN, so the agent
interface is always up-to-date with the latest PUBLIC data and there's
nothing to spin up at request time.

If a previously-PUBLIC archive gets reclassified to CONFIDENTIAL/SECRET/TOP
SECRET, the build removes its files from `dist/api/archives/`. If a new
PUBLIC archive is added, the next build creates files for it. Always
re-deploy to refresh the agent interface.

## License / citation

No formal license. If you re-publish the corpus, please attribute the
source as

> CCDT (https://company-archive-terminal.vercel.app)

## Contact

- Operator: 900watts
- GitHub: https://github.com/900watts/CCDT
