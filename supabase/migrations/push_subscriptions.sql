-- ─────────────────────────────────────────────────────────────────────────────
-- Web push subscriptions — 2026-08-03
--
-- One row per browser/device that has granted notification permission. The
-- endpoint is the push service's URL for that device and is globally unique,
-- so it is the natural key: re-subscribing the same device updates rather than
-- duplicating, and a device that revokes permission gets deleted on the first
-- 404/410 from the push service.
--
-- Nothing here is challenge-specific. It is a generic delivery table so the
-- morning nudge, and anything Ink wants to push later, share one subscription.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

create index if not exists idx_push_subscriptions_user on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='push_subscriptions' and policyname='push_subscriptions_sel')
    then create policy push_subscriptions_sel on push_subscriptions for select using (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where tablename='push_subscriptions' and policyname='push_subscriptions_ins')
    then create policy push_subscriptions_ins on push_subscriptions for insert with check (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where tablename='push_subscriptions' and policyname='push_subscriptions_upd')
    then create policy push_subscriptions_upd on push_subscriptions for update using (auth.uid() = user_id) with check (auth.uid() = user_id); end if;
  if not exists (select 1 from pg_policies where tablename='push_subscriptions' and policyname='push_subscriptions_del')
    then create policy push_subscriptions_del on push_subscriptions for delete using (auth.uid() = user_id); end if;
end $$;

grant all on push_subscriptions to anon, authenticated;
