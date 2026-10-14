import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleFromCertificateAndToken } from '../src/app.js';

const policy = { roles: { claude: { cn: 'claude' }, gemini: { cn: 'gemini' } } };
const roleOf = roleFromCertificateAndToken(policy, { claude: 'ROLE-TOKEN', gemini: 'GEMINI-TOKEN' });
const req = (cn, headers) => ({ socket: { getPeerCertificate: () => (cn ? { subject: { CN: cn } } : {}) }, headers });

test('the role is the certificate CN, admitted only with its token in Proxy-Authorization', () => {
  assert.equal(roleOf(req('claude', { 'proxy-authorization': 'Bearer ROLE-TOKEN' })), 'claude');
  assert.equal(roleOf(req('claude', { 'proxy-authorization': 'Bearer WRONG-TOKEN' })), null);
  assert.equal(roleOf(req('claude', { authorization: 'Bearer ROLE-TOKEN' })), null, 'Authorization is the client\'s own, never the role token');
  assert.equal(roleOf(req('someone', { 'proxy-authorization': 'Bearer ROLE-TOKEN' })), null, 'a CN no role names');
  assert.equal(roleOf(req(null, { 'proxy-authorization': 'Bearer ROLE-TOKEN' })), null, 'no certificate');
});

test('a second role is its own CN with its own token, never admitted with another role\'s', () => {
  assert.equal(roleOf(req('gemini', { 'proxy-authorization': 'Bearer GEMINI-TOKEN' })), 'gemini');
  assert.equal(roleOf(req('gemini', { 'proxy-authorization': 'Bearer ROLE-TOKEN' })), null, 'claude\'s token on gemini\'s certificate');
  assert.equal(roleOf(req('claude', { 'proxy-authorization': 'Bearer GEMINI-TOKEN' })), null, 'gemini\'s token on claude\'s certificate');
});
