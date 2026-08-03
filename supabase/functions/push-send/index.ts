// push-send — deliver a Web Push notification to every device a user has
// registered in `push_subscriptions`.
//
// Called by the Beelink's challengebot alongside the Telegram nudge, so the
// same reminder arrives on whichever surface Nate happens to be looking at.
// The two are deliberately independent: if push fails, Telegram still lands.
//
// AUTH: a dedicated shared secret, PUSH_SEND_SECRET, in the Authorization
// header. This function can message a user's phone, so it is never exposed to
// an anon or user JWT. It deliberately does NOT compare against the service
// role key: Supabase injects SUPABASE_SERVICE_ROLE_KEY in whichever format the
// project currently uses, which is not necessarily the legacy JWT a caller
// holds, and that mismatch fails closed in a way that looks like a bug. Deploy
// with --no-verify-jwt so this check is the only gate.
//
// DEAD SUBSCRIPTIONS: a push service answers 404 or 410 when a device has
// uninstalled or revoked. Those rows are deleted on the spot; anything else is
// reported but left alone, since a 500 from the push service is not evidence
// that the device is gone.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SEND_SECRET = Deno.env.get('PUSH_SEND_SECRET') ?? '';
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:nates123@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// Length-independent comparison, so a wrong key can't be probed byte by byte.
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return json({ error: 'VAPID keys are not configured' }, 500);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'bad JSON' }, 400);
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_KEY);

  // Two callers, two very different privileges.
  let userId: string;
  if (SEND_SECRET && sameSecret(token, SEND_SECRET)) {
    // The Beelink. Trusted, so it may name whose devices to reach.
    userId = String(payload.user_id ?? '');
    if (!userId) return json({ error: 'user_id is required' }, 400);
  } else {
    // A signed-in user, from Ink itself. They may only ever reach their OWN
    // devices: the id comes from the verified JWT and any user_id in the body
    // is ignored rather than honoured. That is the entire boundary — without
    // it, one user's token would be able to push to anyone.
    const { data, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !data?.user) return json({ error: 'forbidden' }, 403);
    userId = data.user.id;
  }

  const { data: subs, error } = await sb
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (error) return json({ error: error.message }, 500);
  if (!subs?.length) return json({ sent: 0, note: 'no subscriptions' });

  const body = JSON.stringify({
    title: payload.title ?? 'Ink',
    body: payload.body ?? '',
    url: payload.url ?? './?screen=challenges',
    tag: payload.tag ?? 'ink-challenge',
  });

  let sent = 0;
  const gone: string[] = [];
  const failed: Array<{ id: string; status?: number; message: string }> = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 6 * 60 * 60 },   // a morning nudge is worthless by evening
      );
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(s.id);
      else failed.push({ id: s.id, status, message: String((e as Error).message ?? e) });
    }
  }));

  if (gone.length) await sb.from('push_subscriptions').delete().in('id', gone);
  if (sent) {
    await sb.from('push_subscriptions')
      .update({ last_ok_at: new Date().toISOString() })
      .eq('user_id', userId);
  }

  return json({ sent, pruned: gone.length, failed });
});
