// Ink remote MCP server — one Supabase Edge Function that is BOTH:
//   1. an MCP server over Streamable HTTP (JSON-RPC) — read + write Ink data
//   2. a minimal OAuth 2.1 authorization server (discovery + DCR + authorize +
//      token, PKCE-enforced) so claude.ai / Claude Desktop can connect.
//
// Same shape as the Course+ server, different data layer and its own
// ink_mcp_* auth tables so the two connectors revoke independently.
//
// Deploy with verify_jwt=false — it implements its own auth.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BASE = Deno.env.get('INK_MCP_BASE_URL') || `${SUPABASE_URL}/functions/v1/ink-mcp`
const ALLOWED_EMAIL = (Deno.env.get('INK_MCP_ALLOWED_EMAIL') || 'nates123@gmail.com').toLowerCase()
// Set INK_MCP_READONLY=1 to expose retrieval only. See the note in the README.
const READONLY = Deno.env.get('INK_MCP_READONLY') === '1'

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ── small utils ──
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))
async function sha256b64url(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return b64url(new Uint8Array(buf))
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'Access-Control-Expose-Headers': 'mcp-session-id, www-authenticate',
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } })
const isAllowedRedirect = (u: string) => {
  try {
    const h = new URL(u)
    if (h.protocol !== 'https:' && !(h.hostname === 'localhost' || h.hostname === '127.0.0.1')) return false
    return ['claude.ai', 'claude.com'].includes(h.hostname) ||
      h.hostname.endsWith('.claude.ai') || h.hostname.endsWith('.claude.com') ||
      h.hostname === 'localhost' || h.hostname === '127.0.0.1'
  } catch { return false }
}

const uuid = () => crypto.randomUUID()
const today = () => new Date().toISOString().slice(0, 10)
const ymd = (s?: string | null) => { if (!s) return null; const d = new Date(s); return isNaN(+d) ? null : d.toISOString().slice(0, 10) }
const must = (e: any) => { if (e) throw new Error(e.message || String(e)) }
// PostgREST translates `*` to `%` in like/ilike, so escape it alongside the
// SQL wildcards to keep the search literal.
const like = (s: string) => `%${String(s).replace(/[%_*]/g, (c) => '\\' + c)}%`
// Inside an .or() the value sits in a comma-separated list, so a comma,
// paren or period in the query would split the filter. Double-quoting is
// PostgREST's escape hatch for that.
const orVal = (s: string) => `"${like(s).replace(/"/g, '\\"')}"`

// ── kind registry ─────────────────────────────────────────────
// One place that knows how each Ink surface maps onto a table.
const MIND = {
  thought: { table: 'thoughts', dateCol: 'thought_date' },
  insight: { table: 'insights', dateCol: 'created_at' },
  mantra:  { table: 'mantras',  dateCol: 'created_at' },
} as const
type MindKind = keyof typeof MIND
const MIND_TABLES = Object.values(MIND).map((m) => m.table)

const ALL_KINDS = ['thought', 'insight', 'mantra', 'reflection', 'day', 'restaurant', 'media']

// row → uniform shape for search + timeline
const shape = {
  thought:    (r: any) => ({ kind: 'thought', id: r.id, text: r.text, date: ymd(r.thought_date), status: r.status, collection: r.collection_id || null }),
  insight:    (r: any) => ({ kind: 'insight', id: r.id, text: r.text, date: ymd(r.created_at), status: r.status, collection: r.collection_id || null }),
  mantra:     (r: any) => ({ kind: 'mantra', id: r.id, text: r.text, date: ymd(r.created_at), status: r.status, collection: r.collection_id || null }),
  reflection: (r: any) => ({ kind: 'reflection', id: r.id, text: r.text, date: ymd(r.date), prompt: r.prompt_used || null, tags: r.tags || [] }),
  day:        (r: any) => ({ kind: 'day', id: r.id, text: r.text, date: ymd(r.date), entities: r.extracted_entities || {} }),
  restaurant: (r: any) => ({ kind: 'restaurant', id: r.id, place: r.place_name, date: ymd(r.visit_date), with: r.with_people || [], dishes: r.dishes || [], note: r.note || null, wouldReturn: r.would_return }),
  media:      (r: any) => ({ kind: 'media', id: r.id, title: r.title, format: r.format, date: ymd(r.consumed_date), rating: r.rating ?? null, note: r.note || null }),
} as const

// (table, dateColumn, textColumns, shaper) per kind — drives generic queries
const SRC: Record<string, { table: string; date: string; text: string[]; map: (r: any) => any }> = {
  thought:    { table: 'thoughts',          date: 'thought_date',  text: ['text'],             map: shape.thought },
  insight:    { table: 'insights',          date: 'created_at',    text: ['text'],             map: shape.insight },
  mantra:     { table: 'mantras',           date: 'created_at',    text: ['text'],             map: shape.mantra },
  reflection: { table: 'reflections',       date: 'date',          text: ['text'],             map: shape.reflection },
  day:        { table: 'day_logs',          date: 'date',          text: ['text'],             map: shape.day },
  restaurant: { table: 'restaurant_visits', date: 'visit_date',    text: ['place_name', 'note'], map: shape.restaurant },
  media:      { table: 'media_entries',     date: 'consumed_date', text: ['title', 'note'],    map: shape.media },
}

function ranged(q: any, col: string, from?: string, to?: string) {
  if (from) q = q.gte(col, from)
  if (to) q = q.lte(col, to)
  return q
}

// Write an `entries` row so MCP-authored content sits in the same
// canonical timeline as everything else, tagged source_surface='mcp'.
async function entryRow(sb: any, primary_type: string, raw_text: string, at?: string) {
  const id = uuid()
  const { error } = await sb.from('entries').insert({
    id, raw_text, primary_type, source_surface: 'mcp',
    composed_at: at ? new Date(at).toISOString() : new Date().toISOString(),
  })
  must(error)
  return id
}

// ── data ops (take a user-scoped supabase client) ──
const ops: Record<string, (sb: any, a: any) => Promise<any>> = {

  // ---------- read ----------

  async search_ink(sb, { q, kinds, from, to, limit = 40 }) {
    if (!q) throw new Error('q is required')
    const use = (kinds?.length ? kinds : ALL_KINDS).filter((k: string) => SRC[k])
    const per = Math.max(5, Math.ceil(limit / use.length))
    const results = await Promise.all(use.map(async (k: string) => {
      const s = SRC[k]
      let query = sb.from(s.table).select('*').order(s.date, { ascending: false }).limit(per)
      query = s.text.length === 1
        ? query.ilike(s.text[0], like(q))
        : query.or(s.text.map((c) => `${c}.ilike.${orVal(q)}`).join(','))
      query = ranged(query, s.date, from, to)
      const { data, error } = await query
      if (error) return []
      return (data || []).map(s.map)
    }))
    return results.flat()
      .sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, limit)
  },

  async timeline(sb, { kinds, from, to, limit = 60 }) {
    const use = (kinds?.length ? kinds : ALL_KINDS).filter((k: string) => SRC[k])
    const per = Math.max(5, Math.ceil(limit / use.length))
    const results = await Promise.all(use.map(async (k: string) => {
      const s = SRC[k]
      let query = sb.from(s.table).select('*').order(s.date, { ascending: false }).limit(per)
      query = ranged(query, s.date, from, to)
      const { data, error } = await query
      if (error) return []
      return (data || []).map(s.map)
    }))
    return results.flat()
      .sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, limit)
  },

  async get_day(sb, { date }) {
    const d = date || today()
    const out = await ops.timeline(sb, { from: d, to: d, limit: 200 })
    return { date: d, count: out.length, entries: out }
  },

  async list_mind(sb, { kind, status = 'active', collection, limit = 50 }) {
    if (!MIND[kind as MindKind]) throw new Error("kind must be one of: thought, insight, mantra")
    const s = SRC[kind]
    let q = sb.from(s.table).select('*').order(s.date, { ascending: false }).limit(limit)
    if (status && status !== 'all') q = q.eq('status', status)
    if (collection) q = q.eq('collection_id', collection)
    const { data, error } = await q; must(error)
    return (data || []).map(s.map)
  },

  async list_reflections(sb, { from, to, prompt, limit = 30 }) {
    let q = sb.from('reflections').select('*').order('date', { ascending: false }).limit(limit)
    q = ranged(q, 'date', from, to)
    if (prompt) q = q.ilike('prompt_used', like(prompt))
    const { data, error } = await q; must(error)
    return (data || []).map(shape.reflection)
  },

  async list_meals(sb, { from, to, place, limit = 40 }) {
    let q = sb.from('restaurant_visits').select('*').order('visit_date', { ascending: false }).limit(limit)
    q = ranged(q, 'visit_date', from, to)
    if (place) q = q.ilike('place_name', like(place))
    const { data, error } = await q; must(error)
    return (data || []).map(shape.restaurant)
  },

  async list_media(sb, { format, minRating, from, to, limit = 40 }) {
    let q = sb.from('media_entries').select('*').order('consumed_date', { ascending: false }).limit(limit)
    q = ranged(q, 'consumed_date', from, to)
    if (format) q = q.eq('format', format)
    if (minRating != null) q = q.gte('rating', minRating)
    const { data, error } = await q; must(error)
    return (data || []).map(shape.media)
  },

  // Collections are FLAT since 2026-07-31 — one collection spans all three Mind
  // kinds, so counts sum across the three tables. `kind` now filters the COUNT
  // (how much of that kind is in each collection), not which collections exist.
  async list_collections(sb, { kind }) {
    const { data, error } = await sb.from('collections').select('*').order('updated_at', { ascending: false })
    must(error)
    const cols = data || []
    const tables = (kind ? [MIND[kind as MindKind]?.table] : MIND_TABLES).filter(Boolean) as string[]
    const counts = await Promise.all(cols.map(async (c: any) => {
      const per = await Promise.all(tables.map(async (t) => {
        const { count } = await sb.from(t).select('id', { count: 'exact', head: true }).eq('collection_id', c.id)
        return count || 0
      }))
      return per.reduce((a, b) => a + b, 0)
    }))
    return cols.map((c: any, i: number) => ({ id: c.id, name: c.name, count: counts[i] }))
  },

  // ---------- write ----------

  async capture(sb, { kind, text, date }) {
    if (!MIND[kind as MindKind]) throw new Error("kind must be one of: thought, insight, mantra")
    if (!text?.trim()) throw new Error('text is required')
    const eid = await entryRow(sb, kind, text, date)
    const id = uuid()
    const row: any = { id, source_entry_id: eid, text, status: 'active' }
    // thoughts carry an explicit date column; insights and mantras are ordered
    // by created_at, so backdating means writing that instead.
    if (kind === 'thought') row.thought_date = date || today()
    else if (date) row.created_at = new Date(date).toISOString()
    const { error } = await sb.from(MIND[kind as MindKind].table).insert(row); must(error)
    return { id, kind, text, entryId: eid }
  },

  async log_day(sb, { text, date }) {
    if (!text?.trim()) throw new Error('text is required')
    const eid = await entryRow(sb, 'day', text, date)
    const id = uuid()
    const { error } = await sb.from('day_logs').insert({ id, source_entry_id: eid, text, date: date || today() })
    must(error)
    return { id, kind: 'day', date: date || today(), text }
  },

  async log_meal(sb, { place, date, people, dishes, note, wouldReturn }) {
    if (!place?.trim()) throw new Error('place is required')
    const eid = await entryRow(sb, 'restaurant', [place, note].filter(Boolean).join(' — '), date)
    const id = uuid()
    const { error } = await sb.from('restaurant_visits').insert({
      id, source_entry_id: eid, place_name: place, visit_date: date || today(),
      with_people: people || null, dishes: dishes || null, note: note || null,
      would_return: wouldReturn ?? null,
    })
    must(error)
    return { id, kind: 'restaurant', place, date: date || today() }
  },

  async log_media(sb, { title, format, date, rating, note }) {
    if (!title?.trim()) throw new Error('title is required')
    if (!['film', 'tv', 'book', 'podcast', 'other'].includes(format)) {
      throw new Error('format must be one of: film, tv, book, podcast, other')
    }
    const eid = await entryRow(sb, 'media', [title, note].filter(Boolean).join(' — '), date)
    const id = uuid()
    const { error } = await sb.from('media_entries').insert({
      id, source_entry_id: eid, title, format, consumed_date: date || today(),
      rating: rating ?? null, note: note || null,
    })
    must(error)
    return { id, kind: 'media', title, format, date: date || today() }
  },

  async log_reflection(sb, { text, prompt, tags, date }) {
    if (!text?.trim()) throw new Error('text is required')
    const eid = await entryRow(sb, 'reflection', text, date)
    const id = uuid()
    const { error } = await sb.from('reflections').insert({
      id, source_entry_id: eid, text, prompt_used: prompt || null,
      tags: tags || [], date: date || today(),
    })
    must(error)
    return { id, kind: 'reflection', date: date || today() }
  },

  // Status change, promotion between tabs, collection assignment, and text
  // correction in one tool — they're all "adjust an existing mind item".
  async update_mind(sb, { kind, id, status, collection, text, promoteTo }) {
    const src = MIND[kind as MindKind]
    if (!src) throw new Error("kind must be one of: thought, insight, mantra")
    if (!id) throw new Error('id is required')

    if (promoteTo) {
      const dest = MIND[promoteTo as MindKind]
      if (!dest) throw new Error("promoteTo must be one of: thought, insight, mantra")
      const { data: row, error: e1 } = await sb.from(src.table).select('*').eq('id', id).single(); must(e1)
      const nid = uuid()
      const ins: any = { id: nid, source_entry_id: row.source_entry_id || null, text: text || row.text, status: 'active' }
      if (promoteTo === 'thought') ins.thought_date = today()
      const { error: e2 } = await sb.from(dest.table).insert(ins); must(e2)
      const { error: e3 } = await sb.from(src.table).update({ status: 'dismissed' }).eq('id', id); must(e3)
      return { promoted: { from: kind, to: promoteTo }, id: nid, text: ins.text }
    }

    const patch: any = {}
    if (status != null) patch.status = status
    if (collection !== undefined) patch.collection_id = collection
    if (text != null) patch.text = text
    if (!Object.keys(patch).length) throw new Error('nothing to update')
    const { error } = await sb.from(src.table).update(patch).eq('id', id); must(error)
    return { id, kind, ...patch }
  },

  // Flat namespace — a collection holds any mix of thoughts, insights and
  // mantras, so no kind is taken. Reuses an existing name instead of splitting it.
  async create_collection(sb, { name }) {
    if (!name?.trim()) throw new Error('name is required')
    const clean = name.trim()
    const { data: hit } = await sb.from('collections').select('id,name').ilike('name', clean).limit(1)
    if (hit && hit[0]) return { id: hit[0].id, name: hit[0].name, existing: true }
    const id = uuid()
    const { error } = await sb.from('collections').insert({ id, name: clean, entry_type: 'any' }); must(error)
    return { id, name: clean }
  },
}

// ── tool manifest ──
const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' }
const arr = { type: 'array', items: { type: 'string' } }
const S = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false })

const DATE = { type: 'string', description: 'YYYY-MM-DD' }
const KIND = { type: 'string', enum: ['thought', 'insight', 'mantra'] }

const TOOLS = [
  { name: 'search_ink', write: false, description: 'Full-text search across the journal. Returns matching thoughts, insights, mantras, reflections, day logs, meals and media, newest first. Use this first when asked what Nate has written about something.', inputSchema: S({ q: str, kinds: { type: 'array', items: { type: 'string', enum: ALL_KINDS } }, from: DATE, to: DATE, limit: num }, ['q']) },
  { name: 'timeline', write: false, description: 'Unified chronological feed across all Ink surfaces, newest first. Filter by kind and date range.', inputSchema: S({ kinds: { type: 'array', items: { type: 'string', enum: ALL_KINDS } }, from: DATE, to: DATE, limit: num }) },
  { name: 'get_day', write: false, description: 'Everything recorded on one date: day log, thoughts, reflections, meals, media. Defaults to today.', inputSchema: S({ date: DATE }) },
  { name: 'list_mind', write: false, description: 'List Mind-screen items of one kind (thought, insight, mantra). status defaults to active; pass "all" for everything.', inputSchema: S({ kind: KIND, status: str, collection: str, limit: num }, ['kind']) },
  { name: 'list_reflections', write: false, description: 'List Stoic/reflect entries, optionally filtered by date range or the prompt used.', inputSchema: S({ from: DATE, to: DATE, prompt: str, limit: num }) },
  { name: 'list_meals', write: false, description: 'List restaurant visits, optionally filtered by date range or place name.', inputSchema: S({ from: DATE, to: DATE, place: str, limit: num }) },
  { name: 'list_media', write: false, description: 'List film/tv/book/podcast entries, optionally filtered by format, minimum rating, or date range.', inputSchema: S({ format: { type: 'string', enum: ['film', 'tv', 'book', 'podcast', 'other'] }, minRating: num, from: DATE, to: DATE, limit: num }) },
  { name: 'list_collections', write: false, description: 'List Collections (auto-named thematic groupings) with member counts. Collections are flat — one collection can hold thoughts, insights and mantras together. Pass kind to count only that kind.', inputSchema: S({ kind: KIND }) },

  { name: 'capture', write: true, description: 'Write a new thought, insight, or mantra into Ink. Only use when explicitly asked to save something — this is a personal journal, not a scratchpad.', inputSchema: S({ kind: KIND, text: str, date: DATE }, ['kind', 'text']) },
  { name: 'log_day', write: true, description: "Write a day log entry — the one-line prose record of a day.", inputSchema: S({ text: str, date: DATE }, ['text']) },
  { name: 'log_meal', write: true, description: 'Log a restaurant visit.', inputSchema: S({ place: str, date: DATE, people: arr, dishes: arr, note: str, wouldReturn: bool }, ['place']) },
  { name: 'log_media', write: true, description: 'Log something watched, read, or listened to. rating is 1-5.', inputSchema: S({ title: str, format: { type: 'string', enum: ['film', 'tv', 'book', 'podcast', 'other'] }, date: DATE, rating: num, note: str }, ['title', 'format']) },
  { name: 'log_reflection', write: true, description: 'Write a reflection entry, optionally recording the prompt it answered.', inputSchema: S({ text: str, prompt: str, tags: arr, date: DATE }, ['text']) },
  { name: 'update_mind', write: true, description: 'Adjust an existing thought/insight/mantra: change status (active|dismissed), assign a collection, correct the text, or promote it to another kind via promoteTo (dismisses the original).', inputSchema: S({ kind: KIND, id: str, status: str, collection: str, text: str, promoteTo: KIND }, ['kind', 'id']) },
  { name: 'create_collection', write: true, description: 'Create a named Collection. Collections are flat — they hold any mix of thoughts, insights and mantras. Returns the existing one if the name is already taken.', inputSchema: S({ name: str }, ['name']) },
].filter((t) => !(READONLY && t.write))

// ── build a user-scoped supabase client from the stored session ──
async function userClient(email: string) {
  const { data: row, error } = await admin.from('ink_mcp_session').select('supa_refresh').eq('email', email).single()
  if (error || !row) throw new Error('No session for ' + email)
  const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const { data, error: e2 } = await sb.auth.refreshSession({ refresh_token: row.supa_refresh })
  if (e2 || !data?.session) throw new Error('Session expired — reconnect the Ink connector.')
  await admin.from('ink_mcp_session').update({ supa_refresh: data.session.refresh_token, updated_at: new Date().toISOString() }).eq('email', email)
  await sb.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token })
  return sb
}

async function emailForToken(token: string | null): Promise<string | null> {
  if (!token) return null
  const { data } = await admin.from('ink_mcp_tokens').select('email,expires_at,kind').eq('token', token).eq('kind', 'access').maybeSingle()
  if (!data) return null
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null
  return data.email
}

// ── MCP JSON-RPC handler ──
async function handleRpc(msg: any, email: string) {
  const { id, method, params } = msg
  const reply = (result: any) => ({ jsonrpc: '2.0', id, result })
  if (method === 'initialize') {
    return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ink', version: '0.1.0' } })
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  if (method === 'tools/call') {
    const name = params?.name, args = params?.arguments || {}
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } }
    if (READONLY && tool.write) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Ink MCP is read-only' } }
    try {
      const sb = await userClient(email)
      const out = await ops[name](sb, args)
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
    } catch (e) {
      return reply({ content: [{ type: 'text', text: 'Error: ' + ((e as Error)?.message || String(e)) }], isError: true })
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } }
}

// Supabase's functions domain downgrades text/html → text/plain, so the login
// page is hosted on GitHub Pages and /authorize redirects to it.
const LOGIN_UI = Deno.env.get('INK_MCP_LOGIN_URL') || 'https://nates123-cmd.github.io/Ink/mcp-login.html'

function loginPage(q: URLSearchParams) {
  const redirect_uri = q.get('redirect_uri') || ''
  const state = q.get('state') || ''
  const code_challenge = q.get('code_challenge') || ''
  const ok = isAllowedRedirect(redirect_uri) && q.get('code_challenge_method') === 'S256'
  if (!ok) return new Response('Invalid authorization request (need https claude.ai redirect + PKCE S256).', { status: 400 })
  const u = new URL(LOGIN_UI)
  u.searchParams.set('redirect_uri', redirect_uri)
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', code_challenge)
  return new Response(null, { status: 302, headers: { ...CORS, Location: u.toString() } })
}

// ── main router ──
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const url = new URL(req.url)
  const m = url.pathname.match(/\/ink-mcp(\/.*)?$/)
  const sub = (m?.[1] || '/').replace(/\/+$/, '') || '/'

  if (sub === '/.well-known/oauth-protected-resource') {
    return json({ resource: BASE, authorization_servers: [BASE] })
  }
  if (sub === '/.well-known/oauth-authorization-server' || sub === '/.well-known/openid-configuration') {
    return json({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['ink'],
    })
  }

  if (sub === '/register' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    return json({
      client_id: 'ink-' + randToken(8),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris || [],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, 201)
  }

  if (sub === '/authorize' && req.method === 'GET') return loginPage(url.searchParams)

  if (sub === '/authorize/send' && req.method === 'POST') {
    const { email } = await req.json().catch(() => ({}))
    if (!email || email.toLowerCase() !== ALLOWED_EMAIL) return json({ error: 'This email is not authorized for Ink.' }, 403)
    const authc = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    const { error } = await authc.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
    if (error) return json({ error: error.message }, 400)
    return json({ ok: true })
  }

  if (sub === '/authorize/verify' && req.method === 'POST') {
    const { email, token, redirect_uri, state, code_challenge } = await req.json().catch(() => ({}))
    if (!email || email.toLowerCase() !== ALLOWED_EMAIL) return json({ error: 'Email not authorized.' }, 403)
    if (!isAllowedRedirect(redirect_uri) || !code_challenge) return json({ error: 'Invalid request.' }, 400)
    const authc = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    const { data, error } = await authc.auth.verifyOtp({ email, token: String(token).replace(/\D/g, ''), type: 'email' })
    if (error || !data?.session) return json({ error: error?.message || 'Invalid code.' }, 400)
    const lc = email.toLowerCase()
    await admin.from('ink_mcp_session').upsert({ email: lc, supa_refresh: data.session.refresh_token, updated_at: new Date().toISOString() })
    const code = randToken(24)
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    await admin.from('ink_mcp_codes').insert({ code, code_challenge, redirect_uri, email: lc, supa_refresh: data.session.refresh_token, expires_at: expires })
    const sep = redirect_uri.includes('?') ? '&' : '?'
    const redirect = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`
    return json({ redirect })
  }

  if (sub === '/token' && req.method === 'POST') {
    const ct = req.headers.get('content-type') || ''
    let p: Record<string, string> = {}
    if (ct.includes('application/json')) p = await req.json().catch(() => ({}))
    else { const f = new URLSearchParams(await req.text()); f.forEach((v, k) => (p[k] = v)) }

    if (p.grant_type === 'authorization_code') {
      const { data: row } = await admin.from('ink_mcp_codes').select('*').eq('code', p.code || '').maybeSingle()
      if (!row) return json({ error: 'invalid_grant' }, 400)
      await admin.from('ink_mcp_codes').delete().eq('code', p.code)
      if (new Date(row.expires_at) < new Date()) return json({ error: 'invalid_grant', error_description: 'code expired' }, 400)
      if (row.redirect_uri !== p.redirect_uri) return json({ error: 'invalid_grant', error_description: 'redirect mismatch' }, 400)
      const challenge = await sha256b64url(p.code_verifier || '')
      if (challenge !== row.code_challenge) return json({ error: 'invalid_grant', error_description: 'PKCE failed' }, 400)
      const access = randToken(), refresh = randToken()
      const accessExp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
      await admin.from('ink_mcp_tokens').insert([
        { token: access, kind: 'access', email: row.email, expires_at: accessExp },
        { token: refresh, kind: 'refresh', email: row.email, expires_at: null },
      ])
      return json({ access_token: access, token_type: 'Bearer', expires_in: 30 * 24 * 3600, refresh_token: refresh, scope: 'ink' }, 200, { 'Cache-Control': 'no-store' })
    }

    if (p.grant_type === 'refresh_token') {
      const { data: row } = await admin.from('ink_mcp_tokens').select('*').eq('token', p.refresh_token || '').eq('kind', 'refresh').maybeSingle()
      if (!row) return json({ error: 'invalid_grant' }, 400)
      const access = randToken()
      const accessExp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
      await admin.from('ink_mcp_tokens').insert({ token: access, kind: 'access', email: row.email, expires_at: accessExp })
      return json({ access_token: access, token_type: 'Bearer', expires_in: 30 * 24 * 3600, scope: 'ink' }, 200, { 'Cache-Control': 'no-store' })
    }
    return json({ error: 'unsupported_grant_type' }, 400)
  }

  if (sub === '/') {
    const auth = req.headers.get('authorization') || ''
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
    const email = await emailForToken(bearer)
    if (!email) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...CORS, 'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"` },
      })
    }
    if (req.method === 'GET') return new Response(null, { status: 405, headers: CORS })
    const payload = await req.json().catch(() => null)
    if (!payload) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    if (Array.isArray(payload)) {
      const out = []
      for (const msg of payload) {
        if (msg?.id !== undefined && msg?.id !== null) out.push(await handleRpc(msg, email))
        else await handleRpc(msg, email)
      }
      return json(out)
    }
    if (payload.id === undefined || payload.id === null) { await handleRpc(payload, email).catch(() => {}); return new Response(null, { status: 202, headers: CORS }) }
    return json(await handleRpc(payload, email))
  }

  return new Response('Not found', { status: 404, headers: CORS })
})
