// Runs all three challenge migrations against a real Postgres (PGlite,
// in-process WASM) and checks the time-of-day column: that it round-trips,
// that it is APPENDED to challenges_today, and that nothing above it moved.
// Run: node tests/challenges-time.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const sql = (f) => readFileSync(join(here, '..', 'supabase', 'migrations', f), 'utf8');

const db = new PGlite();
const OWNER = '11111111-1111-1111-1111-111111111111';

await db.exec(`
  create schema if not exists auth;
  create function auth.uid() returns uuid as $$ select '${OWNER}'::uuid $$ language sql stable;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;
  create table habits (id uuid primary key default gen_random_uuid(), name text not null, user_id uuid);
  create table active_challenges (
    id uuid primary key default gen_random_uuid(),
    challenge_key text not null,
    start_date date not null default current_date,
    outcome_note text,
    completed boolean default false,
    created_at timestamptz not null default now()
  );
  create table challenge_logs (
    id uuid primary key default gen_random_uuid(),
    active_challenge_id uuid not null references active_challenges(id) on delete cascade,
    date date not null default current_date,
    unique(active_challenge_id, date)
  );
  insert into habits (name, user_id) values ('read', '${OWNER}');
`);

// In order, each one replacing the view the previous left behind.
await db.exec(sql('challenges_engine.sql'));
await db.exec(sql('challenges_cadence.sql'));
await db.exec(sql('challenges_time.sql'));
console.log('all three migrations applied');

// Idempotent: running it twice is what happens when it is pasted into the SQL
// editor a second time, and it must not error.
await db.exec(sql('challenges_time.sql'));

// ── The column reads back as the wall-clock time it was given ───────────────
await db.exec(`
  insert into active_challenges (id, title, start_date, user_id, remind_at)
  values ('88888888-8888-8888-8888-888888888888', 'Walk', ink_today(), '${OWNER}', '07:00');
  insert into active_challenges (id, title, start_date, user_id)
  values ('99999999-9999-9999-9999-999999999999', 'Read', ink_today(), '${OWNER}');
`);
const row = async (t) => (await db.query(`select * from challenges_today where title=$1`, [t])).rows[0];
assert.equal(String((await row('Walk')).remind_at), '07:00:00', 'a time survives the round trip');
assert.equal((await row('Read')).remind_at, null, 'no time set is a real answer, not a default');

// ── The contract: thirteen, then cadence's seven, then this one ─────────────
const cols = (await db.query(
  `select column_name from information_schema.columns
    where table_name='challenges_today' order by ordinal_position`)).rows.map((r) => r.column_name);
assert.deepEqual(cols.slice(0, 13), [
  'id', 'user_id', 'title', 'challenge_key', 'why', 'description', 'days',
  'start_date', 'completed', 'day_number', 'done_today', 'days_done', 'streak',
], 'Ink, Today, Break and the reMarkable brief read these thirteen by name');
assert.deepEqual(cols.slice(13), [
  'cadence', 'weekdays', 'week_target', 'due_today', 'week_start', 'week_done', 'today_local',
  'remind_at',
], 'remind_at is appended — create or replace view cannot reorder or retype');

// The rest of the contract survived the third replace.
const walk = await row('Walk');
assert.equal(walk.due_today, true);
assert.equal(walk.day_number, 1);
assert.equal(walk.cadence, 'daily');
const inv = (await db.query(`select reloptions from pg_class where relname='challenges_today'`)).rows[0];
assert.ok(String(inv.reloptions).includes('security_invoker=on'), 'security_invoker survived the replace');

await db.close();
console.log('challenges_time: all assertions passed');
