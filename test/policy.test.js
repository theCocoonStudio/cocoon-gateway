import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compile, decide } from '../src/policy.js';

const policy = JSON.parse(fs.readFileSync(new URL('../config/policy.json', import.meta.url), 'utf8'));
const c = compile(policy);
const d = (u, m, p) => decide(c, 'claude', u, m, p).allow;
const R = 'theCocoonStudio/cocoon-ai'; // a writable repository; `o/r` below is any other

test('the writes the record names are allowed, by their exact routes', () => {
  assert.equal(d('github', 'POST', `/api/v3/repos/${R}/pulls`), true);
  assert.equal(d('github', 'POST', `/api/v3/repos/${R}/pulls/12/reviews`), true);
  assert.equal(d('github', 'POST', `/api/v3/repos/${R}/issues/3/comments`), true);
  assert.equal(d('github', 'PATCH', `/api/v3/repos/${R}/pulls/12`), true);
  assert.equal(d('github', 'PUT', `/api/v3/repos/${R}/pulls/12/merge`), true);
  assert.equal(d('github', 'PUT', `/api/v3/repos/${R}/pulls/12/update-branch`), true);
  assert.equal(d('github', 'POST', '/api/graphql'), true);
  assert.equal(d('git', 'POST', `/${R}.git/git-receive-pack`), true);
  assert.equal(d('git', 'POST', '/o/r.git/git-upload-pack'), true); // a fetch or clone of any repository
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

test('every repository outside the writable list is read-only, for every role: a write there matches no rule (2026-10-17, the owner\'s own repositories)', () => {
  const seven = ['cocoon-ai', 'cocoon-ai-records', 'cocoon-ml', 'cocoon-relations', 'cocoon-agent-sandbox', 'cocoon-gateway', 'cocoon-copula'].map((n) => `theCocoonStudio/${n}`);
  assert.deepEqual(policy.writable, seven);
  for (const role of ['claude', 'gemini']) {
    const x = (u, m, p) => decide(c, role, u, m, p).allow;
    assert.equal(x('github', 'GET', '/api/v3/repos/o/r/pulls/1'), true, 'reads pass everywhere');
    assert.equal(x('git', 'POST', '/o/r.git/git-upload-pack'), true, 'a clone passes everywhere');
    assert.equal(x('github', 'POST', '/api/v3/repos/o/r/pulls'), false);
    assert.equal(x('github', 'POST', '/api/v3/repos/o/r/issues/1/comments'), false);
    assert.equal(x('github', 'PATCH', '/api/v3/repos/o/r/pulls/1'), false);
    assert.equal(x('github', 'PUT', '/api/v3/repos/o/r/pulls/1/merge'), false);
    assert.equal(x('git', 'POST', '/o/r.git/git-receive-pack'), false, 'a push outside the list is refused');
    assert.equal(x('git', 'POST', '/theCocoonStudio/cocoon-ai-site.git/git-receive-pack'), false, 'a name that merely starts like a listed one is not it');
    assert.equal(x('git', 'POST', '/theCocoonStudio/cocoon-ai.git/git-receive-pack'), true);
    assert.equal(x('git', 'POST', '/theCocoonStudio/cocoon-ai/git-receive-pack'), true);
  }
});

test('a rule with {writable} and no list refuses to compile; the names are taken literally', () => {
  assert.throws(() => compile({ roles: {}, rules: [{ role: 'r', upstream: 'u', method: 'POST', path: '^/{writable}/x$' }] }), /names no writable repository/);
  const cc = compile({ roles: {}, writable: ['a.b/c+d'], rules: [{ role: 'r', upstream: 'u', method: 'POST', path: '^/{writable}/x$' }] });
  assert.equal(decide(cc, 'r', 'u', 'POST', '/a.b/c+d/x').allow, true);
  assert.equal(decide(cc, 'r', 'u', 'POST', '/aXb/c+d/x').allow, false, 'the dot is a dot');
});

test('first match wins and a deny rule denies', () => {
  const p = { roles: {}, rules: [{ role: 'r', upstream: 'u', method: 'GET', path: '^/secret', effect: 'deny' }, { role: 'r', upstream: 'u', method: 'GET', path: '.*' }] };
  const cc = compile(p);
  assert.equal(decide(cc, 'r', 'u', 'GET', '/secret/x').allow, false);
  assert.equal(decide(cc, 'r', 'u', 'GET', '/open').allow, true);
});

test('gemini holds the claude rule set minus the merge rule (the owner, 2026-10-14: the same set unless one is revoked; 2026-10-16: only Claude merges)', () => {
  const shape = (r) => JSON.stringify({ upstream: r.upstream, method: r.method, path: r.path, effect: r.effect ?? 'allow' });
  const rulesOf = (role) => policy.rules.filter((r) => r.role === role).map(shape);
  assert.ok(rulesOf('claude').length >= 14);
  const merge = rulesOf('claude').filter((r) => r.includes('(merge|update-branch)'));
  assert.equal(merge.length, 1, 'claude has the one merge rule');
  assert.deepEqual(rulesOf('gemini'), rulesOf('claude').filter((r) => !r.includes('(merge|update-branch)')));
  assert.deepEqual(Object.keys(policy.roles), ['claude', 'gemini']);
  const g = (u, m, p) => decide(c, 'gemini', u, m, p).allow;
  assert.equal(g('github', 'POST', `/api/v3/repos/${R}/pulls`), true);
  assert.equal(g('git', 'POST', `/${R}.git/git-receive-pack`), true);
  assert.equal(g('github', 'PUT', `/api/v3/repos/${R}/pulls/1/merge`), false, 'gemini does not merge');
  assert.equal(g('github', 'PUT', `/api/v3/repos/${R}/pulls/1/update-branch`), false);
  assert.equal(g('github', 'DELETE', '/api/v3/repos/o/r'), false);
  assert.equal(g('github', 'PATCH', '/api/v3/repos/o/r'), false);
});
