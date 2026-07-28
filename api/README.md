# CCDT MCP — agent guide

CCDT exposes a [Model Context Protocol](https://modelcontextprotocol.io) server
so any external AI agent (Claude Desktop, an OpenAI agent, an in-house agent,
another WorkBuddy session, etc.) can talk to the same archive and mailbox the
SPA exposes.

## Endpoint

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/api/mcp`        | none | Server card (name, version, tool list, sample JSON-RPC). |
| `GET`  | `/api/mcp/health` | none | Liveness probe + env sanity (`{ok, configured, time}`). |
| `ANY`  | `/api/mcp`        | **Bearer required** | MCP Streamable HTTP transport. |
| `OPTIONS` | `/api/mcp`     | none | CORS preflight. |

Production URL: `https://company-archive-terminal.vercel.app/api/mcp`

## Authentication

The MCP server authenticates **per request** with a Supabase access JWT:

```
Authorization: Bearer <supabase_access_token>
```

How to get a token:
1. Sign up at https://company-archive-terminal.vercel.app (the SPA `register`
   command), then read `supabase.auth.session.access_token` from the
   browser console (`Application → Local Storage → sb-…-auth-token`).
2. Or call `supabase.auth.signInWithPassword({ email, password })` from your
   agent and read the returned `session.access_token`.
3. Or call the `register` API directly: `POST {SUPABASE_URL}/auth/v1/signup`
   with `{ email, password, options: { data: { clearance_level: N } } }`.

The token carries the operator's clearance (1..4) in `user_metadata.clearance_level`.
RLS in Supabase enforces the same gates the SPA does — a level-1 agent literally
cannot read SECRET archives even if it tries.

## Tools

| Tool | Read/Write | Description |
|---|---|---|
| `whoami`         | R | id, email, clearance, username |
| `help`           | R | command reference for the SPA terminal |
| `list_archives`  | R | clearance-filtered archive list (limit, default 200) |
| `access`         | R | full record by `archive_number` (Markdown body, photos) |
| `search`         | R | case-insensitive substring search over title/content/department/tags |
| `create`         | W | insert a new archive (subject to your clearance) |
| `edit`           | W | patch an existing archive (subject to creator-or-clearance rule) |
| `delete`         | W | delete an archive (creator-or-clearance) |
| `mail_inbox`     | R | messages you received |
| `mail_sent`      | R | messages you sent |
| `mail_read`      | R | one message by id (auto-marks read) |
| `mail_compose`   | W | send a message by recipient username |

Clearance scale: `PUBLIC=1`, `CONFIDENTIAL=2`, `SECRET=3`, `TOP SECRET=4`.

## Protocol

This is a **stateful** MCP server. The flow is:

1. `POST /api/mcp` with `initialize` (no `Mcp-Session-Id` header).
2. Read `Mcp-Session-Id` from the response headers.
3. `POST /api/mcp` with `notifications/initialized` and the session id.
4. `POST /api/mcp` with `tools/list` and the session id.
5. `POST /api/mcp` with `tools/call { name, arguments }` and the session id.
6. Each `POST` body is a JSON-RPC 2.0 message:
   ```json
   {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"access","arguments":{"archive_number":"001"}}}
   ```

Responses are SSE (`event: message\ndata: {…}`) for the initialize call, and
can be JSON for the others — clients should accept both, since the server picks
per-call. Always send `Accept: application/json, text/event-stream`.

## Quickstart (Python)

```python
import os, json, requests

SUPABASE_URL = "https://cyvjgaxshjrnbkzydiuw.supabase.co"
ANON = "..." # from .env
EMAIL = "you@example.com"
PASSWORD = "..."

# 1) log in to get a JWT
tok = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
    headers={"apikey": ANON, "Content-Type": "application/json"},
    json={"email": EMAIL, "password": PASSWORD}).json()["access_token"]

MCP = "https://company-archive-terminal.vercel.app/api/mcp"
H = {"Authorization": f"Bearer {tok}",
     "Content-Type": "application/json",
     "Accept": "application/json, text/event-stream"}

# 2) initialize
r = requests.post(MCP, headers=H, json={
    "jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"0"}}})
sid = r.headers["Mcp-Session-Id"]
H["Mcp-Session-Id"] = sid

# 3) initialized notification
requests.post(MCP, headers=H, json={"jsonrpc":"2.0","method":"notifications/initialized"})

# 4) call a tool
r = requests.post(MCP, headers=H, json={
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{"name":"list_archives","arguments":{"limit": 10}}})
print(r.text)
```

## Errors

- `401 missing_bearer_token` — no Authorization header. Add one.
- `401 auth_failed` — token expired or invalid. Re-login.
- `503 server_misconfigured` — Supabase env vars missing on the Vercel project. (Operator error, not yours.)
- `isError: true` in the tool result — the call was attempted but the platform rejected it (clearance, missing row, RLS). The `text` field explains why.
