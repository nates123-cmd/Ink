// Executes supabase/migrations/challenges_engine.sql against a real Postgres
// (PGlite, in-process WASM) and checks the challenges_today contract — the view
// four apps read. Run: node tests/challenges-view.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '..', 'supabase', 'migrations', 'challenges_engine.sql'), 'utf8');

const db = new PGlite();
const OWNER = '11111111-1111-1111-1111-111111111111';

// Stand-ins for what Supabase provides: the auth.uid() helper and the two roles
// the grants name. Everything else is Still's original schema, pre-migration.
await db.exec(`
  create schema if not exists auth;
  create function auth.uid() returns uuid as $$ select '${OWNER}'::uuid $$ language sql stable;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  end $$;

  create table habits (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    user_id uuid
  );
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

// A pre-existing preset opt-in, written before any of the new columns existed.
await db.exec(`
  insert into active_challenges (id, challenge_key, start_date)
  values ('22222222-2222-2222-2222-222222222222', 'cold-shower', current_date - 4);
  insert into challenge_logs (active_challenge_id, date) values
    ('22222222-2222-2222-2222-222222222222', current_date),
    ('22222222-2222-2222-2222-222222222222', current_date - 1),
    ('22222222-2222-2222-2222-222222222222', current_date - 2),
    ('22222222-2222-2222-2222-222222222222', current_date - 4);
`);

await db.exec(migration);
console.log('migration applied');

// A custom, open-ended challenge — the case the old schema could not hold.
await db.exec(`
  insert into active_challenges (id, title, why, days, start_date, user_id)
  values ('33333333-3333-3333-3333-333333333333', '10 minute brain sesh', 'stop drifting', null, current_date - 1, '${OWNER}');
  insert into challenge_logs (active_challenge_id, date, user_id)
  values ('33333333-3333-3333-3333-333333333333', current_date - 1, '${OWNER}');
`);

const rows = (await db.query('select * from challenges_today order by title')).rows;
const brain = rows.find((r) => r.title === '10 minute brain sesh');
const cold = rows.find((r) => r.title === 'Cold Shower');

// The legacy row keeps working: no title column was ever set, so the key becomes one.
assert.equal(cold.title, 'Cold Shower', 'preset key falls back to a readable title');
assert.equal(cold.user_id, OWNER, 'legacy rows get claimed by the backfill');
assert.equal(cold.day_number, 5, 'started 4 days ago = day 5');
assert.equal(cold.done_today, true);
assert.equal(cold.days_done, 4);
assert.equal(cold.streak, 3, 'today + 2 = 3; the gap at day-3 stops it');

// Open-ended custom challenge, today still open.
assert.equal(brain.days, null, 'open-ended is allowed');
assert.equal(brain.why, 'stop drifting');
assert.equal(brain.done_today, false);
assert.equal(brain.day_number, 2);
assert.equal(brain.streak, 1, 'yesterday still counts while today is open');

// Logging today extends the streak rather than starting it over.
await db.exec(`insert into challenge_logs (active_challenge_id, date, user_id)
               values ('33333333-3333-3333-3333-333333333333', current_date, '${OWNER}')`);
const after = (await db.query("select * from challenges_today where title = '10 minute brain sesh'")).rows[0];
assert.equal(after.done_today, true);
assert.equal(after.streak, 2);

// A challenge with no logs at all must appear, not vanish behind the lateral.
await db.exec(`insert into active_challenges (id, title, days, start_date, user_id)
               values ('44444444-4444-4444-4444-444444444444', 'Fresh start', 7, current_date, '${OWNER}')`);
const fresh = (await db.query("select * from challenges_today where title = 'Fresh start'")).rows[0];
assert.ok(fresh, 'a challenge with zero logs still shows up');
assert.equal(fresh.streak, 0);
assert.equal(fresh.done_today, false);
assert.equal(fresh.day_number, 1);

// Completed ones drop out of the "today" contract.
await db.exec(`update active_challenges set completed = true where id = '44444444-4444-4444-4444-444444444444'`);
assert.equal((await db.query("select 1 from challenges_today where title = 'Fresh start'")).rows.length, 0);

// The view must carry the caller's RLS, not the owner's.
const inv = (await db.query(`select reloptions from pg_class where relname = 'challenges_today'`)).rows[0];
assert.ok(String(inv.reloptions).includes('security_invoker=on'), 'view runs as invoker so RLS applies');

// Re-running the whole migration must be a no-op, not a failure.
await db.exec(migration);
const again = (await db.query('select count(*)::int as n from challenges_today')).rows[0];
assert.equal(again.n, 2, 'idempotent: same two live challenges after a second run');

console.log('challenges_today: all assertions passed');
await db.close();
