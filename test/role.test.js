import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleFromCertificateAndToken } from '../src/app.js';

const policy = { roles: { claude: { cn: 'claude' } } };
const roleOf = roleFromCertificateAndToken(policy, { claude: 'ROLE-TOKEN' });
const req = (cn, headers) => ({ socket: { getPeerCertificate: () => (cn ? { subject: { CN: cn } } : {}) }, headers });

test('the role is the certificate CN, admitted only with its token in Proxy-Authorization', () => {
  assert.equal(roleOf(req('claude', { 'proxy-authorization': 'Bearer ROLE-TOKEN' })), 'claude');
  assert.equal(roleOf(req('claude', { 'proxy-authorization': 'Bearer WRONG-TOKEN' })), null);
  assert.equal(roleOf(req('claude', { authorization: 'Bearer ROLE-TOKEN' })), null, 'Authorization is the client\'s own, never the role token');
  assert.equal(roleOf(req('someone', { 'proxy-authorization': 'Bearer ROLE-TOKEN' })), null, 'a CN no role names');
  assert.equal(roleOf(req(null, { 'proxy-authorization': 'Bearer ROLE-TOKEN' })), null, 'no certificate');
});
