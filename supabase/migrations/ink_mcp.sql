-- ============================================================
-- Ink MCP — migration
-- Run once in the Supabase SQL editor (project xsmnfcmtbpeaccnyinkr).
-- ============================================================

-- 1. Provenance ------------------------------------------------
-- Let entries record that they came from Claude rather than a screen
-- in the app. This is what makes MCP writes distinguishable and, if
-- you ever want, reversible:
--   delete from entries where source_surface = 'mcp';
alter table entries drop constraint if exists entries_source_surface_check;
alter table entries add constraint entries_source_surface_check
  check (source_surface in (
    'today_screen','unified_plus','stoic_screen','reflect_screen','thoughts_screen','mcp'
  ));

-- Insights and mantras never had entries rows. Allow them, so every
-- Ink write has one canonical row in the timeline.
alter table entries drop constraint if exists entries_primary_type_check;
alter table entries add constraint entries_primary_type_check
  check (primary_type in ('day','restaurant','media','thought','reflection','insight','mantra'));


-- `insights` got source_entry_id in the 2026-05-18 migration; `mantras` never
-- did, so it was the one Mind table with no link back to entries. Additive and
-- nullable, so it stays inert to Break, which shares this table and selects
-- only `text`.
alter table mantras add column if not exists source_entry_id uuid
  references entries(id) on delete set null;


-- 2. OAuth storage ---------------------------------------------
-- Separate from cp_mcp_* on purpose: connecting Course+ should not
-- grant Ink, and revoking one should not revoke the other.

create table if not exists ink_mcp_session (
  email        text primary key,
  supa_refresh text not null,
  updated_at   timestamptz not null default now()
);

create table if not exists ink_mcp_codes (
  code           text primary key,
  code_challenge text not null,
  redirect_uri   text not null,
  email          text not null,
  supa_refresh   text not null,
  expires_at     timestamptz not null
);

create table if not exists ink_mcp_tokens (
  token      text primary key,
  kind       text not null check (kind in ('access','refresh')),
  email      text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ink_mcp_tokens_kind_idx on ink_mcp_tokens (kind, token);

-- RLS on, no policies: service role only. Nothing holding a token
-- can read the token table.
alter table ink_mcp_session enable row level security;
alter table ink_mcp_codes   enable row level security;
alter table ink_mcp_tokens  enable row level security;


-- 3. Housekeeping ----------------------------------------------
-- Optional. Expired auth codes are single-use and short-lived, but
-- they accumulate if a flow is abandoned mid-way.
-- delete from ink_mcp_codes where expires_at < now();
