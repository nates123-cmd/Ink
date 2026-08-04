#!/usr/bin/env python3
"""Challenge reminders over Telegram, for the Beelink.

Reads the same `challenges_today` view Ink, Today, Break and the reMarkable
brief read, and writes the same `challenge_logs` row every one of them writes.
Nothing here re-derives "is it due", "what day are we on" or "what's the
streak" — the view already answered all three.

Four modes, all driven by systemd timers:

    challengebot.py morning   # 7am ET  — owed today, and with NO time of its own
    challengebot.py timed     # every 15min — challenges whose remind_at just hit
    challengebot.py evening   # 8pm ET  — everything still owed
    challengebot.py poll      # every minute — handle Done button taps

A challenge with a `remind_at` is nudged at its own hour and deliberately left
out of the 7am sweep, so setting a time moves the reminder rather than adding a
second one. The 8pm sweep still catches everything, timed or not — by then the
day is nearly over and a missed 2pm walk is exactly what wants saying.

LANDMINE — the shared bot token. rainalert.env's TG_BOT_TOKEN is the SAME bot
as OpenClaw (@Nate_beelink_bot), and OpenClaw long-polls it from rootless
Docker. Telegram hands each update to exactly one getUpdates caller, so a
second poller silently steals OpenClaw's messages. SENDING on that token is
harmless; RECEIVING is not. So `poll` refuses to run unless TG_BOT_TOKEN is a
dedicated token (TG_DEDICATED=1), and without one the nudge falls back to a
deep link into Ink instead of an inline button. Get a fresh token from
BotFather, /start it, set TG_DEDICATED=1, and the buttons light up.

LANDMINE — service_role and the view. `challenges_today` is security_invoker,
so it runs with the caller's RLS. The service key bypasses RLS entirely, which
means it sees EVERY user's challenges — hence the explicit user_id filter
below. Drop that filter and Nate gets reminded about other people's walks.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

# The suite's timezone, the same one ink_today() pins the view to. The box runs
# UTC — see the LANDMINE about never using its clock for "today".
ET = ZoneInfo("America/New_York")

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state.json")


def load_env():
    """Read challengebot.env, falling back to the process environment."""
    env = {}
    path = os.path.join(HERE, "challengebot.env")
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    for k in ("TG_BOT_TOKEN", "TG_CHAT_ID", "SUPABASE_URL", "SUPABASE_SERVICE_KEY",
              "INK_USER_ID", "INK_URL", "TG_DEDICATED", "PUSH_SEND_SECRET",
              "CHALLENGE_WINDOW_MIN"):
        env.setdefault(k, os.environ.get(k, ""))
    return env


ENV = load_env()
API = "https://api.telegram.org/bot%s/" % ENV["TG_BOT_TOKEN"]
DEDICATED = ENV.get("TG_DEDICATED", "").strip() in ("1", "true", "yes")


def req(url, data=None, headers=None, method=None):
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers = dict(headers or {})
        headers.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    with urllib.request.urlopen(r, timeout=30) as resp:
        raw = resp.read().decode()
    return json.loads(raw) if raw.strip() else None


# ── Supabase ────────────────────────────────────────────────────────────────

def sb(path, data=None, method=None):
    key = ENV["SUPABASE_SERVICE_KEY"]
    return req(ENV["SUPABASE_URL"].rstrip("/") + "/rest/v1/" + path, data,
               {"apikey": key, "Authorization": "Bearer " + key,
                "Prefer": "return=minimal"}, method)


def live_challenges():
    """Everything running, newest-started last. Filtered to one owner on purpose."""
    return sb("challenges_today?user_id=eq.%s&order=start_date.asc" % ENV["INK_USER_ID"]) or []


def log_day(challenge_id, date):
    """Same idempotent row every other surface writes. 409 = already ticked."""
    try:
        sb("challenge_logs", {"active_challenge_id": challenge_id, "date": date,
                              "user_id": ENV["INK_USER_ID"]}, "POST")
        return True
    except urllib.error.HTTPError as e:
        return e.code == 409


# ── Telegram ────────────────────────────────────────────────────────────────

def send(text, buttons=None):
    payload = {"chat_id": ENV["TG_CHAT_ID"], "text": text,
               "parse_mode": "HTML", "disable_web_page_preview": True}
    if buttons:
        payload["reply_markup"] = {"inline_keyboard": buttons}
    return req(API + "sendMessage", payload)


def answer(callback_id, text):
    try:
        req(API + "answerCallbackQuery", {"callback_query_id": callback_id, "text": text})
    except urllib.error.HTTPError:
        pass


def edit(chat_id, message_id, text):
    try:
        req(API + "editMessageText", {"chat_id": chat_id, "message_id": message_id,
                                      "text": text, "parse_mode": "HTML"})
    except urllib.error.HTTPError:
        pass


# ── The nudge ───────────────────────────────────────────────────────────────

def minute_of_day(t):
    """"07:00:00" → 420. None for a challenge with no time of its own."""
    m = str(t or "").split(":")
    try:
        return int(m[0]) * 60 + int(m[1])
    except (IndexError, ValueError):
        return None


def clock(t):
    """07:00:00 → 7:00 AM. Empty string when there is no time."""
    mins = minute_of_day(t)
    if mins is None:
        return ""
    h, m = divmod(mins, 60)
    return "%d:%02d %s" % (h % 12 or 12, m, "AM" if h < 12 else "PM")


def line(c):
    """One challenge, described the way the card describes it."""
    if c["cadence"] == "weekly_count":
        target = c.get("week_target") or 1
        head = "%s — %d of %d this week" % (c["title"], c["week_done"], target)
    else:
        head = "%s — day %d" % (c["title"], c["day_number"])
        if c.get("days"):
            head += " of %d" % c["days"]
    if c.get("streak"):
        head += " · %d %s streak" % (
            c["streak"], "week" if c["cadence"] == "weekly_count" else "day")
    at = clock(c.get("remind_at"))
    if at:
        head += " · %s" % at
    return head


def owed_now():
    """Everything running, due today and not yet ticked."""
    return [c for c in live_challenges() if c["due_today"] and not c["done_today"]]


def remind(when, dry=False):
    owed = owed_now()
    # A challenge with a time of its own gets nudged at that time instead, so
    # the morning sweep would only be a duplicate. Evening still says everything.
    if when == "morning":
        owed = [c for c in owed if minute_of_day(c.get("remind_at")) is None]
    if not owed:
        # Nothing owed, or already done, or every one of them is on a rest day.
        # Silence is the correct output — that is what due_today is for.
        if dry:
            print("(nothing owed — no message would be sent)")
        return

    head = "Still open tonight" if when == "evening" else (
        "Today's challenges" if len(owed) > 1 else "Today's challenge")
    announce(head, owed, dry)


def announce(head, owed, dry=False):
    body = [head, ""]
    buttons = []
    for c in owed:
        body.append("• " + line(c))
        if DEDICATED:
            # callback_data is capped at 64 bytes; "d|<uuid>" is 38.
            buttons.append([{"text": "✓ " + c["title"],
                             "callback_data": "d|" + c["id"]}])

    if not DEDICATED:
        url = (ENV.get("INK_URL") or "https://nates123-cmd.github.io/Ink/") + "?screen=challenges"
        buttons = [[{"text": "Open Ink", "url": url}]]

    # Push and Telegram carry the same nudge and fail independently — if one
    # channel is dead, the other still lands, so quiet always means "nothing
    # owed" rather than "something broke".
    push_title = head
    push_body = "\n".join(line(c) for c in owed)

    if dry:
        print("\n".join(body))
        print("buttons: " + json.dumps(buttons))
        print("push: %s / %s" % (push_title, push_body.replace("\n", " | ")))
        return

    send("\n".join(body), buttons)
    push(push_title, push_body)


def timed(dry=False, window=15):
    """Nudge each challenge at its own remind_at.

    Fires for a challenge whose time fell inside the window that just elapsed,
    so `window` has to match how often the timer runs. Late catch-up runs are
    deliberately off (Persistent=false): a reminder for 7am delivered at noon
    because the box was asleep is noise, and the 8pm sweep catches it anyway.

    The sent keys are the second guard. A timer that fires twice inside one
    window — a manual run, a daemon-reload — would otherwise say it twice.
    """
    now = datetime.now(ET)
    mins = now.hour * 60 + now.minute
    state = read_state()
    sent = dict(state.get("sent") or {})

    due = []
    for c in owed_now():
        at = minute_of_day(c.get("remind_at"))
        if at is None or not (0 <= mins - at < window):
            continue
        key = "%s|%s" % (c["id"], c["today_local"])
        if key not in sent:
            due.append((key, c))

    if not due:
        if dry:
            print("(nothing due at %s — no message would be sent)" % now.strftime("%H:%M"))
        return

    announce("Challenge time", [c for _, c in due], dry)
    if dry:
        return
    # Only today's keys are worth keeping; yesterday's are dead weight and the
    # date suffix is what makes tomorrow's nudge fire again.
    td = due[0][1]["today_local"]
    for key, _ in due:
        sent[key] = True
    state["sent"] = {k: v for k, v in sent.items() if k.endswith("|" + td)}
    write_state(state)


def push(title, body):
    """Best-effort Web Push. Never let a push failure kill the Telegram nudge."""
    url = ENV["SUPABASE_URL"].rstrip("/") + "/functions/v1/push-send"
    key = ENV.get("PUSH_SEND_SECRET", "")
    if not key:
        return
    try:
        req(url, {"user_id": ENV["INK_USER_ID"], "title": title, "body": body,
                  "url": (ENV.get("INK_URL") or "") + "?screen=challenges",
                  "tag": "ink-challenge"},
            {"Authorization": "Bearer " + key})
    except Exception as e:
        print("%s push failed: %s" % (datetime.now().isoformat(timespec="seconds"), e),
              file=sys.stderr)


# ── Button taps ─────────────────────────────────────────────────────────────

def read_state():
    try:
        with open(STATE) as fh:
            return json.load(fh)
    except Exception:
        return {}


def write_state(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(s, fh)
    os.replace(tmp, STATE)


def poll():
    if not DEDICATED:
        # Refusing here is the whole point — see the LANDMINE at the top.
        print("poll: TG_DEDICATED is not set; refusing to getUpdates on the "
              "bot OpenClaw already polls.", file=sys.stderr)
        return 1

    state = read_state()
    params = {"timeout": 25, "allowed_updates": json.dumps(["callback_query"])}
    if state.get("offset"):
        params["offset"] = state["offset"]
    try:
        res = req(API + "getUpdates?" + urllib.parse.urlencode(params))
    except (urllib.error.URLError, TimeoutError):
        return 0

    for upd in (res or {}).get("result", []):
        state["offset"] = upd["update_id"] + 1
        cq = upd.get("callback_query")
        if not cq or not str(cq.get("data", "")).startswith("d|"):
            continue
        cid = cq["data"][2:]
        # The view is the authority on what "today" is — never the Beelink's
        # clock, which runs UTC and would tick the wrong day after 8pm ET.
        match = next((c for c in live_challenges() if c["id"] == cid), None)
        if not match:
            answer(cq["id"], "That challenge is no longer running.")
            continue
        if match["done_today"]:
            answer(cq["id"], "Already ticked today.")
        elif log_day(cid, match["today_local"]):
            answer(cq["id"], "Done — %s" % match["title"])
            msg = cq.get("message") or {}
            if msg.get("message_id"):
                edit(msg["chat"]["id"], msg["message_id"],
                     "✓ %s — ticked for %s" % (match["title"], match["today_local"]))
        else:
            answer(cq["id"], "Couldn't save that one.")

    write_state(state)
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    dry = "--dry" in args
    args = [a for a in args if a != "--dry"]
    mode = args[0] if args else "morning"
    if mode == "poll":
        sys.exit(poll())
    elif mode == "timed":
        timed(dry, int(ENV.get("CHALLENGE_WINDOW_MIN") or 15))
    elif mode in ("morning", "evening"):
        remind(mode, dry)
    else:
        print("usage: challengebot.py [morning|timed|evening|poll] [--dry]", file=sys.stderr)
        sys.exit(2)
