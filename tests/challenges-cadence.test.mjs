// Runs BOTH challenge migrations against a real Postgres (PGlite, in-process
// WASM) and checks the widened challenges_today contract: the three cadences,
// the local-date fix, and that the thirteen columns the four apps already read
// did not move. Run: node tests/challenges-cadence.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const sql = (f) => readFileSync(join(here, '..', 'supabase', 'migrations', f), 'utf8');
const engine = sql('challenges_engine.sql');
const cadence = sql('challenges_cadence.sql');

const db = new PGlite();
const OWNER = '11111111-1111-1111-1111-111111111111';

// Still's original schema plus the two things Supabase provides.
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

await db.exec(engine);
// The widened view has to replace the narrower one in place, not drop it.
await db.exec(cadence);
console.log('both migrations applied');

// Every fixture is anchored to ink_today(), not current_date — the whole point
// of this migration is that those two are allowed to differ.
const TD = (await db.query('select ink_today() as td')).rows[0].td;
const iso = (d) => d.toISOString().slice(0, 10);
const td = new Date(`${TD instanceof Date ? iso(TD) : TD}T00:00:00Z`);
const day = (n) => iso(new Date(td.getTime() + n * 86400000));

const mk = (id, extra) => db.exec(
  `insert into active_challenges (id, title, start_date, user_id, ${Object.keys(extra.cols).join(', ')})
   values ('${id}', '${extra.title}', '${extra.start}', '${OWNER}', ${Object.values(extra.cols).join(', ')})`);
const log = (id, offsets) => db.exec(offsets.map((n) =>
  `insert into challenge_logs (active_challenge_id, date, user_id) values ('${id}', '${day(n)}', '${OWNER}');`).join(''));
const row = async (title) =>
  (await db.query(`select * from challenges_today where title = $1`, [title])).rows[0];

// ── The local-date fix ──────────────────────────────────────────────────────
const dates = (await db.query(
  `select ink_today() as local, (now() at time zone 'America/New_York')::date as ny`)).rows[0];
assert.equal(String(dates.local), String(dates.ny), 'ink_today() is the New York calendar day');

// ── daily: unchanged behaviour, and today stays open ────────────────────────
await mk('22222222-2222-2222-2222-222222222222',
  { title: 'Walk', start: day(-4), cols: { cadence: `'daily'`, days: 7 } });
await log('22222222-2222-2222-2222-222222222222', [0, -1, -2, -4]);
const walk = await row('Walk');
assert.equal(walk.day_number, 5, 'started 4 days ago = day 5');
assert.equal(walk.done_today, true);
assert.equal(walk.days_done, 4);
assert.equal(Number(walk.streak), 3, 'today + 2; the gap at day -3 stops it');
assert.equal(walk.due_today, true, 'daily is owed every day');
assert.equal(walk.cadence, 'daily');
assert.deepEqual(walk.weekdays, [1, 2, 3, 4, 5, 6, 7], 'daily reports every weekday scheduled');

// A daily challenge with nothing logged today keeps yesterday's streak.
await db.exec(`delete from challenge_logs
                where active_challenge_id='22222222-2222-2222-2222-222222222222'
                  and date='${day(0)}'`);
const walkOpen = await row('Walk');
assert.equal(walkOpen.done_today, false);
assert.equal(Number(walkOpen.streak), 2, 'today still open, so it does not count as a miss');
await log('22222222-2222-2222-2222-222222222222', [0]);

// ── weekdays: a rest day must not break the streak ──────────────────────────
// Schedule only today's weekday and the one two days back, so the day between
// them is deliberately unscheduled.
const dowSql = async (n) =>
  Number((await db.query(`select extract(isodow from date '${day(n)}')::int as d`)).rows[0].d);
const [d0, d2, d1] = [await dowSql(0), await dowSql(-2), await dowSql(-1)];

await mk('33333333-3333-3333-3333-333333333333',
  { title: 'Gym', start: day(-2), cols: { cadence: `'weekdays'`, weekdays: `'{${d0},${d2}}'::smallint[]` } });
await log('33333333-3333-3333-3333-333333333333', [0, -2]);
const gym = await row('Gym');
assert.equal(gym.due_today, true, "today's weekday is scheduled");
assert.equal(Number(gym.streak), 2, 'the unscheduled day between them is not a miss');
assert.equal(gym.days_done, 2);

// A day that is not scheduled owes nothing, and skipping it costs nothing.
await mk('44444444-4444-4444-4444-444444444444',
  { title: 'Rest day', start: day(-2), cols: { cadence: `'weekdays'`, weekdays: `'{${d1}}'::smallint[]` } });
await log('44444444-4444-4444-4444-444444444444', [-1]);
const rest = await row('Rest day');
assert.equal(rest.due_today, false, 'not scheduled today');
assert.equal(Number(rest.streak), 1, 'yesterday counted and today is not owed');

// An actual miss on a scheduled day does break it.
await mk('55555555-5555-5555-5555-555555555555',
  { title: 'Missed', start: day(-2), cols: { cadence: `'weekdays'`, weekdays: `'{${d0},${d1},${d2}}'::smallint[]` } });
await log('55555555-5555-5555-5555-555555555555', [0, -2]);
assert.equal(Number((await row('Missed')).streak), 1, 'yesterday was scheduled and skipped');

// ── weekly_count: a target, not a streak of days ────────────────────────────
await mk('66666666-6666-6666-6666-666666666666',
  { title: 'Four walks', start: day(-7), cols: { cadence: `'weekly_count'`, per_week: 2 } });
await log('66666666-6666-6666-6666-666666666666', [0]);
const w1 = await row('Four walks');
assert.equal(w1.week_target, 2);
assert.equal(Number(w1.week_done), 1, 'one check-in inside this week so far');
assert.equal(w1.due_today, true, 'still short of the weekly target');
assert.equal(Number(w1.streak), 0, 'this week is not met yet and last week was empty');

// Meeting the target stops the nagging.
await mk('77777777-7777-7777-7777-777777777777',
  { title: 'One walk', start: day(-7), cols: { cadence: `'weekly_count'`, per_week: 1 } });
await log('77777777-7777-7777-7777-777777777777', [0, -7]);
const w2 = await row('One walk');
assert.equal(w2.due_today, false, 'target met, nothing owed today');
assert.equal(Number(w2.streak), 2, 'this week and the week before both met the target');

// ── The contract the four readers already select must not have moved ────────
const cols = (await db.query(
  `select column_name from information_schema.columns
    where table_name='challenges_today' order by ordinal_position`)).rows.map((r) => r.column_name);
assert.deepEqual(cols.slice(0, 13), [
  'id', 'user_id', 'title', 'challenge_key', 'why', 'description', 'days',
  'start_date', 'completed', 'day_number', 'done_today', 'days_done', 'streak',
], 'Ink, Today, Break and the reMarkable brief read these thirteen by name');
assert.deepEqual(cols.slice(13), [
  'cadence', 'weekdays', 'week_target', 'due_today', 'week_start', 'week_done', 'today_local',
]);

// Completed challenges still drop out.
await db.exec(`update active_challenges set completed = true where title = 'Missed'`);
assert.equal((await db.query(`select 1 from challenges_today where title='Missed'`)).rows.length, 0);

// The view still runs as the invoker, so RLS applies.
const inv = (await db.query(`select reloptions from pg_class where relname='challenges_today'`)).rows[0];
assert.ok(String(inv.reloptions).includes('security_invoker=on'), 'security_invoker survived the replace');

// Bad cadence values are rejected rather than silently stored.
await assert.rejects(
  db.exec(`insert into active_challenges (title, start_date, user_id, cadence)
           values ('Bad', '${day(0)}', '${OWNER}', 'monthly')`),
  /cadence_chk/, 'the cadence check constraint is live');

// Re-running is a no-op, not a failure.
await db.exec(cadence);
await db.exec(cadence);
assert.equal(Number((await db.query('select count(*)::int as n from challenges_today')).rows[0].n), 5,
  'idempotent: same five live challenges after two more runs');

console.log('challenges_today cadence contract: all assertions passed');
await db.close();
