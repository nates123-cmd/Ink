-- ─────────────────────────────────────────────────────────────────────────────
-- Mind flat collections — LOCKED 2026-07-31
--
-- Collections were scoped per entry_type ('thought' | 'insight' | 'mantra'), so
-- one theme like "Learning Habits" existed up to three separate times and the
-- only way to see all of it was to flip between the Mind tabs. This flattens the
-- namespace: one collection row per (user, name), shared by all three types.
--
-- Idempotent and non-destructive. Entries are never deleted — duplicate
-- COLLECTION rows are merged into the oldest one and the entries are repointed.
-- Safe to run twice; the second run finds nothing to merge.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Stop enforcing the per-type vocabulary. New rows are written as 'any'.
alter table collections drop constraint if exists collections_entry_type_check;
alter table collections alter column entry_type drop not null;
alter table collections alter column entry_type set default 'any';

-- 2. Repoint every entry at the surviving collection for its name.
--    Winner = oldest row per (user_id, lower(trim(name))).
create or replace view _collection_merge_map as
  select id,
         first_value(id) over (
           partition by user_id, lower(btrim(name))
           order by created_at, id
         ) as keep_id
  from collections;

update thoughts t set collection_id = m.keep_id
  from _collection_merge_map m
 where t.collection_id = m.id and m.keep_id <> m.id;

update insights i set collection_id = m.keep_id
  from _collection_merge_map m
 where i.collection_id = m.id and m.keep_id <> m.id;

update mantras x set collection_id = m.keep_id
  from _collection_merge_map m
 where x.collection_id = m.id and m.keep_id <> m.id;

-- 3. Drop the now-empty duplicates, then normalise the surviving rows.
delete from collections c
 using _collection_merge_map m
 where c.id = m.id and m.keep_id <> m.id;

drop view _collection_merge_map;

update collections set entry_type = 'any' where entry_type is distinct from 'any';

-- 4. One name per user, case-insensitively — stops the split re-forming.
create unique index if not exists idx_collections_user_name
  on collections (user_id, lower(btrim(name)));
