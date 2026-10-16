// Every credential is read at start from the environment of this process or from a file it names (the
// platform's secrets or files mounted read-only; src/env.js), never from the container. Each kind returns
// the headers to inject upstream; `passthrough` injects nothing and lets the client's own credential through
// (the owner's subscription login for the model, which the container holds and the gateway does not).
//
// A role is an identity, not only an access set. Each role with a rule on a GitHub upstream holds its own App
// here, read from GITHUB_APP_<ROLE>_ID, GITHUB_APP_<ROLE>_INSTALLATION_ID and GITHUB_APP_<ROLE>_PRIVATE_KEY (or
// the file it names), and the token injected is the asking role's. Until 2026-10-16 one App served every role:
// the policy decided access per role and the gateway then acted as one identity, so a gemini container's GitHub
// calls were made as the claude App's bot (the owner saw it in the container's start output and the CLI's).
// A role with GitHub rules and no App of its own refuses the start, by the variable's name.
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

// Only the kinds the upstreams table uses must be configured, and only for the roles whose rules reach them,
// checked once at start.
const GITHUB_KINDS = new Set(['github_app', 'github_app_basic']);
export function rolesWithGithubRules(upstreams, policy) {
  const githubUpstreams = new Set(Object.entries(upstreams.upstreams).filter(([, u]) => GITHUB_KINDS.has(u.credential)).map(([key]) => key));
  return [...new Set((policy.rules || []).filter((r) => githubUpstreams.has(r.upstream)).map((r) => r.role))];
}
export function fromEnvironment(upstreams = { upstreams: {} }, policy = { roles: {}, rules: [] }, { fetchImpl = fetch } = {}) {
  const kinds = new Set(Object.values(upstreams.upstreams).map((u) => u.credential).filter(Boolean));
  const github = {};
  for (const role of rolesWithGithubRules(upstreams, policy)) {
    if (!/^[a-z][a-z0-9]*$/.test(role)) throw new Error(`credentials: role '${role}' cannot name environment variables (lowercase letters and digits only)`);
    const name = `GITHUB_APP_${role.toUpperCase()}`;
    github[role] = githubAppTokenSource({
      appId: secret(`${name}_ID`, { required: true }),
      installationId: secret(`${name}_INSTALLATION_ID`, { required: true }),
      privateKey: secret(`${name}_PRIVATE_KEY`, { required: true }),
      fetchImpl,
    });
  }
  const tokenFor = (role) => {
    const source = github[role];
    if (!source) throw new Error(`credentials: role '${role}' holds no GitHub App at this gateway`);
    return source();
  };
  const anthropicKey = secret('ANTHROPIC_API_KEY');
  const anthropicToken = secret('ANTHROPIC_AUTH_TOKEN');
  if (kinds.has('anthropic') && !anthropicKey && !anthropicToken) throw new Error('credentials: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is not set');
  return {
    async headersFor(kind, role) {
      switch (kind) {
        case null:
        case undefined:
        case 'passthrough':
          return {};
        case 'github_app':
          return { authorization: `Bearer ${await tokenFor(role)}` };
        case 'github_app_basic':
          return { authorization: `Basic ${Buffer.from(`x-access-token:${await tokenFor(role)}`).toString('base64')}` };
        case 'anthropic':
          return anthropicKey ? { 'x-api-key': anthropicKey } : { authorization: `Bearer ${anthropicToken}` };
        default:
          throw new Error(`credentials: unknown kind ${kind}`);
      }
    },
  };
}
