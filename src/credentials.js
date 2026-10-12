// Every credential is read at start from the environment of this process or from a file it names (the
// platform's secrets or files mounted read-only; src/env.js), never from the container. Each kind returns
// the headers to inject upstream; `passthrough` injects nothing and lets the client's own credential through
// (the owner's subscription login for the model, which the container holds and the gateway does not).
import { createSign } from 'node:crypto';
import { secret } from './env.js';

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// A GitHub App JWT (RS256, 10 minutes, issued 60 s in the past for clock skew), as run.sh minted it with openssl.
export function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

// The installation token, minted on demand and cached until five minutes before it expires.
export function githubAppTokenSource({ appId, installationId, privateKey, fetchImpl = fetch, api = 'https://api.github.com' }) {
  let cached = null; // { token, expiresAt: ms }
  return async function token() {
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
    const res = await fetchImpl(`${api}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appJwt(appId, privateKey)}`, accept: 'application/vnd.github+json', 'user-agent': 'cocoon-gateway' },
    });
    if (!res.ok) throw new Error(`credentials: installation token: HTTP ${res.status}`);
    // The 200 is not trusted to carry the fields: a token that is not a non-empty string, or an expires_at
    // that is not a date, is an error here, never a cached `undefined` sent upstream as `token undefined`.
    const body = await res.json();
    if (typeof body?.token !== 'string' || body.token.length === 0) throw new Error('credentials: installation token: the response carried no token string');
    const expiresAt = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAt)) throw new Error('credentials: installation token: the response carried no expires_at date');
    cached = { token: body.token, expiresAt };
    return cached.token;
  };
}

// Only the kinds the upstreams table uses must be configured, checked once at start.
export function fromEnvironment(upstreams = { upstreams: {} }) {
  const kinds = new Set(Object.values(upstreams.upstreams).map((u) => u.credential).filter(Boolean));
  const github = kinds.has('github_app') || kinds.has('github_app_basic')
    ? githubAppTokenSource({
        appId: secret('GITHUB_APP_ID', { required: true }),
        installationId: secret('GITHUB_APP_INSTALLATION_ID', { required: true }),
        privateKey: secret('GITHUB_APP_PRIVATE_KEY', { required: true }),
      })
    : null;
  const anthropicKey = secret('ANTHROPIC_API_KEY');
  const anthropicToken = secret('ANTHROPIC_AUTH_TOKEN');
  if (kinds.has('anthropic') && !anthropicKey && !anthropicToken) throw new Error('credentials: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is not set');
  return {
    async headersFor(kind) {
      switch (kind) {
        case null:
        case undefined:
        case 'passthrough':
          return {};
        case 'github_app':
          return { authorization: `Bearer ${await github()}` };
        case 'github_app_basic':
          return { authorization: `Basic ${Buffer.from(`x-access-token:${await github()}`).toString('base64')}` };
        case 'anthropic':
          return anthropicKey ? { 'x-api-key': anthropicKey } : { authorization: `Bearer ${anthropicToken}` };
        default:
          throw new Error(`credentials: unknown kind ${kind}`);
      }
    },
  };
}
