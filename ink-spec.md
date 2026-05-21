# Ink — Project Spec

*Personal record system. Successor to Still. Aged paper + faded indigo. Free-write, Claude structures.*

---

## What it is

The fourth app in the personal OS suite alongside Tick, Break, Tide, Course, Patch, Crate. **Replaces Still entirely.** Same Supabase project, same single-file PWA stack, same GitHub Pages deploy. New name, new palette, expanded scope.

**The shift from Still:** Still was a reflection app — contemplative, monastic, *being with*. Ink is a personal record system — accumulative, retrospective, *putting down what's worth keeping*. Reflection survives as one mode of writing into Ink, not the central function.

**Live URL (target):** `https://nates123-cmd.github.io/Ink/`
**Repo:** new repo `nates123-cmd/Ink` (do not edit the existing `Still-App` repo — Ink is a fresh build that pulls from Still's Supabase tables for continuity)

---

## Suite slot

| App | Owns | Color Weather |
|---|---|---|
| **Ink** *(replaces Still)* | Personal record — day log, restaurants, media, habits, reflection, stoic practice, pattern analysis | Aged paper + faded indigo. Manuscript page, fountain-pen ink. |

**Vibe:** Quiet, literary, slightly archival. The app for putting today's ink down on the page and looking back through what's been kept.

**Voice for Claude content:** Retrospective, not in-the-moment. "How has temperance shown up?" not "How is it going?" Tight, present-tense, ink-on-paper. No emoji, no exclamations. When uncertain, lean serif and slightly literary.

---

## Navigation & Mind redesign — LOCKED 2026-05-18

**Authoritative.** Supersedes, below: §Architecture overview, §Home screen (gestures/edge labels/slot targets), §Today screen (removed), §Compose screen (removed), §Journal screen (now also the day surface), §Stoic / Thoughts / Reflect (Thoughts & Reflect folded), §Routing and navigation. Older sections kept for history under a supersede banner. **SHIPPED 2026-05-18 — implemented and deployed live (`ink-v3`).**

### Gesture model (home)

| Gesture | Surface | Enters |
|---|---|---|
| Swipe **up** | **Capture** — one full-bleed freeform textarea → a `thoughts` row. No prompt, no parsing, no review. | from bottom |
| Swipe **down** | **Journal** — the day surface **and** the read timeline (see below). | from top |
| Swipe **left** | **Stoic** — unchanged. The only surface that writes `reflections`; feeds the home morning-intention loop. | from right |
| Swipe **right** | **Mind** — 3-tab thought lifecycle (Thoughts / Insights / Mantras). | from left |
| **Long-press** canvas | **Options menu** bottom sheet: Settings, Challenges, Habits manage, Prompt Library, Pattern. (No longer opens Journal.) | sheet |
| ~~`+` button~~ | **Removed** — no unified compose, no Claude parse-and-file. | — |

Edge labels: `▲ CAPTURE` / `JOURNAL ▼` / `◀ STOIC` / `MIND ▶`. Long-press hint copy → "LONG PRESS · MENU". Content-slot priority unchanged (morning intention → mantra → quote); mantra source remains the shared `mantras` table, now fed by Mind's "flag as mantra". Tapping the morning-intention slot routes to Stoic (the reflection surface) rather than the old Reflect.

### Removed

- **Today screen** — deleted; its three jobs move into Journal.
- **Compose / compose-review**, the unified `+`, filing card, type chooser, multi-record write model, append-vs-separate override — all removed. `restaurant_visits` / `media_entries` now originate only from (a) the Journal day-log's live extraction and (b) agent-run bulk import.
- **Reflect screen** — folded. Free-form reflection no longer exists outside Stoic; `reflections` is written **only** by the Stoic screen.
- **Thoughts screen (old)** — replaced by Capture (write) + Mind (manage).

### Capture (swipe up)

Full-screen serif textarea, placeholder *"What's on your mind?"*, date/time line, Home + `×` controls, ⌘/Ctrl+Enter to save. Save → one `entries` row (`primary_type='thought'`, `source_surface='thoughts_screen'`) + one `thoughts` row (`status='active'`); return home.

### Journal (swipe down) — day surface + timeline

Top→bottom: (1) habit pill strip (toggles `habit_logs`); (2) today's day-log editor card with live entity-extraction tags + the "Open · not yet logged" backfill list; (3) filter chips `All / Days / Restaurants / Media / Thoughts / Reflections`; (4) the unified timeline. Everything the old Today screen did lives at the top of Journal; the rest is the existing read timeline.

### Mind (swipe right) — thought lifecycle

Tabs **Thoughts · Insights · Mantras**. Each lists `status='active'` rows newest-first; a Dismissed toggle reveals `status='dismissed'`.

- **Thoughts** row: → Insight · → Mantra · Push to Course · Dismiss · Delete (Resurface if dismissed)
- **Insights** row: → Mantra · Push to Course · Dismiss · Delete
- **Mantras** row: Push to Course · Dismiss · Delete

**Move = move, not copy.** Promote = insert into the target table carrying `text` + `source_entry_id`, then delete the source row — a promoted thought leaves Thoughts and appears under Insights, etc. The shared `mantras` (feeds home + Break) and Still's `insights` stay the system of record so existing integrations keep working. Promote opens a one-field confirm allowing a light text edit before the move. **Dismiss** → `status='dismissed'` (reversible). **Resurface** → `status='active'`. **Delete** → row removed (single confirm).

### Push to Course (v1 — via Course's inbox)

Course's inbox is the **`course_captures`** table on the **same shared Supabase project** (`xsmnfcmtbpeaccnyinkr`): `raw_text` (not null), `suggested_project_id?`, `suggested_task_title?`, `work_area?`, `status` `'pending'|'processed'|'dismissed'` (default `'pending'`), `created_at`, `processed_at`. Course's own Inbox triage classifies pending items — there is no direct task/project create endpoint.

Ink's "Push to Course" (every Mind row, any stage): a small **Task / Project / Note** chooser, then `INSERT course_captures { raw_text, status:'pending' }` where `raw_text` carries a type hint (prefix `[task] ` / `[project] ` / `[note] `), and for **Task** also set `suggested_task_title` to the item text. Set the Ink-side row's `pushed_to_course = true` for a badge; the row does not move. Plain insert into an existing table — no Course-side work.

### Additive schema migration — APPLIED 2026-05-18

```sql
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
```

Additive/idempotent; no DROP, no data mutation. `mantras` is shared with Break — the new nullable columns are inert to Break (it selects `text`).

### Build order — COMPLETED 2026-05-18

1. ✅ Apply migration. 2. ✅ Rebuild home gesture map + edge labels + long-press menu; delete Today/Compose/Reflect screens. 3. ✅ Journal absorbs habit strip + day-log + open-days. 4. ✅ Capture screen. 5. ✅ Mind 3-tab surface + promote/dismiss/resurface/delete. 6. ✅ Push-to-Course. 7. ✅ `sw.js` `ink-v2→ink-v3`, syntax check, commit, deploy.

---

## Architecture overview

> ⚠️ **SUPERSEDED by "Navigation & Mind redesign — LOCKED 2026-05-18"** (above). Kept for history — do not implement from here.

### Two write doors, one read surface

**Write door 1 — Today screen (swipe up from home):** habit pills strip + day log card. Writing here is unambiguously a day log entry. No type review needed — surface implies type. Same screen also holds habit checks.

**Write door 2 — Unified `+` (top-right on home):** any entry, any type. You write prose, tap Review, Claude parses and shows a filing card with the picked type and extracted fields. You confirm or change the type. Save commits one primary record and any attached secondary records.

**Read surface — Journal screen (long-press on home):** unified timeline with filter chips. `All / Days / Restaurants / Media / Thoughts / Reflections`. Each entry type renders in its own row layout. Tapping any entity (place name, person, title) drills into entity detail (v2, see Roadmap).

### Multi-record write model

One write action can produce multiple linked records. Example: "Steak frites at Raoul's with Mandy. Saw Conclave after." produces:

1. **Primary record:** `restaurant_visits` row (Raoul's, with Mandy, dishes: steak frites)
2. **Attached record:** `day_logs` row for today's date, appended to existing if one exists
3. **Attached record:** `media_entries` row for Conclave (film, watched)

All records share a `source_entry_id` linking back to the original write action, so the user can edit the prose later and the linked records update.

### Append rule for day logs

When a write produces a `day_logs` record for today and one already exists, default behavior is **append** — concatenate the new prose with " · " separator. The review screen offers a "save as separate entry" override.

---

## File structure

```
index.html         — entire app (~1200-1500 lines, HTML + CSS + JS)
sw.js              — service worker (cache name: ink-vN, bump on deploy)
manifest.json      — PWA manifest
dev-config.js      — GITIGNORED — sets Anthropic API key in localStorage for local dev
.gitignore         — ignores dev-config.js
CLAUDE.md          — this file (short brief for Claude Code; full spec is ink-spec.md)
ink-spec.md        — the full spec (this document)
```

---

## Tech stack

- **No build step** — plain HTML/CSS/JS, edit and refresh
- **Model:** `claude-sonnet-4-7` (Sonnet 4.7 has stronger structured extraction than the 4-6 Still uses). Direct browser fetch with `anthropic-dangerous-direct-browser-access: true`
- **Supabase** — REST API (no SDK), anon key auth, **same project as Still / Break / Tide**
- **Service worker** — cache-first static, network-first for Anthropic + Supabase, bypass on localhost

---

## Palette — aged paper + faded indigo

```css
--bg:           #F0EAD6   /* aged paper, warmer than Still's #F5F2EE */
--bg-deep:      #E6DFC6   /* nested element bg */
--text:         #2A2418   /* warm near-black, ink on paper */
--text-soft:    #3D362A   /* slightly less emphatic body text */
--muted:        #6B5F4A   /* warm gray-brown, secondary labels */
--hint:         #8A7D62   /* tertiary text */
--whisper:      #A89976   /* edge labels, dates, micro-copy */
--accent:       #3D4A7A   /* faded indigo — fountain-pen ink, slightly oxidized */
--accent-soft:  #7A85AB   /* lighter indigo for less-emphasized accents */
--accent-faint: #C7CCDF   /* type-glyph backgrounds, badge fills */
--card-bg:      #E8E0C8   /* raised card bg on canvas */
--border:       #D6CCAE   /* aged paper edges */
--hairline:     #E2D9BE   /* row dividers */
--radius:       14px
```

**iOS PWA manifest discipline:** `background_color` and `theme_color` in `manifest.json` must match `--bg` (`#F0EAD6`), as must `<meta name="theme-color">`. Otherwise the safe-area-inset-bottom strip on iOS standalone shows as a band beneath the canvas. **Set these once and never rewrite `theme-color` in JS, and ship no runtime (clock or `prefers-color-scheme`) background swap** — the manifest is static and cannot follow one. This is the root of Still defect F1; see "Carried-over fixes from Still → F1" below for the full diagnosis.

**Typography:**
- UI chrome, labels, buttons, structured fields: system-ui sans (`-apple-system, BlinkMacSystemFont, "SF Pro Text"`).
- **Anything that is the user's voice or evokes paper**: serif (`Georgia, "Iowan Old Style", "Times New Roman"`).
- Specifically: the `Ink.` wordmark, the big date on home, the composition surface in `+`, quoted note excerpts in journal entries, full Thoughts entries.
- Date numerals in journal rows: serif. Day-of-week letters: sans uppercase letterspaced.

---

## Supabase schema

**Same Supabase project** as Still / Break / Tide. Run the following SQL in addition to the existing tables. Some existing Still tables are reused as-is (`habits`, `habit_logs`, `quick_captures`, `saved_prompts`, `active_challenges`, `challenge_logs`). Some are renamed/expanded. New tables added for the structured entity types.

### New / changed tables

```sql
-- Source-of-truth for every write action. Every entry the user composes
-- via the + or Today surface creates exactly one row here. Other tables
-- reference this row via source_entry_id.
create table entries (
  id uuid primary key default gen_random_uuid(),
  raw_text text not null,
  composed_at timestamptz not null default now(),
  primary_type text not null check (primary_type in ('day','restaurant','media','thought','reflection')),
  source_surface text not null check (source_surface in ('today_screen','unified_plus','stoic_screen','reflect_screen','thoughts_screen')),
  created_at timestamptz not null default now()
);

-- Day log — one row per (date, possibly multiple if user explicitly opted out of append)
create table day_logs (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  text text not null,
  date date not null default current_date,
  extracted_entities jsonb default '{}'::jsonb,  -- {restaurants:[], people:[], places:[], activities:[], media:[], cooking:[]}
  created_at timestamptz not null default now()
);

-- Restaurant visits — one row per visit
create table restaurant_visits (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  place_name text not null,
  visit_date date not null default current_date,
  with_people text[],         -- ["Mandy", "Cedric"]
  dishes text[],              -- ["steak frites", "Côtes du Rhône"]
  note text,                  -- italicized quoted excerpt from prose
  would_return boolean,       -- optional
  created_at timestamptz not null default now()
);

-- Media entries — one row per consumption event
create table media_entries (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  title text not null,
  format text not null check (format in ('film','tv','book','podcast','other')),
  consumed_date date not null default current_date,
  rating int check (rating >= 1 and rating <= 5),  -- optional, nullable
  note text,                  -- italicized quoted excerpt from prose
  created_at timestamptz not null default now()
);

-- Free-form thoughts — when Claude classifies the entry as a thought (not tied to a specific entity type)
create table thoughts (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid references entries(id) on delete set null,
  text text not null,
  thought_date date not null default current_date,
  created_at timestamptz not null default now()
);

-- Existing Still 'reflections' table stays as-is. Renamed in product UI to "Reflections" tab.
-- Just add source_entry_id for consistency:
alter table reflections add column if not exists source_entry_id uuid references entries(id) on delete set null;

-- Existing Still tables that carry over unchanged:
-- habits, habit_logs, insights, active_challenges, challenge_logs, saved_prompts, quick_captures

-- RLS for new tables
alter table entries enable row level security;
alter table day_logs enable row level security;
alter table restaurant_visits enable row level security;
alter table media_entries enable row level security;
alter table thoughts enable row level security;

create policy "anon all" on entries for all using (true) with check (true);
create policy "anon all" on day_logs for all using (true) with check (true);
create policy "anon all" on restaurant_visits for all using (true) with check (true);
create policy "anon all" on media_entries for all using (true) with check (true);
create policy "anon all" on thoughts for all using (true) with check (true);

-- Indexes for common queries
create index idx_day_logs_date on day_logs(date desc);
create index idx_restaurant_visits_date on restaurant_visits(visit_date desc);
create index idx_restaurant_visits_place on restaurant_visits(place_name);
create index idx_media_entries_date on media_entries(consumed_date desc);
create index idx_media_entries_title on media_entries(title);
create index idx_thoughts_date on thoughts(thought_date desc);
create index idx_entries_composed on entries(composed_at desc);
```

### What stays from Still

`reflections`, `habits`, `habit_logs`, `insights`, `quick_captures`, `active_challenges`, `challenge_logs`, `saved_prompts` — all kept as-is. The Oura integration (`smooth-processor` edge function under `/functions/v1/smooth-processor`) carries over unchanged.

---

## Screens

| Screen ID | Reached by | Purpose |
|---|---|---|
| `home` | Default | Gesture canvas with date centerpiece, rotating content slot, `+` button, edge labels |
| `today` | Swipe up from home | Habit pill strip + day log card (the write surface for today's day log) |
| `stoic` | Swipe left from home | Stoic practices (carryover from Still, re-skinned) |
| `thoughts` | Swipe right from home | Free thoughts compose (carryover from Still, re-skinned) |
| `reflect` | Swipe down from home | Prompted reflection (carryover from Still, re-skinned) |
| `compose` | Tap `+` on home | Unified write surface — prose composition + Review |
| `compose-review` | Tap Review from compose | Claude's filing card + attached records + Edit/File buttons |
| `journal` | Long-press canvas on home | Read surface — filter chips + unified timeline |
| `entity-detail` | Tap any entity in journal (v2) | All entries tied to that place/person/title |
| `insights` | Settings / overflow | View flagged insights (carryover) |
| `challenges` | Settings / overflow | Browse + opt in to challenges (carryover) |
| `habits-manage` | Settings / overflow | Add/remove habits (carryover) |
| `prompt-library` | Settings / overflow | Browse / pin / delete saved Stoic prompts (carryover) |
| `pattern` | Settings / overflow | Claude pattern analysis across recent entries (carryover, expanded to read across all new tables) |

### Deeplinks

Ink accepts URL search params at boot to land on a screen directly.
Used by Today's morning grounding tiles to jump into Stoic with a
specific practice type already selected.

| Param | Values | Effect |
|---|---|---|
| `screen` | any screen ID from the table above | Calls `navigate(<id>)` after the home boot, putting that screen on top of the stack. Back returns to home. |
| `stoic` | `morning` \| `evening` \| `premeditatio` | When `screen=stoic`, pre-sets `stoicType` so the right practice tab is active when `initStoic()` runs. |

Examples:
- `https://nates123-cmd.github.io/Ink/?screen=stoic&stoic=morning` → Stoic / Morning Intention
- `https://nates123-cmd.github.io/Ink/?screen=stoic&stoic=premeditatio` → Stoic / Premeditatio Malorum

PWA caveat: if Ink is already running in the background, iOS may
foreground it without re-executing the boot script, in which case the
URL params get ignored. Force-quitting Ink and retapping the deeplink
always works.

---

## Home screen

> ⚠️ **Gestures/edge-labels/slot-targets SUPERSEDED by "Navigation & Mind redesign — LOCKED 2026-05-18".** Canvas layout (date centerpiece, content slot) still applies; the gesture map and `+` do not.

**Layout:** centered canvas, edge-labeled gesture nav, no scroll.

**Top bar:**
- Top-left: `Ink.` wordmark in serif Georgia, 19px, weight 500. The period is `--accent` indigo. This is the brand mark — sentence has stopped, ink is on paper.
- Top-right: 36×36 filled indigo circle with white `ti-plus` icon. Opens `compose`.

**Canvas center:**
- Day of week ("Friday") in 13px muted, letterspaced.
- Big date number ("15") in serif, 64px, weight 400, letter-spacing -2px. This is the centerpiece.
- Month + year ("MAY · MMXXVI") in 11px whisper, letterspaced uppercase. Roman numeral year is intentional — leans into the manuscript identity. Setting in Settings → "Year format" can switch to Arabic.
- Content slot below, separated by 36px gap:
  - Label "MORNING INTENTION" / "MANTRA" / "QUOTE" in 9.5px whisper letterspaced
  - Body in 15.5px serif italic, `--text-soft`. Referenced virtue or quoted word styled in `--accent` non-italic weight 500.

**Content slot priority (same as Still):**
1. Morning intention check-in — if today has a `reflections` row with `tags @> {stoic}` and `prompt_used = 'Morning Intention'`, generate a retrospective check-in line referencing the named virtue. Voice shift from Still: use "how has it shown up?" not "how is it going?". Renders the check-in line **and** a short highlight of what the user actually wrote (Still defects F2 + F4). Cached as `localStorage['ink_morning_blurb_{YYYY-MM-DD}']` with shape `{reflection_id, intention, highlight, line}`; regenerate when `reflection_id` no longer matches today's entry.
2. Mantra — random from `mantras` table (Break's table, same Supabase project), avoiding immediate repeats.
3. Quote of the day — deterministic by day-of-year from hardcoded `QUOTES` array.

**Active challenge chip:** if `active_challenges` row exists where `completed = false`, show a quiet pill near the bottom: `<flame icon> 30-day sober · day 15`. Position: `bottom: 70px` from canvas, centered. Tapping navigates to challenge detail (carryover screen).

**Long-press hint:** at `bottom: 14px`, centered, 9px whisper letterspaced, opacity 0.55: "LONG PRESS · OPEN JOURNAL". Hide after 5 home opens (track in `localStorage['ink_lp_hint_count']`).

**Edge labels:**
- Top: `▲ TODAY`
- Left: `◀ STOIC`
- Right: `THOUGHTS ▶`
- Bottom: `REFLECT ▼`

All in 10px whisper letterspaced (3.5px). Triangles in `--accent-soft`.

**Gestures:**
- Swipe up → `today`
- Swipe left → `stoic`
- Swipe right → `thoughts`
- Swipe down → `reflect`
- Long-press anywhere on canvas (excluding `+` button and active chip) → `journal`
- Tap `+` → `compose`

---

## Today screen (habits + day log)

> ⚠️ **REMOVED — SUPERSEDED by "Navigation & Mind redesign — LOCKED 2026-05-18".** This screen no longer exists; its habit strip + day-log + open-days backfill move to the top of Journal. Behaviors below still describe how those pieces work — just inside Journal now.

**Top bar:** crumb "TODAY · DAY LOG" in 11px whisper letterspaced top-left. Right side has a `ti-dots` overflow icon for habit management.

**Habit pill strip:** horizontal scroll, 6px gaps, 6px vertical padding. Each pill:
- Empty state: outlined, transparent bg, `◯` ring + habit name + small streak number in whisper
- Done state: filled `--card-bg`, indigo border, `●` ring with check glyph, habit name in `--text`, streak in whisper

Tap a pill ring → toggle today's `habit_logs` row.

Habits managed via overflow menu → `habits-manage` screen (carryover from Still).

**Edge labels:** STOIC (left), THOUGHTS (right), REFLECT (down). No TODAY edge (already here). Swipe down returns to home.

**Day log card** (dominant element, ~280px min-height):
- Background: `--card-bg`, radius 18px, padding 20px 18px 16px, 0.5px border `--border`.
- Header: large date prefix in matched format to your handwritten notes ("15F" — number + day letter, where day letters are M/T/W/R/F/S/Su per your convention). Serif Georgia, 22px, weight 500, color `--accent`. Plus "friday" in 12px whisper lowercase letterspaced.
- Prose: serif Georgia, 16px, line-height 1.6, color `--text`. Min-height 120px. Always-on writeable — cursor lives here when screen is opened.
- Tag row: appears under a hairline divider after extraction completes. Tags in 12px muted with 13px accent glyphs. Newly-extracted tags get a brief `.fresh` highlight (3 seconds, then fade to normal).
- Status line: 10.5px whisper letterspaced, centered below tags. Shows "EXTRACTING •" with pulsing dot during the 800ms debounced Claude call, then disappears.

**Save behavior:**
- Auto-saves on blur or after 2s of typing inactivity.
- Writes to `entries` (raw_text, primary_type='day', source_surface='today_screen').
- Then writes to `day_logs` — append to today's row if exists, otherwise insert. `extracted_entities` populated from Claude's response.
- Also writes to entity-type tables for any restaurants/media/people Claude found in the prose (`restaurant_visits` for places identified as restaurants, `media_entries` for identified titles, etc.). All linked via `source_entry_id`.

**Open days (backfill):** below the day-log card, an "Open · not yet logged" list shows every date in the trailing `OPEN_WINDOW` (default 14) days that has no `day_logs` row. Tapping a date opens a backfill sheet (prose textarea → Save) that writes an `entries` row with `composed_at` set to that date's noon plus a `day_logs` row dated to it, then refreshes the list. Shows an "all caught up" line when the window is fully logged. This is the per-day catch-up surface; for a one-time bulk import of historical days see "Bulk historical import" below.

**Extraction prompt (Claude call):** Sonnet 4.7, prompt template:

> You are parsing a personal day-log entry to extract structured entities. Return JSON only, no preamble.
> Input: `{raw_text}`
> Return shape:
> ```json
> {
>   "entities": {
>     "restaurants": [{"name": "Raoul's", "dishes": ["steak frites"], "note": "..."}],
>     "media": [{"title": "Conclave", "format": "film", "note": "..."}],
>     "people": ["Mandy"],
>     "places": ["Purgatory"],
>     "activities": ["Disc Golf", "Gym"],
>     "cooking": ["Lentil bowls"]
>   },
>   "tags": [...]  // flat list for tag-trail rendering, ordered by prominence
> }
> ```
> Conservative extraction — if uncertain whether a noun is an entity, leave it out. Names of friends/people: extract first names only. Restaurant note: pull a short literal phrase from the prose, max 12 words.

---

## Compose screen (unified `+`)

> ⚠️ **REMOVED — SUPERSEDED by "Navigation & Mind redesign — LOCKED 2026-05-18".** The `+`, the write→Review→File flow, the filing card, the type chooser, and the multi-record write model are all dropped. Do not implement.

**Two states:**

### State 1 — Writing

**Top bar:** "NEW ENTRY" crumb top-left, close `×` top-right.

**Body:**
- Date + time line in 13px muted: "Friday, 15 May · 8:42 pm".
- Compose textarea: serif Georgia, 17px, line-height 1.6, `--text`, min-height 200px. Placeholder italic in `--whisper`: *"What's worth keeping?"*

**Bottom action bar:** absolute bottom, gradient mask fading to `--bg`.
- Left: 11px whisper character count.
- Right: "Review →" button — filled indigo pill with white text + ti-arrow-right.

Tap Review → calls Claude with the full prose, transitions to State 2.

### State 2 — Review

**Top bar:** "CONFIRM FILING" crumb, close `×` returns to compose (preserves prose).

**Filing card** (primary record Claude picked):
- Card bg `--card-bg`, radius 14px, padding 16px.
- Top row: 32×32 type glyph (accent-faint bg, accent icon), then type name in 15px weight 500 + date in 11px muted underneath, then "Change" link top-right in 11px accent letterspaced.
- Field grid below a hairline:
  - Field label (uppercase 11px muted letterspaced, 70px width).
  - Field value (13px text). Editable values shown as pills with `--bg` background + `--border` border. The "Note" field shows a quoted excerpt in serif italic — literal pull from the prose.

**Restaurant card fields:** Place (single pill), With (multiple pills), Had (multiple pills), Note (quoted serif italic).

**Media card fields:** Title (single pill), Format (single pill), Note (quoted serif italic), Rating (optional star row if Claude inferred sentiment strongly — otherwise omitted).

**Thought card fields:** Body (full serif italic excerpt, no further breakdown).

**Reflection card fields:** Prompt-used (if applicable), Mood (if inferred), Tags.

**Day log card fields:** Date (today), and a note line showing "Appending to today's existing log" or "First log of the day".

**Also filing block** (below filing card, dashed border, `--bg-deep` bg):
- Heading "ALSO FILING" in 10.5px muted letterspaced.
- Each attached secondary record on its own row with small accent glyph + plain-language description: e.g. "Media — **Conclave** (film) · watched" or "Day log — adds to today's entry".

**Bottom actions:** "Edit" outlined neutral button + "File ✓" filled indigo button. File commits all records and returns to wherever the user was (home).

### Type chooser (Change link tap)

Opens a small overlay sheet (50% screen, slides up from bottom) with:
- Header "Filing as" in 11px muted letterspaced
- Five type cards arranged in a 2-column grid:
  - Day log (book icon)
  - Restaurant (kitchen icon)
  - Media (play icon)
  - Thought (quote icon)
  - Reflection (feather icon)
- Currently-selected type highlighted with `--accent` border
- Tap a type → sheet dismisses, filing card re-renders with the new type's field layout (Claude re-called with `force_type` parameter)

---

## Journal screen (read surface)

> ⚠️ **PARTIALLY SUPERSEDED by "Navigation & Mind redesign — LOCKED 2026-05-18".** Reached by **swipe down** (not long-press), and it now carries the habit strip + day-log editor + open-days backfill above the timeline. The filter chips + per-type row layouts below still apply.

**Reached by:** long-press on home canvas.

**Top bar:** back arrow left, "Journal" title in serif Georgia 17px center, search icon right.

**Filter chips row:** horizontal scroll, 6 chips:
- `All <count>` (default active)
- `<book> Days <count>`
- `<kitchen> Restaurants <count>`
- `<play> Media <count>`
- `<quote> Thoughts <count>`
- `<feather> Reflections <count>`

Active chip: filled `--accent` bg, white text. Inactive: outlined, neutral. Count is in 10px tabular, 70% opacity.

**Month divider:** sticky on scroll. "MAY 2026" in 10px whisper letterspaced + thin border-bottom line.

**Timeline rows** (different layouts by entry type, shared left rail):

Left rail (38px width, shared across all types):
- Day number in serif Georgia, 18px weight 500
- Day-of-week ("Fri", "Wed") in 9px whisper letterspaced uppercase, 4px below number

Right body (flex-1, layouts diverge):

**Day log row:**
- Type tag: `<book> DAY` in 10px accent letterspaced
- Prose in 14px sans, line-height 1.5
- Tag trail underneath: 11px hint, glyphs in whisper

**Restaurant row:**
- Type tag: `<kitchen> RESTAURANT` accent letterspaced
- Place name as headline in 14.5px weight 500
- Meta line ("with Mandy · steak frites, Côtes du Rhône") in 12px muted
- Note in serif Georgia italic 12.5px text-soft

**Media row:**
- Type tag: `<play> MEDIA` accent letterspaced
- Title in 14.5px weight 500
- Format pill ("Film", "Book", "TV") in 10px muted, bg-deep bg, border
- Note in serif Georgia italic 12.5px text-soft
- Rating row (if present) in 12px accent, 1px letterspaced (★★★★☆)

**Thought row:**
- Type tag: `<quote> THOUGHT` accent letterspaced
- Body entirely in serif Georgia italic 13.5px text-soft — different register signaling this is reflection, not record

**Row separators:** 0.5px hairline, last row has none.

**Tap behavior:**
- Tap row → opens entity detail (v2) or edit modal (v1 fallback — just shows the source entry's raw prose with edit/delete buttons).
- Tap entity name within a row (place name, title, tag) → entity detail (v2).

**Search icon tap:** opens search overlay covering the top half of screen, ILIKE query across `entries.raw_text`, `restaurant_visits.place_name`, `media_entries.title`, `thoughts.text`. Returns results in the same row-layout style, grouped by type.

---

## Stoic / Thoughts / Reflect screens (carryover, re-skinned)

> ⚠️ **PARTIALLY SUPERSEDED by "Navigation & Mind redesign — LOCKED 2026-05-18".** Only **Stoic** survives as a screen (swipe left) and remains the sole writer of `reflections`. **Thoughts** is replaced by Capture (write) + Mind (manage). **Reflect** is folded — no free-form reflection outside Stoic.

These carry over from Still functionally — only the palette and microcopy update.

**Stoic screen:** 3 practice types (`evening`, `morning`, `premeditatio`), 3 prompt slots each, pinned prompts from `saved_prompts` fill first. Box breathing ritual unchanged. Save as reflection with `tags: ['stoic']` and `prompt_used` = practice label. Now also writes a row to `entries` with `primary_type='reflection'`, `source_surface='stoic_screen'`.

**Thoughts screen:** open journal compose. Writes a row to `entries` (primary_type='thought', source_surface='thoughts_screen') and a row to `thoughts`. No Claude review step — Thoughts are intentionally raw.

**Reflect screen:** prompted reflection with Claude-generated prompt. Writes to `entries` + `reflections`. Existing flow preserved.

**Re-skin notes:**
- Replace `#A89880` accent with `#3D4A7A`.
- Replace `#F5F2EE` bg with `#F0EAD6`.
- Replace `#EDEBE7` card-bg with `#E8E0C8`.
- Re-render any sans serif body copy that's actually the user's voice (reflection text, thought text, stoic responses) in Georgia serif italic.
- Update all `goBack` slide directions if needed for new edge label ordering.

---

## Pattern analysis (carryover, expanded)

Existing Still `pattern` screen reads from `reflections`. Expand to read from all new tables (`day_logs`, `restaurant_visits`, `media_entries`, `thoughts`) plus existing (`habit_logs`, Oura `health_snapshots`). Claude prompt updates to surface correlations across the broader data set:

> "On days with gym + Oura readiness > 80, restaurant visits average 1.4 vs 0.3 baseline."
> "You've mentioned Mandy in 23 entries over the last 30 days, mostly tagged restaurant or media."
> "Bordelaise sauce shows up 3 times this year — Raoul's, Le Diplomate, home cook attempt March 8."

---

## Routing and navigation

> ⚠️ **Gesture/back map SUPERSEDED by "Navigation & Mind redesign — LOCKED 2026-05-18".** The `navigate/goBack/navStack` mechanics still hold; the specific gesture→screen and back-direction tables do not (Today/Compose/Reflect removed; Mind/Capture added).

`navigate(id)` pushes to `navStack`, calls `onEnter(id)`. `goBack(viaSwipeDir?)` pops. `[data-nav]` attributes wired automatically.

**Back gestures from non-home screens:** universal swipe-right from left edge (within 40px). Primary screens also accept reverse-of-entry gesture as in Still:
- Today: swipe down from top edge → back
- Stoic: swipe right from left edge → back (also universal)
- Thoughts: universal only
- Reflect: swipe up from bottom edge → back

`compose` and `compose-review` use a dedicated `×` button top-right rather than swipe back, to prevent accidental dismissal mid-write.

`journal` uses the back arrow top-left.

---

## Migration from Still

Ink replaces Still entirely. Migration path for the user (Nate) who already has Still data:

1. Existing Still tables remain — no data loss.
2. Ink ships and points to the same Supabase project.
3. First open of Ink runs a one-time migration script in JS (gated by `localStorage['ink_migrated_from_still']`):
   - For each existing `reflections` row, insert a corresponding `entries` row with `primary_type='reflection'`, `source_surface='reflect_screen'` (or `stoic_screen` if tagged stoic), set `reflections.source_entry_id` to the new entries row id.
   - No backfill needed for `day_logs`, `restaurant_visits`, `media_entries`, `thoughts` — these start empty and grow forward.
4. Old Still PWA can be uninstalled by user once Ink is installed (manual step, not automated). Still's URL `https://nates123-cmd.github.io/Still-App/` remains accessible for read-only data inspection if needed.

---

## Bulk historical import

A one-time, agent-run path for loading historical days that predate Ink — distinct from the in-app per-day "Open days" backfill (which only covers the trailing `OPEN_WINDOW`).

**Input format.** The user pastes dated blocks. Recognized line shape: `<day-of-month><day-letter>: <text>` where day-letter ∈ `Su M T W R F S` (the handwritten convention; `R`=Thu, `S`=Sat, `Su`=Sun). Blocks lack month/year — the day-letters resolve it: there is exactly one recent month whose weekday sequence fits, and consecutive blocks chain to consecutive months.

**Procedure (mandatory, in order):**
1. **Calendar-validate** every line: compute the real weekday for the inferred (year, month, day) and compare to the stated letter. 100% match is required before any write — any mismatch means the month inference is wrong; stop and re-derive.
2. **Dry-run preview**: parsed count, date range, blank-skipped list, sample rows. Get explicit user confirmation (bulk write to the shared production DB).
3. **Idempotent insert**: skip any date that already has a `day_logs` row. Per imported day write one `entries` row (`primary_type='day'`, `source_surface='today_screen'`, `composed_at` = that date at noon UTC) and one linked `day_logs` row (`date` = that date) via `source_entry_id`. Preserve text verbatim (mind apostrophes — never run user text through a shell-quoted command; use a script file).
4. Blank entries are skipped (no row) and remain visible as Open days.
5. **Verify**: re-query the range, confirm count and spot-check text fidelity + linkage.

First run (2026-05-16): imported Apr 2–30 + May 1–7 2026, 35 rows, 3 blanks skipped (Apr 1, Apr 20, May 8), 38/38 calendar-validated.

---

## Carried-over fixes from Still (captured 2026-05-15)

Four defects observed in live Still use. Decision: **do not patch deprecated Still — Ink must ship without these.** Each is logged with its Still root cause so Ink doesn't reintroduce it.

### F1 — iOS standalone dark band at the bottom of the screen

**Still root cause:** `applyTheme()` force-switches the app into a dark palette (`html.dark`, `--bg: #1A1714`) on a clock (`hour < 6 || hour >= 20`) and rewrites `<meta name="theme-color">` to match. But on iOS standalone with `viewport-fit=cover`, the `safe-area-inset-bottom` strip (home-indicator region) is painted from the **static** `manifest.json` `background_color` (`#F5F2EE`), which cannot change at runtime. Every evening — exactly when a reflection app is opened — the dark canvas meets a light manifest-painted strip, read as a "dark space" mismatch.

**Ink requirement:**
- Ship **one** palette (aged paper). No clock-based or `prefers-color-scheme` runtime background swap. The manifest can't follow a runtime swap, so don't have one.
- `html, body { background: var(--bg); }` and the lowest content gets `padding-bottom: env(safe-area-inset-bottom)`.
- `manifest.json` `background_color` + `theme_color` and `<meta name="theme-color">` all `#F0EAD6`, set once, never rewritten in JS.
- This supersedes the runtime-`theme-color` behavior; see "iOS PWA manifest discipline" above.

### F2 — Morning-intention answer must surface on home, not just a regenerated question

**Still root cause:** `refreshCanvasIntention()` renders only `blurb.line` — a Claude-generated *question*. The user's actual morning-intention answer is sent to Claude but never shown back.

**Ink requirement:** the home content slot's morning-intention check-in renders **two** parts: (1) the retrospective check-in line ("How has temperance shown up?"), and (2) a short Claude-condensed highlight of what the user actually wrote that morning. Both come from one cached blurb object (see F4 cache shape).

### F3 — Prompt regeneration fails opaquely

**Still root cause:** `handlePromptAction(... 'regenerate')` wraps the whole path in one `try/catch` that collapses every failure — missing API key, network, parse — into a single `showToast('Regenerate failed')`. The dominant real cause is no/invalid API key (`callClaude` throws "No API key"), with no path to settings.

**Ink requirement:** every Claude-backed action (prompt regen, intention blurb, compose review, Today extraction) must (1) check `getApiKey()` first and, if absent, route to the API-key screen with an explicit message rather than fail silently; (2) surface the real error text in the toast (`'Regenerate failed — ' + e.message`), not a generic string.

### F4 — A highlight from the morning-intention entry must be visible

**Still root cause:** `generateIntentionBlurb()` extracts an `intention` phrase into the cached blurb but nothing ever displays it.

**Ink requirement:** persist and display it. Blurb cache shape becomes `{ reflection_id, intention, highlight, line }` where `highlight` is a short verbatim-ish pull from the entry. Surfaced on home (under the check-in line, F2) and on the Reflections row layout in Journal (the italic note slot already exists in the journal mock — reuse it).

---

## Captured fixes & ideas (2026-05-18)

Second batch from live use. Bugs B1–B4 are v1 requirements; Idea I1 is Roadmap-only.

### B1 — Cmd/Ctrl+Enter submits the active entry surface

Desktop has no fast submit; tapping the button is the only path. Requirement: `⌘`/`Ctrl`+`Enter` triggers the primary commit on whatever entry surface is focused — compose write → Review, compose-review → File, Today day-log → save, Thoughts → save, Reflect → save, Stoic → save, and the day backfill sheet → Save day. One global keydown handler keyed off the active screen / open modal. Plain Enter still inserts newlines (these are prose fields).

### B2 — Respond to each prompt individually (Stoic)

The Stoic screen shows three prompts but only one shared answer box, and save persists only prompt #1's text (`A:` blank for the rest) — a scaffold shortcut, now a defect. Requirement: render a response textarea under **each** prompt. Saved `reflections.text` is the Q/A pairs for **answered** prompts only (skip blanks); still one `entries` row (`source_surface='stoic_screen'`), `prompt_used` = practice label, `tags:['stoic']`. Reflect (single prompt) is unaffected.

### B3 — Home control on the compose screens

Compose and compose-review only offer `×` (step-back). From a multi-step filing flow the user wants a direct exit to home. Requirement: add a home affordance to both top bars alongside `×`; it clears `navStack` and returns to `home` (no accidental-dismissal concern since it's an explicit, labeled control distinct from the canvas). `×` keeps its current step-back/return-to-compose behavior.

### B4 — Mass-add restaurants & media + a share file

Two parts:
- **Mass add:** extend the agent-run "Bulk historical import" procedure to `restaurant_visits` and `media_entries` (user pastes lists; dry-run → confirm → idempotent; each row gets a linked `entries` row, `source_surface='unified_plus'`, `primary_type='restaurant'|'media'`). Idempotency key: restaurant = (place_name, visit_date) where dated else place_name; media = (title, format).
- **Share file:** Settings → **Export** downloads a single file of all records (`entries`, `day_logs`, `restaurant_visits`, `media_entries`, `thoughts`, `reflections`) — JSON for re-import/backup plus a readable Markdown rendering. Client-side `Blob` download, no server. The agent can also produce this file on request.

### I1 — Send a Thought to Course → PROMOTED TO v1 (2026-05-18)

No longer speculative. Resolved into the **Push to Course** action in §"Navigation & Mind redesign — LOCKED 2026-05-18": every Mind row (Thought/Insight/Mantra) can push to Course's existing **`course_captures`** inbox (same shared Supabase project) with a Task/Project/Note hint. Plain insert, no Course-side work, no Notion dependency. See that section for the contract.

---

## Patch suite integration

Patch's app pills currently include Still. After this redesign, the pill renames to `Ink` and the legacy fixes inbox carries over. No data migration needed for Patch — it doesn't read from the apps it tracks.

---

## Other suite integrations (unchanged)

- **Course → Ink:** Friday Close question 3 can push to Ink as a Reflection. Same target table (`reflections`).
- **Course ← Ink:** Morning Pulse can read recent `day_logs` and `reflections` for context.
- **Tide → Ink:** Drinks morning-after reflections push to Ink as Reflection.
- **Ink ← Oura:** Pattern screen reads `health_snapshots` for correlation surfacing.

---

## Roadmap (post-v1)

**v1 ships:**
- All screens above
- Two write doors + one read surface
- Multi-record write model
- Live tag extraction on Today screen
- Compose review with type chooser
- Journal with filter chips
- Migration from Still
- All Still carryover features (Stoic, Reflect, Insights, Challenges, Habits-manage, Prompt-library, Pattern)

**v2:**
- Entity detail screens (`/entity/restaurant/raoul-s`, `/entity/media/conclave`, `/entity/person/mandy`). Tap any entity in journal → see all entries referencing it, plus aggregate stats (visit count, last visited, who you usually go with, dishes you've had).
- Monthly view — calendar grid scrubbable, each day rendered as a small glyph showing entry types present.
- Yearly retrospective — Claude-generated end-of-year summary across all tables.
- Voice entry on the Today screen (Web Speech API → prose textarea, then standard extraction flow).

**v3 (speculative):**
- Cross-app entity drilling. Tap "Raoul's" in Ink → see Tide's drinks data for that date, see Course's tasks completed that week, see Tick's focus sessions that day.
- Photo attachment per entry (Supabase Storage).
- ~~Send a Thought → Course project intake (Idea I1)~~ — **promoted to v1**, see §"Navigation & Mind redesign — LOCKED 2026-05-18".

---

## CSS design tokens (recap)

```css
--bg:           #F0EAD6
--bg-deep:      #E6DFC6
--text:         #2A2418
--text-soft:    #3D362A
--muted:        #6B5F4A
--hint:         #8A7D62
--whisper:      #A89976
--accent:       #3D4A7A
--accent-soft:  #7A85AB
--accent-faint: #C7CCDF
--card-bg:      #E8E0C8
--border:       #D6CCAE
--hairline:     #E2D9BE
--radius:       14px
```

Same design grammar as the rest of the suite: single column, generous gutters, bold app name top-left + minimal utility top-right, large rounded cards, sans for chrome, serif for voice.

---

## Deploy workflow

1. Build `index.html`, `sw.js`, `manifest.json`, `CLAUDE.md`, `ink-spec.md` in fresh repo `nates123-cmd/Ink`.
2. Bump `CACHE_NAME` version in `sw.js` whenever deploying (`ink-v1`, `ink-v2`, ...).
3. GitHub Pages enabled on `main` branch root.
4. `git add . && git commit -m "..." && git push`.
5. Deploys within ~1 minute.

---

## Open questions / decisions to revisit

- **Roman numeral year on home.** Currently MMXXVI. Setting toggleable in v1.1 if it grates over time.
- **Append vs separate-entry default.** Currently appends. May want to flip if the user finds the appended day-log line grows too unwieldy mid-day.
- **Rating field on media.** Currently optional, nullable. Could be promoted to required if media tracking becomes a primary use case. Decide after 30 days of use.
- **Entity-detail screen design.** Reserved for v2 — not blocking v1 ship.
- **Voice entry.** Reserved for v2.

---

*Last updated: May 18, 2026 — Navigation & Mind redesign shipped live (`ink-v3`). Drafted in conversation with Claude. Successor to Still — replaces Still entirely.*
