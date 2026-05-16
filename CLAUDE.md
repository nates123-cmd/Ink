# Ink — CLAUDE.md

Short brief for Claude Code. Full spec is in `ink-spec.md` — read that next.

## What this app is

A personal record system. Successor to Still. Same Supabase project, single-file PWA on GitHub Pages.

You write prose. Claude reads it, picks the type (day log / restaurant / media / thought / reflection), extracts entities, files structured records. The user retrospects through a filtered journal timeline.

## Live URL (target)

`https://nates123-cmd.github.io/Ink/`

## Stack

- Single-file `index.html` (HTML + CSS + JS, no build step)
- `sw.js` service worker — cache name `ink-vN`, bump on deploy
- `manifest.json` PWA manifest — `background_color` and `theme_color` MUST match `#F0EAD6`
- Direct browser fetch to Anthropic API, model `claude-sonnet-4-7`, header `anthropic-dangerous-direct-browser-access: true`
- Supabase REST (no SDK), anon key, same project as Still / Break / Tide
- `dev-config.js` is gitignored — sets `localStorage.anthropic_api_key` for local dev

## Palette

```css
--bg:           #F0EAD6   /* aged paper */
--accent:       #3D4A7A   /* faded indigo */
--text:         #2A2418
--muted:        #6B5F4A
--card-bg:      #E8E0C8
--border:       #D6CCAE
```

Sans for chrome, Georgia serif for the user's voice and the Ink. wordmark.

## Where to start

1. Read `ink-spec.md` in full.
2. Run the new-table SQL block from the spec in the Supabase SQL Editor.
3. Scaffold `index.html` with screen routing in place (`home`, `today`, `compose`, `compose-review`, `journal`, `stoic`, `thoughts`, `reflect`).
4. Build the home screen first (it's the entry point and locks the visual language). The compose `+` flow is second priority — it's the new architecture. Today screen is third.
5. Carryover screens from Still (stoic, reflect, insights, challenges, habits-manage, prompt-library, pattern) can be ported and re-skinned in a later pass.

## Architecture in one line

Every write creates one `entries` row + one or more type-specific records (`day_logs`, `restaurant_visits`, `media_entries`, `thoughts`, `reflections`) linked via `source_entry_id`.

## Two write doors

- Swipe up from home → Today screen → day log card (always-on writeable surface, type implicit)
- Tap `+` top-right on home → Compose → Review → File (type picked by Claude, user confirms)

## One read surface

- Long-press home canvas → Journal screen with filter chips (`All / Days / Restaurants / Media / Thoughts / Reflections`)

## Don't do

- Don't migrate Still's data destructively — the Still PWA stays accessible at its existing URL.
- Don't add a build step. Edit and refresh, every time.
- Don't introduce new color tokens outside the palette above without flagging.
- Don't break the iOS PWA safe-area behavior — manifest `background_color` must match `--bg`.
