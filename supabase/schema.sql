-- Ink — additive schema on the SHARED Supabase project (xsmnfcmtbpeaccnyinkr).
-- Also hosts Still / Break / Tide tables. This script is ADDITIVE ONLY:
-- no DROP, no data mutation. Safe to run more than once (IF NOT EXISTS guards).
-- Source of truth: ink-spec.md § "Supabase schema".

-- Source-of-truth for every write action.
create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  raw_text text not null,
  composed_at timestamptz not null default now(),
  primary_type text not null check (primary_type in ('day','restaurant','media','thought','reflection')),
  source_surface text not null check (source_surface in ('today_screen','unified_plus','stoic_screen','reflect_screen','thoughts_screen')),
  created_at timestamptz not null default now()
);

-- Day log — one row per (date); multiple only if the user opted out of append.
create table if not exists day_logs (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  text text not null,
  date date not null default current_date,
  extracted_entities jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Restaurant visits — one row per visit.
create table if not exists restaurant_visits (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  place_name text not null,
  visit_date date not null default current_date,
  with_people text[],
  dishes text[],
  note text,
  would_return boolean,
  created_at timestamptz not null default now()
);

-- Media entries — one row per consumption event.
create table if not exists media_entries (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  title text not null,
  format text not null check (format in ('film','tv','book','podcast','other')),
  consumed_date date not null default current_date,
  rating int check (rating >= 1 and rating <= 5),
  note text,
  created_at timestamptz not null default now()
);

-- Free-form thoughts.
create table if not exists thoughts (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  text text not null,
  thought_date date not null default current_date,
  created_at timestamptz not null default now()
);

-- Existing Still 'reflections' table stays as-is; just link it to entries.
alter table reflections add column if not exists source_entry_id uuid references entries(id) on delete set null;

-- RLS — match Still's existing permissive anon model on this project.
alter table entries enable row level security;
alter table day_logs enable row level security;
alter table restaurant_visits enable row level security;
alter table media_entries enable row level security;
alter table thoughts enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='entries' and policyname='anon all')
    then create policy "anon all" on entries for all using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='day_logs' and policyname='anon all')
    then create policy "anon all" on day_logs for all using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='restaurant_visits' and policyname='anon all')
    then create policy "anon all" on restaurant_visits for all using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='media_entries' and policyname='anon all')
    then create policy "anon all" on media_entries for all using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='thoughts' and policyname='anon all')
    then create policy "anon all" on thoughts for all using (true) with check (true); end if;
end $$;

-- Ensure the Data API roles can reach the new tables (Still's tables already are;
-- this makes the new ones explicit and is idempotent).
grant usage on schema public to anon, authenticated;
grant all on entries, day_logs, restaurant_visits, media_entries, thoughts to anon, authenticated;

-- Indexes for common queries.
create index if not exists idx_day_logs_date         on day_logs(date desc);
create index if not exists idx_restaurant_visits_date on restaurant_visits(visit_date desc);
create index if not exists idx_restaurant_visits_place on restaurant_visits(place_name);
create index if not exists idx_media_entries_date     on media_entries(consumed_date desc);
create index if not exists idx_media_entries_title    on media_entries(title);
create index if not exists idx_thoughts_date          on thoughts(thought_date desc);
create index if not exists idx_entries_composed       on entries(composed_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Navigation & Mind redesign — LOCKED 2026-05-18.
-- Additive/idempotent; no DROP, no data mutation. `mantras` is shared with Break
-- (Break selects only `text`) — the new nullable columns are inert to it.
-- ─────────────────────────────────────────────────────────────────────────────
alter table thoughts add column if not exists status text not null default 'active'
  check (status in ('active','dismissed'));
alter table thoughts add column if not exists pushed_to_course boolean not null default false;

alter table insights add column if not exists source_entry_id uuid references entries(id) on delete set null;
alter table insights add column if not exists status text not null default 'active'
  check (status in ('active','dismissed'));
alter table insights add column if not exists pushed_to_course boolean not null default false;

alter table mantras  add column if not exists status text not null default 'active'
  check (status in ('active','dismissed'));
alter table mantras  add column if not exists pushed_to_course boolean not null default false;

create index if not exists idx_thoughts_status on thoughts(status, created_at desc);
create index if not exists idx_insights_status on insights(status, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Collections — auto-named thematic groupings of Mind entries. LOCKED 2026-06-16.
-- Additive/idempotent. Per-user RLS mirrors thoughts/insights/mantras
-- (user_id default auth.uid(), auth.uid() = user_id). One collection per entry
-- (nullable FK, on delete set null). Spec: /ink Collections feature.
-- ─────────────────────────────────────────────────────────────────────────────
-- FLATTENED 2026-07-31: entry_type is no longer a scope, just a legacy label.
-- New rows are 'any' and one collection is shared by thoughts/insights/mantras.
-- See supabase/migrations/mind_flat_collections.sql for the merge of old rows.
create table if not exists collections (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  entry_type  text        default 'any',
  user_id     uuid        default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table collections enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='collections' and policyname='collections_sel')
    then create policy "collections_sel" on collections for select using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where tablename='collections' and policyname='collections_ins')
    then create policy "collections_ins" on collections for insert with check (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where tablename='collections' and policyname='collections_upd')
    then create policy "collections_upd" on collections for update using (auth.uid() = user_id) with check (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where tablename='collections' and policyname='collections_del')
    then create policy "collections_del" on collections for delete using (auth.uid() = user_id); end if;
end $$;
grant all on collections to anon, authenticated;

alter table thoughts add column if not exists collection_id uuid references collections(id) on delete set null;
alter table insights add column if not exists collection_id uuid references collections(id) on delete set null;
alter table mantras  add column if not exists collection_id uuid references collections(id) on delete set null;

create index if not exists idx_collections_type    on collections(entry_type, created_at desc);
create index if not exists idx_thoughts_collection  on thoughts(collection_id);
create index if not exists idx_insights_collection  on insights(collection_id);
create index if not exists idx_mantras_collection   on mantras(collection_id);
