-- ─────────────────────────────────────────────────────────────────────────────
-- Challenge engine — LOCKED 2026-07-31
--
-- `active_challenges` came from Still as an opt-in to one of 15 hardcoded
-- presets: a key, a start date, a done flag. That cannot hold "10 minute brain
-- sesh every day" — there is nowhere to put the title, the reason, or an
-- open-ended run, and nothing but Ink's home chip can read the state.
--
-- This adds the missing columns and, more importantly, ONE read contract the
-- whole suite shares: the `challenges_today` view. Ink, Today, the reMarkable
-- daily page and Break all select from it rather than each re-deriving "is it
-- due, what day are we on, what is the streak".
--
-- Additive and idempotent. No existing row loses anything; preset opt-ins keep
-- working because the view falls back to the challenge_key for a title.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Custom challenges: a title of its own, the reason, and a length that is
--    allowed to be open-ended (days null = runs until you stop it).
alter table active_challenges add column if not exists title       text;
alter table active_challenges add column if not exists description text;
alter table active_challenges add column if not exists why         text;
alter table active_challenges add column if not exists days        integer;
alter table active_challenges add column if not exists user_id     uuid default auth.uid();
alter table active_challenges alter column challenge_key drop not null;

-- A per-day note — "what actually happened on day 6" is the useful part.
alter table challenge_logs add column if not exists note    text;
alter table challenge_logs add column if not exists user_id uuid default auth.uid();

-- 2. Per-user RLS, mirroring the rest of the suite. Idempotent: only creates
--    what is missing, so re-running is safe.
alter table active_challenges enable row level security;
alter table challenge_logs    enable row level security;
do $$
declare t text;
begin
  foreach t in array array['active_challenges','challenge_logs'] loop
    -- Still's original wide-open policy has no place once rows carry a user.
    execute format('drop policy if exists "anon all" on %I', t);
    if not exists (select 1 from pg_policies where tablename=t and policyname=t||'_sel')
      then execute format('create policy %I on %I for select using (auth.uid() = user_id)', t||'_sel', t); end if;
    if not exists (select 1 from pg_policies where tablename=t and policyname=t||'_ins')
      then execute format('create policy %I on %I for insert with check (auth.uid() = user_id)', t||'_ins', t); end if;
    if not exists (select 1 from pg_policies where tablename=t and policyname=t||'_upd')
      then execute format('create policy %I on %I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t||'_upd', t); end if;
    if not exists (select 1 from pg_policies where tablename=t and policyname=t||'_del')
      then execute format('create policy %I on %I for delete using (auth.uid() = user_id)', t||'_del', t); end if;
  end loop;
end $$;
grant all on active_challenges, challenge_logs to anon, authenticated;

-- Backfill: rows that predate user_id belong to the only account that has ever
-- written challenges. Left deliberately narrow — it claims a row only when the
-- table has exactly one candidate owner elsewhere.
update active_challenges c set user_id = (select h.user_id from habits h where h.user_id is not null limit 1)
 where c.user_id is null;
update challenge_logs l set user_id = (select c.user_id from active_challenges c where c.id = l.active_challenge_id)
 where l.user_id is null;

create index if not exists idx_challenge_logs_challenge_date on challenge_logs (active_challenge_id, date desc);

-- 3. THE SUITE CONTRACT. Every app reads this, nobody re-derives it.
--    security_invoker keeps the caller's RLS — without it the view would leak
--    across users, since a view otherwise runs as its owner.
create or replace view challenges_today as
select
  c.id,
  c.user_id,
  coalesce(nullif(btrim(c.title), ''), initcap(replace(coalesce(c.challenge_key,'challenge'), '-', ' '))) as title,
  c.challenge_key,
  c.why,
  c.description,
  c.days,
  c.start_date,
  c.completed,
  (current_date - c.start_date) + 1                                   as day_number,
  exists (select 1 from challenge_logs l
           where l.active_challenge_id = c.id and l.date = current_date) as done_today,
  (select count(*) from challenge_logs l where l.active_challenge_id = c.id) as days_done,
  st.streak
from active_challenges c
cross join lateral (
  -- Streak = consecutive logged days ending today, or ending yesterday when
  -- today is still open. Missing today does not break a streak until midnight.
  select count(*) as streak
  from (
    select l.date,
           row_number() over (order by l.date desc) as rn,
           case when exists (select 1 from challenge_logs x
                              where x.active_challenge_id = c.id and x.date = current_date)
                then current_date else current_date - 1 end as anchor
    from challenge_logs l
    where l.active_challenge_id = c.id and l.date <= current_date
  ) s
  -- rn is bigint and date - bigint has no operator; the cast is load-bearing.
  where s.date = s.anchor - (s.rn - 1)::int
) st
where c.completed = false;

alter view challenges_today set (security_invoker = on);
grant select on challenges_today to anon, authenticated;
