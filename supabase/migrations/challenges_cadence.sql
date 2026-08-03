-- ─────────────────────────────────────────────────────────────────────────────
-- Challenge cadence — 2026-08-03
--
-- challenges_engine.sql assumed every challenge is every day. That holds for
-- "walk every day this week" and breaks for everything else: a Mon/Wed/Fri gym
-- push shows a snapped streak on every rest day, and "walk 4x this week" has
-- nowhere to put the 4.
--
-- This adds one cadence model covering all three shapes:
--   daily         — every day counts (the existing behaviour, still the default)
--   weekdays      — only the ISO weekdays in `weekdays` count (1=Mon … 7=Sun)
--   weekly_count  — hit `per_week` check-ins inside the week, any days you like
--
-- It also fixes a real bug. The old view resolved `current_date`, which on
-- Supabase is UTC, while every app writes `challenge_logs.date` from the
-- client's local calendar. Between 8pm ET and midnight the two disagreed, so a
-- walk logged at 9pm read back as "not done today". Everything now goes through
-- ink_today(), pinned to America/New_York — one place to change it.
--
-- Additive and idempotent. New view columns are APPENDED: create or replace
-- view cannot rename, retype or drop an existing column, and Ink, Today, Break
-- and the reMarkable brief all select from the first thirteen.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The suite's idea of "today". Local calendar, not UTC.
create or replace function ink_today() returns date
  language sql stable
  as $$ select (now() at time zone 'America/New_York')::date $$;
grant execute on function ink_today() to anon, authenticated;

-- 2. Cadence columns. Default 'daily' means every existing row keeps its exact
--    current behaviour without a backfill.
alter table active_challenges add column if not exists cadence  text not null default 'daily';
alter table active_challenges add column if not exists weekdays smallint[];
alter table active_challenges add column if not exists per_week smallint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'active_challenges_cadence_chk') then
    alter table active_challenges add constraint active_challenges_cadence_chk
      check (cadence in ('daily','weekdays','weekly_count'));
  end if;
end $$;

-- 3. THE SUITE CONTRACT, widened. Columns 1-13 are byte-for-byte what the four
--    readers already select; everything after `streak` is new.
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
  (d.td - c.start_date) + 1 as day_number,
  d.done_today,
  d.days_done,
  st.streak,
  -- ── appended 2026-08-03 ──────────────────────────────────────────────────
  c.cadence,
  coalesce(c.weekdays, array[1,2,3,4,5,6,7]::smallint[]) as weekdays,
  c.per_week      as week_target,
  -- Is a check-in owed today? Readers nudge on this, never on cadence itself.
  -- weekly_count stops asking once the week's target is met.
  case c.cadence
    when 'weekdays'     then extract(isodow from d.td)::smallint
                             = any(coalesce(c.weekdays, array[1,2,3,4,5,6,7]::smallint[]))
    when 'weekly_count' then d.week_done < coalesce(c.per_week, 1)
    else true
  end             as due_today,
  d.week_start,
  d.week_done,
  d.td            as today_local
from active_challenges c
cross join lateral (
  select
    z.td,
    date_trunc('week', z.td)::date as week_start,
    exists (select 1 from challenge_logs l
             where l.active_challenge_id = c.id and l.date = z.td)          as done_today,
    (select count(*) from challenge_logs l
      where l.active_challenge_id = c.id)                                   as days_done,
    (select count(*) from challenge_logs l
      where l.active_challenge_id = c.id
        and l.date >= date_trunc('week', z.td)::date
        and l.date <= z.td)                                                 as week_done
  from (select ink_today() as td) z
) d
cross join lateral (
  select case c.cadence

    -- Consecutive WEEKS that met the target. The current week only counts once
    -- it is already met — an unfinished week is still open, not a miss.
    when 'weekly_count' then (
      with wks as (
        select w.wk,
               row_number() over (order by w.wk desc) as rn,
               (select count(*) from challenge_logs l
                 where l.active_challenge_id = c.id
                   and l.date >= w.wk and l.date < w.wk + 7
                   and l.date <= d.td) >= coalesce(c.per_week, 1) as hit
        from generate_series(
               greatest(date_trunc('week', c.start_date)::date, d.week_start - 371),
               case when d.week_done >= coalesce(c.per_week, 1)
                    then d.week_start else d.week_start - 7 end,
               interval '7 day') g(wk0)
        cross join lateral (select g.wk0::date as wk) w
      )
      -- Streak ends one row above the most recent miss; no miss = the whole run.
      select coalesce((select min(rn) - 1 from wks where not hit),
                      (select count(*) from wks))
    )

    -- daily and weekdays are the same walk backwards over SCHEDULED days —
    -- daily is just the every-weekday case, so a rest day cannot break a streak.
    else (
      with days as (
        select dd.d,
               row_number() over (order by dd.d desc) as rn,
               exists (select 1 from challenge_logs l
                        where l.active_challenge_id = c.id and l.date = dd.d) as hit
        from generate_series(
               greatest(c.start_date, d.td - 400),
               -- Today is excluded while it is still open, so missing it now
               -- does not snap the streak until midnight.
               case when d.done_today then d.td else d.td - 1 end,
               interval '1 day') g(d0)
        cross join lateral (select g.d0::date as d) dd
        where c.cadence <> 'weekdays'
           or extract(isodow from dd.d)::smallint
              = any(coalesce(c.weekdays, array[1,2,3,4,5,6,7]::smallint[]))
      )
      select coalesce((select min(rn) - 1 from days where not hit),
                      (select count(*) from days))
    )
  end::bigint as streak
) st
where c.completed = false;

alter view challenges_today set (security_invoker = on);
grant select on challenges_today to anon, authenticated;
