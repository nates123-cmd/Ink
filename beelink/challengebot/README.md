# challengebot — Telegram reminders for Ink challenges

Runs on the Beelink. Reads the same `challenges_today` view Ink, Today, Break
and the reMarkable brief read, and writes the same `challenge_logs` row all of
them write. Nothing here re-derives "is it due", "what day are we on" or
"what's the streak" — the view already answered all three.

## Install

    scp challengebot.py             nate@beelink:~/apps/challengebot/
    scp ink-challenge-*.service \
        ink-challenge-*.timer      nate@beelink:~/.config/systemd/user/
    ssh nate@beelink 'systemctl --user daemon-reload && \
      systemctl --user enable --now ink-challenge-morning.timer \
                                   ink-challenge-timed.timer \
                                   ink-challenge-evening.timer'

`challengebot.env` (mode 600, never committed) holds:

    TG_BOT_TOKEN, TG_CHAT_ID, TG_DEDICATED
    SUPABASE_URL, SUPABASE_SERVICE_KEY
    INK_USER_ID, INK_URL
    PUSH_SEND_SECRET

## Two channels, one nudge

Every reminder goes out over Telegram **and** Web Push. They fail
independently on purpose: if one channel dies the other still lands, so quiet
always means "nothing owed" rather than "something broke". A push failure is
logged and swallowed — it never stops the Telegram message.

Push goes through the `push-send` edge function, gated by `PUSH_SEND_SECRET`
rather than the service role key. Supabase injects `SUPABASE_SERVICE_ROLE_KEY`
in whichever format the project currently uses, which is not necessarily the
legacy JWT a caller holds; comparing against it fails closed in a way that
looks exactly like a bug. A dedicated secret has no such ambiguity and
survives a key rotation.

Devices register themselves from Ink's Settings screen. Until at least one
does, `push-send` returns `{"sent":0,"note":"no subscriptions"}`, which is the
expected steady state, not an error.

## Schedule

User-level systemd timers, not cron. The Beelink runs UTC, so a bare cron line
would drift an hour at each DST shift; `OnCalendar=... America/New_York` does
not. `Linger=yes` is already set for the `nate` user, so no root is involved.

| Unit                          | Fires            | Says |
|-------------------------------|------------------|------|
| `ink-challenge-morning.timer` | 07:00 ET         | Owed today, and with **no** time of its own |
| `ink-challenge-timed.timer`   | every 15min ET   | Challenges whose `remind_at` just came round |
| `ink-challenge-evening.timer` | 20:00 ET         | Everything *still* owed, timed or not |
| `ink-challenge-poll.service`  | continuous       | Handles Done taps — **disabled**, see below |

Every reminder is silent when nothing is owed. A rest day on a `weekdays`
challenge, or a `weekly_count` challenge that already hit its target, produces
no message at all — that is what `due_today` is for.

Dry-run without sending:

    python3 challengebot.py morning --dry
    python3 challengebot.py timed --dry
    python3 challengebot.py evening --dry

## Time of day

`active_challenges.remind_at` is a local wall-clock time, nullable. Blank —
which is every pre-2026-08-03 row — means "no particular time" and keeps the
old behaviour exactly: 7am, then 8pm if still open. Set one and the nudge
*moves* to that hour rather than doubling up: `morning` skips any challenge
with a time, and `timed` picks it up instead.

`timed` fires for a challenge whose time fell inside the window that just
elapsed, so **`CHALLENGE_WINDOW_MIN` (default 15) must match the timer's
period**. Change one without the other and reminders fall between two runs and
never fire. Catch-up runs are off on purpose (`Persistent=false`); already-sent
keys live in `state.json` and are pruned to the current local day.

## LANDMINE — the shared bot token

`rainalert.env`'s `TG_BOT_TOKEN` is the **same bot as OpenClaw**
(@Nate_beelink_bot), and OpenClaw long-polls it from rootless Docker. Telegram
hands each update to exactly one `getUpdates` caller, so a second poller
silently steals OpenClaw's messages — OpenClaw would just start missing
replies, with nothing in either log to explain it.

Sending on that token is completely safe. Only receiving conflicts.

So: `poll` refuses to run unless `TG_DEDICATED=1`, and while it is unset the
nudge carries a deep link into Ink (`?screen=challenges`) instead of an inline
Done button. To turn the buttons on:

1. BotFather → `/newbot` → new token.
2. `/start` the new bot so it may message you (`TG_CHAT_ID` stays the same).
3. Put the new token in `challengebot.env`, set `TG_DEDICATED=1`.
4. `systemctl --user enable --now ink-challenge-poll.service`

## LANDMINE — service_role sees everyone

`challenges_today` is `security_invoker`, so it runs with the caller's RLS. The
service key **bypasses RLS entirely** and therefore sees every user's
challenges. The `user_id=eq.` filter in `live_challenges()` is load-bearing —
drop it and the reminders start including other people's rows.

## LANDMINE — never use the Beelink's clock for "today"

The box runs UTC. A Done tap at 9pm ET is 01:00 UTC the next day, so a
`date.today()` here would tick the wrong day. Every write uses `today_local`
straight off the view, which is pinned to America/New_York by `ink_today()`.
