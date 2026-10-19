import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

// A fake upstream that records what it received and answers with a redirect, a stream, or an echo.
let upstream, upstreamPort, received, slowClosed;
before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = { method: req.method, url: req.url, headers: req.headers, body };
      if (req.url === '/redirect') return res.writeHead(302, { location: 'https://api.github.com/repos/o/r/pulls/1' }).end();
      if (req.url === '/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 20); return; }
      if (req.url === '/gap') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 150); return; } // silent longer than the connect timeout
      if (req.url === '/cut') { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.write('data: one\n\n'); setTimeout(() => res.destroy(), 20); return; } // the upstream dies mid-stream
      if (req.url === '/never') { return; } // no headers, ever
      if (req.url === '/stall') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); setTimeout(() => { if (!res.destroyed) { res.write('data: late\n\n'); res.end(); } }, 1400); return; } // silent longer than the idle timeout, then more
      if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); let n = 0; const iv = setInterval(() => { if (res.destroyed) { clearInterval(iv); return; } n += 1; res.write(`data: ${n}\n\n`); if (n === 20) { clearInterval(iv); res.end(); } }, 50); res.on('close', () => { clearInterval(iv); slowClosed = { at: Date.now(), ended: res.writableEnded }; }); return; } // a long stream; the client leaves first
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ echo: body }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
});
after(() => { upstream.closeAllConnections(); upstream.close(); }); // the /never handler holds its connection open on purpose

const upstreams = { domain: 'gw.test', upstreams: { github: { host: 'api.github.com', credential: 'github_app', rewrite: { '^/api/v3(/.*)$': '$1' } }, arxiv: { host: 'arxiv.org', credential: null }, git: { host: 'github.com', credential: 'github_app_basic' }, anthropic: { host: 'api.anthropic.com', credential: 'passthrough', encoding: 'identity' } } };
upstreams.upstreams.github.rewrite['^/api/graphql$'] = '/graphql';
const policy = { roles: { claude: { cn: 'claude' }, gemini: { cn: 'gemini' } }, rules: [
  { role: 'gemini', upstream: 'github', method: 'GET', path: '.*' },
  { role: 'claude', upstream: 'github', method: 'GET', path: '.*' },
  { role: 'claude', upstream: 'github', method: 'POST', path: '^(/api/v3)?/repos/[^/]+/[^/]+/pulls$' },
  { role: 'claude', upstream: 'github', method: 'POST', path: '^(/api/graphql|/graphql)$' },
  { role: 'claude', upstream: 'arxiv', method: 'GET', path: '.*' },
  { role: 'claude', upstream: 'anthropic', method: 'POST', path: '^/v1/messages$' },
  { role: 'claude', upstream: 'github', method: 'PATCH', path: '^(/api/v3)?/repos/[^/]+/[^/]+/pulls/[0-9]+$' },
  { role: 'claude', upstream: 'git', method: 'POST', path: '^/[^/]+/[^/]+(\\.git)?/git-receive-pack$' },
  { role: 'gemini', upstream: 'git', method: 'POST', path: '^/[^/]+/[^/]+(\\.git)?/git-receive-pack$' },
] };
const credentials = { async headersFor(kind, role) { return kind === 'github_app' ? { authorization: `Bearer UPSTREAM-TOKEN-${role}` } : {}; } };
const logs = [];
const app = createApp({ upstreams, policy, credentials, roleOf: (req) => req.headers['x-test-role'] || null, log: (l) => logs.push(l), targetOf: () => ({ host: '127.0.0.1', port: upstreamPort, scheme: 'http' }), proxyOptions: { connectTimeoutMs: 60, idleTimeoutMs: 1000 }, graphqlBodyCapBytes: 4096, receivePackHeadCapBytes: 512 });

let server, port;
before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; });
after(() => { server.closeAllConnections(); server.close(); });

const call = (opts, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data })); });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

const gql = (body) => call({ method: 'POST', path: '/api/graphql', headers: { host: 'github.gw.test', 'x-test-role': 'claude', 'content-type': 'application/json' } }, body);

test('a GraphQL query passes and arrives whole, byte for byte', async () => {
  const body = JSON.stringify({ query: 'query PR($n: Int!) { repository(owner: "o", name: "r") { pullRequest(number: $n) { title } } }', variables: { n: 1 } });
  const r = await gql(body);
  assert.equal(r.status, 200);
  assert.equal(received.url, '/graphql', 'rewritten to the API host\'s path');
  assert.equal(received.body, body);
  assert.equal(received.headers['content-length'], String(Buffer.byteLength(body)));
});

test('a GraphQL mutation never passes, for any role: 403, a log line, nothing sent upstream', async () => {
  received = null;
  const r = await gql(JSON.stringify({ query: 'mutation Merge($id: ID!) { mergePullRequest(input: { pullRequestId: $id }) { clientMutationId } }', variables: { id: 'x' } }));
  assert.equal(r.status, 403);
  assert.match(JSON.parse(r.data).detail, /mutations never pass/);
  assert.equal(received, null, 'the upstream saw nothing');
  const line = logs.find((l) => l.status === 403 && l.rule === 'graphql');
  assert.ok(line, 'the refusal is one log line');
});

test('a batch with one mutation is refused whole; the shorthand and comments are read right', async () => {
  const r1 = await gql(JSON.stringify([{ query: '{ viewer { login } }' }, { query: 'mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }' }]));
  assert.equal(r1.status, 403);
  const r2 = await gql(JSON.stringify({ query: '# a mutation in a comment is not one\n{ search(query: "mutation", type: ISSUE, first: 1) { issueCount } }' }));
  assert.equal(r2.status, 200, 'the word inside a comment or a string is not the keyword');
  const r3 = await gql(JSON.stringify({ query: 'subscription { x }' }));
  assert.equal(r3.status, 403);
});

test('a GraphQL body that is not a query document, or is larger than the cap, is refused', async () => {
  assert.equal((await gql('not json')).status, 403);
  assert.equal((await gql(JSON.stringify({ q: 'query { x }' }))).status, 403);
  assert.equal((await gql(JSON.stringify([]))).status, 403);
  const big = JSON.stringify({ query: '{ viewer { login } } ' + ' '.repeat(5000) });
  assert.equal((await gql(big)).status, 413);
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
});

test('an allowed request is proxied: Host rewritten, the client credential dropped, the upstream one injected, the path rewritten, the id stamped', async () => {
  const r = await call({ method: 'POST', path: '/api/v3/repos/o/r/pulls', headers: { host: 'github.gw.test', 'x-test-role': 'claude', authorization: 'Bearer CLIENT-TOKEN', 'content-type': 'application/json' } }, '{"title":"t"}');
  assert.equal(r.status, 200);
  assert.equal(received.url, '/repos/o/r/pulls');
  assert.equal(received.headers.host, 'api.github.com');
  assert.equal(received.headers.authorization, 'Bearer UPSTREAM-TOKEN-claude', 'the asking role\'s credential, not a shared one');
  assert.equal(received.body, '{"title":"t"}');
  assert.ok(received.headers['x-request-id']);
  assert.equal(r.headers['x-request-id'], received.headers['x-request-id']);
  assert.equal(JSON.parse(r.data).echo, '{"title":"t"}');
  const line = logs.find((l) => l.id === r.headers['x-request-id'] && l.status === 200);
  assert.ok(line && line.role === 'claude' && line.upstream === 'github');
});

test('a second role on the same upstream gets its own credential injected, never the first role\'s', async () => {
  const r = await call({ method: 'GET', path: '/api/v3/zen', headers: { host: 'github.gw.test', 'x-test-role': 'gemini' } });
  assert.equal(r.status, 200);
  assert.equal(received.headers.authorization, 'Bearer UPSTREAM-TOKEN-gemini');
});

test('a redirect to the upstream host comes back pointing at the gateway subdomain', async () => {
  const r = await call({ method: 'GET', path: '/redirect', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://github.gw.test/repos/o/r/pulls/1');
});

test('a stream silent for longer than the connect timeout is not cut: the idle timeout alone bounds a response that has begun', async () => {
  const r = await call({ method: 'GET', path: '/gap', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } });
  assert.equal(r.status, 200);
  assert.equal(r.data, 'data: one\n\ndata: two\n\n');
});

test('an upstream that dies mid-stream cuts the client connection and appends nothing; the log says why with a 502', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/cut', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('aborted', () => resolve({ status: res.statusCode, data, aborted: true }));
      res.on('error', () => resolve({ status: res.statusCode, data, aborted: true }));
      res.on('end', () => resolve({ status: res.statusCode, data, aborted: false }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(r.status, 200, 'the headers had gone');
  assert.equal(r.data, 'data: one\n\n', 'nothing appended after the cut: no JSON in an encoded stream');
  assert.equal(r.aborted, true, 'the client sees the cut');
  const line = logs.find((l) => l.path === '/cut' && l.status === 502);
  assert.match(line.detail, /after the headers were sent/);
});

test('a client that closes its connection mid-stream has the upstream request destroyed at once and a 499 line, not an idle timeout ten minutes later', async () => {
  slowClosed = null;
  const left = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/slow', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } }, (res) => {
      res.once('data', () => { req.destroy(); resolve(Date.now()); });
    });
    req.on('error', reject); req.end();
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(slowClosed, 'the upstream saw its response closed');
  assert.equal(slowClosed.ended, false, 'closed before the upstream had finished: the stream was cut, not read to its end');
  assert.ok(slowClosed.at - left < 150, `the upstream was cut within 150 ms of the client leaving, not at the idle timeout (${slowClosed.at - left} ms)`);
  const line = logs.find((l) => l.path === '/slow');
  assert.ok(line, 'one log line for the request');
  assert.equal(line.status, 499);
  assert.match(line.detail, /client closed the connection mid-stream/);
  assert.equal(logs.filter((l) => l.path === '/slow').length, 1, 'logged once');
});

test('an upstream silent for longer than the idle timeout mid-stream is cut with one 502 line, and the late bytes do not log a second line', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/stall', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('aborted', () => resolve({ data, aborted: true }));
      res.on('error', () => resolve({ data, aborted: true }));
      res.on('end', () => resolve({ data, aborted: false }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(r.aborted, true, 'the client sees the cut');
  assert.equal(r.data, 'data: one\n\n', 'nothing appended');
  await new Promise((rr) => setTimeout(rr, 700));
  const lines = logs.filter((l) => l.path === '/stall');
  assert.equal(lines.length, 1, `one line, not one per event (${JSON.stringify(lines.map((l) => l.status))})`);
  assert.equal(lines[0].status, 502);
  assert.match(lines[0].detail, /idle timeout/);
});

test('an upstream that never answers is a 502 with the request id, as before', async () => {
  const r = await call({ method: 'GET', path: '/never', headers: { host: 'github.gw.test', 'x-test-role': 'claude' } });
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.data).detail, /connect timeout/);
  assert.ok(JSON.parse(r.data).requestId);
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
  assert.equal(received.headers['accept-encoding'], 'identity', 'the model upstream is asked for an uncompressed body (the owner, 2026-10-13)');
});

test('an upstream without the encoding mark keeps the client\'s Accept-Encoding', async () => {
  await call({ method: 'GET', path: '/x', headers: { host: 'github.gw.test', 'x-test-role': 'claude', 'accept-encoding': 'gzip, br' } });
  assert.equal(received.headers['accept-encoding'], 'gzip, br');
});

test('the app refuses to start without a domain: the repository carries none, the environment supplies it', () => {
  assert.throws(() => createApp({ upstreams: { upstreams: upstreams.upstreams }, policy, credentials, roleOf: () => 'claude' }), /upstreams.domain is required/);
});

// The ref gate on a push (src/git.js, 2026-10-19): the command list that opens a receive-pack body is read
// before a byte goes up; a deletion, a signed push, an encoded body and a body that is not a command list are
// refused for every role; a plain push arrives whole, byte for byte, the pack included.
const pkt = (s) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
const SHA = (c) => c.repeat(40);
const push = (body, headers = {}, role = 'claude') => call({ method: 'POST', path: '/o/r.git/git-receive-pack', headers: { host: 'git.gw.test', 'x-test-role': role, 'content-type': 'application/x-git-receive-pack-request', ...headers } }, body);

test('a push that deletes a ref never passes, for any role: 403, the ref in the log line, nothing sent upstream', async () => {
  for (const role of ['claude', 'gemini']) {
    received = null;
    const r = await push(pkt(`${SHA('a')} ${SHA('0')} refs/heads/chat/2026-10-17-1\0report-status side-band-64k\n`) + '0000', {}, role);
    assert.equal(r.status, 403);
    assert.match(JSON.parse(r.data).detail, /ref deletions never pass/);
    assert.equal(received, null);
    assert.deepEqual(logs.at(-1).refs, ['refs/heads/chat/2026-10-17-1']);
    assert.equal(logs.at(-1).rule, 'git-receive-pack');
  }
});

test('a deletion among creations and updates refuses the whole push', async () => {
  received = null;
  const r = await push(pkt(`${SHA('a')} ${SHA('b')} refs/heads/main\0report-status\n`) + pkt(`${SHA('c')} ${SHA('0')} refs/heads/old\n`) + '0000PACK' + 'x'.repeat(100));
  assert.equal(r.status, 403);
  assert.equal(received, null);
});

test('a signed push (push-cert, with its nonce) is refused', async () => {
  received = null;
  const r = await push(pkt(`${SHA('a')} ${SHA('b')} refs/heads/main\0report-status push-cert=abc123\n`) + '0000PACK');
  assert.equal(r.status, 403);
  assert.match(JSON.parse(r.data).detail, /signed push/);
  assert.equal(received, null);
});

test('a plain push passes and arrives whole, byte for byte, the pack included; shallow lines tolerated', async () => {
  received = null;
  const body = pkt(`shallow ${SHA('d')}`) + pkt(`${SHA('a')} ${SHA('b')} refs/heads/feature\0report-status side-band-64k agent=git/2.39\n`) + pkt(`${SHA('0')} ${SHA('c')} refs/heads/new\n`) + '0000PACK' + 'y'.repeat(20000);
  const r = await push(body);
  assert.equal(r.status, 200);
  assert.equal(received.url, '/o/r.git/git-receive-pack');
  assert.equal(received.body, body); // every byte: the head the gateway read and the rest it piped
});

test('a push of deletions alone sends no pack: refused before the body matters; a push whose body ends inside its list is refused', async () => {
  received = null;
  const r = await push(pkt(`${SHA('a')} ${SHA('b')} refs/heads/main\0report-status\n`)); // no flush, no pack
  assert.equal(r.status, 403);
  assert.match(JSON.parse(r.data).detail, /ended before its command list/);
  assert.equal(received, null);
});

test('an encoded push body, a body that is not a command list, and a list past the cap are refused', async () => {
  received = null;
  const enc = await push(pkt(`${SHA('a')} ${SHA('b')} refs/heads/main\n`) + '0000', { 'content-encoding': 'gzip' });
  assert.equal(enc.status, 403);
  assert.match(JSON.parse(enc.data).detail, /encoded push body/);
  const junk = await push('this is not a pkt-line');
  assert.equal(junk.status, 403);
  assert.match(JSON.parse(junk.data).detail, /could not be read as a receive-pack command list/);
  const big = await push(Array.from({ length: 12 }, (_, i) => pkt(`${SHA('a')} ${SHA('b')} refs/heads/branch-${i}\n`)).join('')); // 12 lines of 90 bytes, past the 512-byte cap, no flush
  assert.equal(big.status, 403);
  assert.match(JSON.parse(big.data).detail, /exceeds 512 bytes/);
  assert.equal(received, null);
});

// The pull-request edit gate (2026-10-19): PATCH on a pull request passes for a title or a body and is refused
// when it closes the pull request or moves its base, for every role; the body that passes arrives whole.
const patchPull = (body) => call({ method: 'PATCH', path: '/api/v3/repos/o/r/pulls/7', headers: { host: 'github.gw.test', 'x-test-role': 'claude', 'content-type': 'application/json' } }, body);

test('a pull-request edit that closes it or moves its base never passes; one of the title passes whole', async () => {
  for (const body of ['{"state":"closed"}', '{"title":"x","base":"main"}', '{"state":"open"}']) {
    received = null;
    const r = await patchPull(body);
    assert.equal(r.status, 403, body);
    assert.match(JSON.parse(r.data).detail, /closing a pull request or moving its base/);
    assert.equal(received, null);
    assert.equal(logs.at(-1).rule, 'pulls-patch');
  }
  received = null;
  const ok = await patchPull('{"title":"a title","body":"a body"}');
  assert.equal(ok.status, 200);
  assert.equal(received.url, '/repos/o/r/pulls/7');
  assert.equal(received.body, '{"title":"a title","body":"a body"}');
  const bad = await patchPull('[1,2]');
  assert.equal(bad.status, 403);
  const junk = await patchPull('not json');
  assert.equal(junk.status, 403);
});
