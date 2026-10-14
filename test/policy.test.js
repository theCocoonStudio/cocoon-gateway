import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compile, decide } from '../src/policy.js';

const policy = JSON.parse(fs.readFileSync(new URL('../config/policy.json', import.meta.url), 'utf8'));
const c = compile(policy);
const d = (u, m, p) => decide(c, 'claude', u, m, p).allow;

test('the writes the record names are allowed, by their exact routes', () => {
  assert.equal(d('github', 'POST', '/api/v3/repos/o/r/pulls'), true);
  assert.equal(d('github', 'POST', '/api/v3/repos/o/r/pulls/12/reviews'), true);
  assert.equal(d('github', 'POST', '/api/v3/repos/o/r/issues/3/comments'), true);
  assert.equal(d('github', 'PATCH', '/api/v3/repos/o/r/pulls/12'), true);
  assert.equal(d('github', 'PUT', '/api/v3/repos/o/r/pulls/12/merge'), true);
  assert.equal(d('github', 'PUT', '/api/v3/repos/o/r/pulls/12/update-branch'), true);
  assert.equal(d('github', 'POST', '/api/graphql'), true);
  assert.equal(d('git', 'POST', '/o/r.git/git-receive-pack'), true);
  assert.equal(d('anthropic', 'POST', '/v1/messages'), true);
  assert.equal(d('npm', 'GET', '/express/-/express-5.2.1.tgz'), true);
  // npm's two advisory lookups are POSTs of the lockfile's names and versions: `npm ci` and `npm audit`
  // (the first start through the gateway refused them, 2026-10-12 06:14)
  assert.equal(d('npm', 'POST', '/-/npm/v1/security/advisories/bulk'), true);
  assert.equal(d('npm', 'POST', '/-/npm/v1/security/audits/quick'), true);
});

test('everything else is refused: deletes, settings, other roles, other hosts', () => {
  assert.equal(d('github', 'DELETE', '/api/v3/repos/o/r/git/refs/heads/main'), false);
  assert.equal(d('github', 'PATCH', '/api/v3/repos/o/r'), false);
  assert.equal(d('github', 'PUT', '/api/v3/repos/o/r/contents/x'), false);
  assert.equal(d('anthropic', 'GET', '/v1/pages/mcp'), false);
  assert.equal(d('npm', 'PUT', '/express'), false);
  assert.equal(d('npm', 'POST', '/express'), false);
  assert.equal(d('npm', 'POST', '/-/npm/v1/security/audits/full'), false);
  assert.equal(decide(c, 'nobody', 'github', 'GET', '/api/v3/user').allow, false);
  assert.equal(d('unknown', 'GET', '/'), false);
});

test('first match wins and a deny rule denies', () => {
  const p = { roles: {}, rules: [{ role: 'r', upstream: 'u', method: 'GET', path: '^/secret', effect: 'deny' }, { role: 'r', upstream: 'u', method: 'GET', path: '.*' }] };
  const cc = compile(p);
  assert.equal(decide(cc, 'r', 'u', 'GET', '/secret/x').allow, false);
  assert.equal(decide(cc, 'r', 'u', 'GET', '/open').allow, true);
});

test('gemini holds the same rule set as claude, rule for rule (the owner, 2026-10-14: the same set unless one is revoked)', () => {
  const shape = (r) => JSON.stringify({ upstream: r.upstream, method: r.method, path: r.path, effect: r.effect ?? 'allow' });
  const rulesOf = (role) => policy.rules.filter((r) => r.role === role).map(shape);
  assert.ok(rulesOf('claude').length >= 14);
  assert.deepEqual(rulesOf('gemini'), rulesOf('claude'));
  assert.deepEqual(Object.keys(policy.roles), ['claude', 'gemini']);
  const g = (u, m, p) => decide(c, 'gemini', u, m, p).allow;
  assert.equal(g('github', 'POST', '/api/v3/repos/o/r/pulls'), true);
  assert.equal(g('git', 'POST', '/o/r.git/git-receive-pack'), true);
  assert.equal(g('github', 'DELETE', '/api/v3/repos/o/r'), false);
  assert.equal(g('github', 'PATCH', '/api/v3/repos/o/r'), false);
});
