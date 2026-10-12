import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, githubAppTokenSource } from '../src/credentials.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

test('the App JWT is RS256 over header.payload with iss, iat 60 s back and exp 9 minutes ahead', () => {
  const now = 1_700_000_000;
  const jwt = appJwt('4819921', pem, now);
  const [h, p, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(dec(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(dec(p), { iat: now - 60, exp: now + 540, iss: '4819921' });
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
