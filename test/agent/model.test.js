import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModel } from '../../src/agent/model.js';

// A fake upstream on the loopback: records what arrives, answers what the test sets.
let server, port, seen, answer;
before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { seen = { headers: req.headers, path: req.url, method: req.method, body: data }; res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(answer.body); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); });

test('connect pins the socket while the URL keeps the name the gateway routes on', async () => {
  answer = { status: 200, body: JSON.stringify({ id: 'msg_1', content: [] }) };
  const model = createModel({ url: 'http://anthropic.gw.example/v1/messages', token: 'site-token', requestId: 'req-9', connect: { host: '127.0.0.1', port } });
  const out = await model({ model: 'm', max_tokens: 1 });
  assert.deepEqual(out, { id: 'msg_1', content: [] });
  assert.equal(seen.headers.host, 'anthropic.gw.example', 'the Host header is the URL, not the address dialed');
  assert.equal(seen.path, '/v1/messages');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['proxy-authorization'], 'Bearer site-token');
  assert.equal(seen.headers['x-request-id'], 'req-9');
  assert.equal(seen.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(JSON.parse(seen.body), { model: 'm', max_tokens: 1 });
});

test('without connect the URL itself is dialed', async () => {
  answer = { status: 200, body: '{"ok":1}' };
  const out = await createModel({ url: `http://127.0.0.1:${port}/v1/messages`, token: 't' })({});
  assert.deepEqual(out, { ok: 1 });
  assert.equal(seen.headers.host, `127.0.0.1:${port}`);
});

test('a non-200 answer rejects with the status and the body\'s head; a non-JSON body rejects', async () => {
  answer = { status: 429, body: '{"error":"rate"}' };
  await assert.rejects(createModel({ url: `http://127.0.0.1:${port}/v1/messages`, token: 't' })({}), /the model answered 429: \{"error":"rate"\}/);
  answer = { status: 200, body: 'not json' };
  await assert.rejects(createModel({ url: `http://127.0.0.1:${port}/v1/messages`, token: 't' })({}), /not JSON/);
});

// The TLS branch the deploy runs on: the certificate is checked against the URL's name (the SNI server name)
// while the socket goes to the pinned address. A certificate for the name is made here with openssl, the
// way scripts/certs.sh makes the gateway's (ecparam, then req -x509 with a config file, so LibreSSL serves
// too); without openssl on the path the two cases are skipped and say so.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let tls;
before(async () => {
  if (!hasOpenssl) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tls-'));
  const cfg = path.join(dir, 'ext.cnf');
  fs.writeFileSync(cfg, '[req]\ndistinguished_name=dn\n[dn]\n[v3]\nbasicConstraints=CA:FALSE\nsubjectAltName=DNS:anthropic.gw.example\n');
  execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(dir, 'k.pem')], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-x509', '-new', '-key', path.join(dir, 'k.pem'), '-sha256', '-days', '1', '-subj', '/CN=anthropic.gw.example', '-config', cfg, '-extensions', 'v3', '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const key = fs.readFileSync(path.join(dir, 'k.pem'));
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  fs.rmSync(dir, { recursive: true });
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.3' }, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ host: req.headers.host, sni: req.socket.servername })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  tls = { server, port: server.address().port, cert };
});
after(() => { if (tls) { tls.server.closeAllConnections(); tls.server.close(); } });

test('over TLS the pinned socket presents the URL\'s name and the certificate is checked against it', { skip: !hasOpenssl && 'openssl is not on the path' }, async () => {
  const out = await createModel({ url: 'https://anthropic.gw.example/v1/messages', token: 't', ca: tls.cert, connect: { host: '127.0.0.1', port: tls.port } })({});
  assert.deepEqual(out, { host: 'anthropic.gw.example', sni: 'anthropic.gw.example' });
});

test('over TLS a URL whose name the certificate does not carry is refused before any request', { skip: !hasOpenssl && 'openssl is not on the path' }, async () => {
  await assert.rejects(createModel({ url: 'https://github.gw.example/v1/messages', token: 't', ca: tls.cert, connect: { host: '127.0.0.1', port: tls.port } })({}), (e) => e.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
});
