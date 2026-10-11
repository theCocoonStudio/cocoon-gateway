// Every credential is read from the environment of this process at start (DigitalOcean's secrets),
// never from disk, never from the container. Each kind returns the headers to inject upstream.
import { createSign } from 'node:crypto';

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`credentials: ${name} is not set`);
  return v;
};
const pem = (name) => need(name).replace(/\\n/g, '\n'); // a PEM pasted into an env var carries \n

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
    const body = await res.json();
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return cached.token;
  };
}

export function fromEnvironment() {
  const github = githubAppTokenSource({
    appId: need('GITHUB_APP_ID'),
    installationId: need('GITHUB_APP_INSTALLATION_ID'),
    privateKey: pem('GITHUB_APP_PRIVATE_KEY'),
  });
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!anthropicKey && !anthropicToken) throw new Error('credentials: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is not set');
  return {
    async headersFor(kind) {
      switch (kind) {
        case null:
        case undefined:
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
