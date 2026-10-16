import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, githubAppTokenSource, fromEnvironment, rolesWithGithubRules } from '../src/credentials.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

test('the App JWT is RS256 over header.payload with iss, iat 60 s back and exp 9 minutes ahead', () => {
  const now = 1_700_000_000;
  const jwt = appJwt('100001', pem, now);
  const [h, p, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(dec(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(dec(p), { iat: now - 60, exp: now + 540, iss: '100001' });
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${p}`);
  assert.equal(v.verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), true);
});

test('the installation token is minted once and reused until five minutes before it expires', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ token: `ghs_${calls}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }) }; };
  const source = githubAppTokenSource({ appId: '1', installationId: '2', privateKey: pem, fetchImpl });
  assert.equal(await source(), 'ghs_1');
  assert.equal(await source(), 'ghs_1');
  assert.equal(calls, 1);
});

test('a 200 whose payload carries no token string or no expires_at date is an error, not a cached undefined', async () => {
  const payloads = [{}, { token: null, expires_at: '2026-01-01T00:00:00Z' }, { token: '', expires_at: '2026-01-01T00:00:00Z' }, { token: 'ghs_x' }, { token: 'ghs_x', expires_at: 'soon' }];
  for (const payload of payloads) {
    const fetchImpl = async () => ({ ok: true, json: async () => payload });
    const source = githubAppTokenSource({ appId: '1', installationId: '2', privateKey: pem, fetchImpl });
    await assert.rejects(source(), /credentials: installation token: the response carried no/);
  }
});

const upstreams = { upstreams: { github: { host: 'api.github.com', credential: 'github_app' }, git: { host: 'github.com', credential: 'github_app_basic' }, npm: { host: 'registry.npmjs.org', credential: null } } };
const policy = { roles: { claude: { cn: 'claude' }, gemini: { cn: 'gemini' }, reader: { cn: 'reader' } }, rules: [
  { role: 'claude', upstream: 'github', method: 'GET', path: '.*' },
  { role: 'gemini', upstream: 'git', method: 'GET', path: '.*' },
  { role: 'reader', upstream: 'npm', method: 'GET', path: '.*' },
] };
const issOf = (authorization) => JSON.parse(Buffer.from(authorization.replace(/^Bearer /, '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).iss;

test('each role with a GitHub rule holds its own App; the token injected is the asking role\'s (one App served every role until 2026-10-16)', async () => {
  assert.deepEqual(rolesWithGithubRules(upstreams, policy), ['claude', 'gemini']);
  Object.assign(process.env, { GITHUB_APP_CLAUDE_ID: '100001', GITHUB_APP_CLAUDE_INSTALLATION_ID: '11', GITHUB_APP_CLAUDE_PRIVATE_KEY: pem, GITHUB_APP_GEMINI_ID: '100002', GITHUB_APP_GEMINI_INSTALLATION_ID: '22', GITHUB_APP_GEMINI_PRIVATE_KEY: pem });
  const minted = [];
  const fetchImpl = async (url, init) => { minted.push({ url, iss: issOf(init.headers.authorization) }); return { ok: true, json: async () => ({ token: `ghs_${minted.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }) }; };
  const c = fromEnvironment(upstreams, policy, { fetchImpl });
  assert.deepEqual(await c.headersFor('github_app', 'claude'), { authorization: 'Bearer ghs_1' });
  assert.deepEqual(await c.headersFor('github_app_basic', 'gemini'), { authorization: `Basic ${Buffer.from('x-access-token:ghs_2').toString('base64')}` });
  assert.deepEqual(minted.map((m) => m.iss), ['100001', '100002'], 'two Apps, each JWT signed as its own role\'s App');
  assert.ok(minted[0].url.endsWith('/installations/11/access_tokens') && minted[1].url.endsWith('/installations/22/access_tokens'));
  await assert.rejects(c.headersFor('github_app', 'reader'), /role 'reader' holds no GitHub App/);
  assert.deepEqual(await c.headersFor(null, 'reader'), {});
  for (const k of Object.keys(process.env).filter((k) => k.startsWith('GITHUB_APP_'))) delete process.env[k];
});

test('a role with GitHub rules and no App of its own refuses the start, by the variable\'s name', () => {
  Object.assign(process.env, { GITHUB_APP_CLAUDE_ID: '100001', GITHUB_APP_CLAUDE_INSTALLATION_ID: '11', GITHUB_APP_CLAUDE_PRIVATE_KEY: pem });
  assert.throws(() => fromEnvironment(upstreams, policy), /GITHUB_APP_GEMINI_ID \(or GITHUB_APP_GEMINI_ID_FILE\) is not set/);
  for (const k of Object.keys(process.env).filter((k) => k.startsWith('GITHUB_APP_'))) delete process.env[k];
  assert.throws(() => fromEnvironment(upstreams, { roles: {}, rules: [{ role: 'odd-name', upstream: 'github', method: 'GET', path: '.*' }] }), /cannot name environment variables/);
});
