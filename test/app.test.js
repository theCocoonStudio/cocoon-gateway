import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

// A fake upstream that records what it received and answers with a redirect, a stream, or an echo.
let upstream, upstreamPort, received;
before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = { method: req.method, url: req.url, headers: req.headers, body };
      if (req.url === '/redirect') return res.writeHead(302, { location: 'https://api.github.com/repos/o/r/pulls/1' }).end();
      if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 20); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ echo: body }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
});
after(() => upstream.close());

const upstreams = { domain: 'gw.test', upstreams: { github: { host: 'api.github.com', credential: 'github_app', rewrite: { '^/api/v3(/.*)$': '$1' } }, arxiv: { host: 'arxiv.org', credential: null }, anthropic: { host: 'api.anthropic.com', credential: 'passthrough' } } };
const policy = { roles: { claude: { cn: 'claude' } }, rules: [
  { role: 'claude', upstream: 'github', method: 'GET', path: '.*' },
  { role: 'claude', upstream: 'github', method: 'POST', path: '^(/api/v3)?/repos/[^/]+/[^/]+/pulls$' },
  { role: 'claude', upstream: 'arxiv', method: 'GET', path: '.*' },
  { role: 'claude', upstream: 'anthropic', method: 'POST', path: '^/v1/messages$' },
] };
const credentials = { async headersFor(kind) { return kind === 'github_app' ? { authorization: 'Bearer UPSTREAM-TOKEN' } : {}; } };
const logs = [];
let accepting = true;
const app = createApp({ upstreams, policy, credentials, roleOf: (req) => req.headers['x-test-role'] || null, log: (l) => logs.push(l), targetOf: () => ({ host: '127.0.0.1', port: upstreamPort, scheme: 'http' }), accept: () => accepting });

let server, port;
before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; });
after(() => server.close());

const call = (opts, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data })); });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

test('an unknown host is misdirected, never proxied', async () => {
  const r = await call({ method: 'GET', path: '/x', headers: { host: 'evil.example' } });
  assert.equal(r.status, 421);
});

test('no role: unauthenticated; a role with no rule: refused by policy, with the request id', async () => {
  assert.equal((await call({ method: 'GET', path: '/x', headers: { host: 'github.gw.test' } })).status, 401);
  const r = await call({ method: 'DELETE', path: '/api/v3/repos/o/r', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } });
  assert.equal(r.status, 403);
  assert.ok(JSON.parse(r.data).requestId);
  const line = logs.find((l) => l.id === JSON.parse(r.data).requestId);
  assert.deepEqual([line.kind, line.status, line.role, line.upstream, line.peer], ['policy', 403, 'claude', 'github', '127.0.0.1'], 'a refusal line names its kind, the role and the peer');
});

test('when the log cannot keep a line, every request is refused first with a 503 that says so: no log, no request', async () => {
  accepting = false;
  try {
    const r = await call({ method: 'GET', path: '/api/v3/zen', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.data).error, 'log');
    const line = logs.find((l) => l.id === JSON.parse(r.data).requestId);
    assert.equal(line.kind, 'log', 'the refusal is still offered to the log, which counts it if it cannot keep it');
  } finally { accepting = true; }
});

test('an allowed request is proxied: Host rewritten, the client credential dropped, the upstream one injected, the path rewritten, the id stamped', async () => {
  const r = await call({ method: 'POST', path: '/api/v3/repos/o/r/pulls', headers: { host: 'github.gw.test', 'x-test-role': 'claude', authorization: 'Bearer CLIENT-TOKEN', 'content-type': 'application/json' } }, '{"title":"t"}');
  assert.equal(r.status, 200);
  assert.equal(received.url, '/repos/o/r/pulls');
  assert.equal(received.headers.host, 'api.github.com');
  assert.equal(received.headers.authorization, 'Bearer UPSTREAM-TOKEN');
  assert.equal(received.body, '{"title":"t"}');
  assert.ok(received.headers['x-request-id']);
  assert.equal(r.headers['x-request-id'], received.headers['x-request-id']);
  assert.equal(JSON.parse(r.data).echo, '{"title":"t"}');
  const line = logs.find((l) => l.id === r.headers['x-request-id'] && l.status === 200);
  assert.ok(line && line.role === 'claude' && line.upstream === 'github');
  assert.equal(line.peer, '127.0.0.1', 'the proxied line carries the client address');
  assert.equal(typeof line.ms, 'number');
});

test('a redirect to the upstream host comes back pointing at the gateway subdomain', async () => {
  const r = await call({ method: 'GET', path: '/redirect', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://github.gw.test/repos/o/r/pulls/1');
});

test('a streamed response arrives in order, untouched', async () => {
  const r = await call({ method: 'GET', path: '/stream', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } });
  assert.equal(r.status, 200);
  assert.equal(r.data, 'data: one\n\ndata: two\n\n');
});

test('an upstream with no credential gets none, and neither the client credential nor the proxy one passes', async () => {
  await call({ method: 'GET', path: '/abs/1234.5678', headers: { host: 'arxiv.gw.test', 'x-test-role': 'claude', authorization: 'Bearer CLIENT-TOKEN', 'proxy-authorization': 'Bearer ROLE-TOKEN', 'x-api-key': 'K' } });
  assert.equal(received.headers.authorization, undefined);
  assert.equal(received.headers['proxy-authorization'], undefined);
  assert.equal(received.headers['x-api-key'], undefined);
  assert.equal(received.headers.host, 'arxiv.org');
});

test('a passthrough upstream keeps the client\'s own credentials and still never the proxy one', async () => {
  const r = await call({ method: 'POST', path: '/v1/messages', headers: { host: 'anthropic.gw.test', 'x-test-role': 'claude', authorization: 'Bearer OAUTH-OF-THE-OWNER', 'x-api-key': 'K', 'proxy-authorization': 'Bearer ROLE-TOKEN', 'content-type': 'application/json' } }, '{}');
  assert.equal(r.status, 200);
  assert.equal(received.headers.authorization, 'Bearer OAUTH-OF-THE-OWNER');
  assert.equal(received.headers['x-api-key'], 'K');
  assert.equal(received.headers['proxy-authorization'], undefined);
  assert.equal(received.headers.host, 'api.anthropic.com');
});

test('the app refuses to start without a domain: the repository carries none, the environment supplies it', () => {
  assert.throws(() => createApp({ upstreams: { upstreams: upstreams.upstreams }, policy, credentials, roleOf: () => 'claude' }), /upstreams.domain is required/);
});
