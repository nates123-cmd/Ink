-- ─────────────────────────────────────────────────────────────────────────────
-- Challenge time of day — 2026-08-03
--
-- A challenge knew WHICH days it wanted and never WHEN. "Walk" and "10 minute
-- brain sesh" are not the same at 7am and at 9pm, and the reminder had no
-- choice but to fire at the two fixed hours the Beelink timers ran.
--
-- `remind_at` is a local wall-clock time (America/New_York, the same zone
-- ink_today() already pins), nullable: blank means "no particular time", which
-- is every existing row, so nothing needs a backfill. Readers that nudge use it
-- to pick the hour; readers that only display use it as a label.
--
-- `why` is deliberately left in place. It is dropped from Ink's form and card
-- in this same change, but old rows still carry text and the view column is
-- part of the thirteen the four readers select — see the LANDMINE below.
--
-- Additive and idempotent. The new column is APPENDED to the view: create or
-- replace view cannot rename, retype or drop an existing column, so anything
-- new must go after `today_local` or the replace fails and Ink, Today, Break
-- and the reMarkable brief all break at once.
-- ─────────────────────────────────────────────────────────────────────────────

alter table active_challenges add column if not exists remind_at time;

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
  c.cadence,
  coalesce(c.weekdays, array[1,2,3,4,5,6,7]::smallint[]) as weekdays,
  c.per_week      as week_target,
  case c.cadence
    when 'weekdays'     then extract(isodow from d.td)::smallint
                             = any(coalesce(c.weekdays, array[1,2,3,4,5,6,7]::smallint[]))
    when 'weekly_count' then d.week_done < coalesce(c.per_week, 1)
    else true
  end             as due_today,
  d.week_start,
  d.week_done,
  d.td            as today_local,
  -- ── appended 2026-08-03 ──────────────────────────────────────────────────
  c.remind_at
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
