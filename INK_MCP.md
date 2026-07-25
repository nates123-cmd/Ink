# Ink MCP

A remote MCP connector for Ink, built on the same pattern as Course+: one
Supabase Edge Function that is simultaneously an MCP server over Streamable
HTTP and a minimal OAuth 2.1 authorization server with PKCE, gated to a single
email.

## File placement

```
Ink/
  supabase/
    functions/ink-mcp/index.ts     ← the server
    migrations/ink_mcp.sql          ← run in the SQL editor
  mcp-login.html                    ← repo root, served by GitHub Pages
```

`mcp-login.html` has to go at the repo root (or wherever your Pages site
serves from) because Supabase's functions domain rewrites `text/html` to
`text/plain` as an anti-phishing measure. Same reason Course+ hosts its login
page on Pages.

## Deploy

```bash
# 1. migration — paste ink_mcp.sql into the Supabase SQL editor and run

# 2. secrets
supabase secrets set INK_MCP_ALLOWED_EMAIL=nates123@gmail.com
supabase secrets set INK_MCP_LOGIN_URL=https://nates123-cmd.github.io/Ink/mcp-login.html
# optional: INK_MCP_READONLY=1

# 3. function (own auth, so JWT verification off)
supabase functions deploy ink-mcp --no-verify-jwt

# 4. push mcp-login.html to the Ink repo, confirm it loads on Pages
```

Then in claude.ai: Settings → Connectors → Add custom connector →

```
https://xsmnfcmtbpeaccnyinkr.supabase.co/functions/v1/ink-mcp
```

Smoke test — should return a 401 with a `WWW-Authenticate` header, not a 404:

```bash
curl -i https://xsmnfcmtbpeaccnyinkr.supabase.co/functions/v1/ink-mcp \
  -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tools

**Read**

| Tool | Purpose |
|---|---|
| `search_ink` | Text search across every surface at once. The workhorse. |
| `timeline` | Unified chronological feed, filterable by kind and date range. |
| `get_day` | Everything recorded on one date. |
| `list_mind` | Thoughts / insights / mantras, by status or collection. |
| `list_reflections` | Stoic and reflect entries, filterable by prompt. |
| `list_meals` | Restaurant visits. |
| `list_media` | Film, tv, book, podcast. |
| `list_collections` | Collections with member counts. |

**Write**

| Tool | Purpose |
|---|---|
| `capture` | New thought, insight, or mantra. |
| `log_day` | Day log entry. |
| `log_meal` | Restaurant visit. |
| `log_media` | Something watched, read, heard. |
| `log_reflection` | Reflection, optionally with the prompt it answered. |
| `update_mind` | Status, collection, text, or promote between kinds. |
| `create_collection` | New named collection. |

Set `INK_MCP_READONLY=1` to drop the write half from `tools/list` entirely —
the tools stop existing rather than erroring.

## What's verified, and what isn't

**Verified:** the file parses clean, all 15 manifest entries have
implementations and vice versa, and every column referenced exists in
`supabase/schema.sql` plus Still's original definitions for `reflections`,
`insights` and `mantras`.

**Not verified:** nothing has run against Supabase. The OAuth handshake, the
session refresh path, and the PostgREST filters are all untested. Expect to
find something on first connect.

Three bugs were found and fixed after the first draft, listed here because two
of them are worth your attention beyond this file:

1. `mantras` never got a `source_entry_id` column — Ink's 2026-05-18 migration
   added it to `insights` only. Every `capture(kind:'mantra')` would have
   failed. Fixed by adding the column, which is inert to Break.
2. The `.or()` filter in `search_ink` interpolated the query string raw. A
   comma or period in a search term would have split the filter and returned
   silent nonsense rather than an error. Now double-quoted.
3. **This one is about Course+, not Ink.** I lifted the batch-handling loop
   verbatim from `Course-plus-app/supabase/functions/mcp/index.ts` line 396,
   and it doesn't parse — `if (x) a() else b()` on one line with no semicolon
   is a syntax error, confirmed against both esbuild and node. A parse error
   takes down the whole module, not just that branch, so if Course+ is working
   today then what's deployed is not what's in the repo. Worth diffing before
   your next `functions deploy`, because redeploying from the repo would break
   the connector.

## Design notes

**Provenance.** The migration adds `'mcp'` to the `source_surface` check on
`entries`, and every write tool creates an `entries` row before the typed row.
So anything Claude wrote is identifiable and, if it ever feels wrong, removable
in one statement:

```sql
delete from entries where source_surface = 'mcp';
```

That's the answer to the obvious objection about letting an AI write into a
journal. The record stays honest about what came from where.

The migration also widens `primary_type` to accept `insight` and `mantra`,
which previously had no `entries` representation at all. Harmless for the app,
but it means `timeline` sees everything.

**Separate auth tables.** `ink_mcp_*` rather than reusing `cp_mcp_*`.
Connecting Course+ shouldn't hand out Ink, and revoking one shouldn't take
down the other.

**Search is `ilike`, not semantic.** Fine at your volume, and it fails
predictably. If Ink grows past a few thousand entries, or you start asking
"what have I been circling on" rather than "find where I wrote X", that's the
point to add pgvector and an embed-on-write path — the same design you already
specced for Scribe.

## One thing to fix while you're in here

Ink's `entries`, `thoughts`, `day_logs`, `restaurant_visits` and
`media_entries` tables all carry `create policy "anon all" ... using (true)`
and no `user_id` column. Only `collections` has real per-user RLS.

That was fine when Ink was a single-user PWA holding its own anon key. It's
worth revisiting now for two reasons: those tables live in the shared suite
project alongside anything you might eventually distribute, and the MCP makes
the journal reachable from outside the app for the first time. The connector
itself is fine — OAuth, PKCE, single-email allowlist, tokens in a
service-role-only table — but the tables underneath it would hand a full read
to anyone holding the project's anon key.

The fix is the migration you've already written once for `collections`: add
`user_id uuid default auth.uid()`, backfill, swap the `anon all` policy for
`auth.uid() = user_id`. Not urgent, and separate from getting the connector
live. But do it before the personal apps share a project with anything public.
