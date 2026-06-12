// Minimal Web Push sender: payload-free pushes authorized with a VAPID JWT
// (ES256). No payload means no RFC 8291 encryption is needed — the service
// worker shows a fixed reminder message.

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const encodeJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/**
 * Send one (payload-free) push. Returns 'sent', 'gone' (subscription expired,
 * caller should delete it), 'skipped' (VAPID not configured), or 'error'.
 */
export async function sendPush(env, subscriptionJson) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.log('[push skipped — VAPID keys not set]');
    return 'skipped';
  }
  let sub;
  try {
    sub = JSON.parse(subscriptionJson);
    if (!sub?.endpoint) throw new Error('no endpoint');
  } catch {
    return 'gone';
  }

  const signingInput =
    encodeJson({ typ: 'JWT', alg: 'ES256' }) + '.' +
    encodeJson({
      aud: new URL(sub.endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT || 'mailto:family-leaderboard@example.com',
    });
  const key = await crypto.subtle.importKey(
    'pkcs8', b64urlDecode(env.VAPID_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'normal',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) {
    console.error(`Push error ${res.status}: ${await res.text()}`);
    return 'error';
  }
  return 'sent';
}
