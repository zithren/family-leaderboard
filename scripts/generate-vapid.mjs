// Generate a VAPID keypair for Web Push. Run once:  npm run vapid
// Put the output in .dev.vars (local) and in Worker secrets (production):
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_KEY

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
);
const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);

console.log('VAPID_PUBLIC_KEY=' + b64url(pub));
console.log('VAPID_PRIVATE_KEY=' + b64url(priv));
