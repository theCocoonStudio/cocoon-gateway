import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createAgentApp } from '../../src/agent/server.js';
import { parseRules } from '../../src/agent/config.js';
import { loadTable, initialState, compose, hashOf } from '../../src/agent/scene.js';
import { createMemoryStore } from '../../src/agent/store.js';

const table = loadTable(JSON.parse(fs.readFileSync(new URL('../../agent/scene.json', import.meta.url), 'utf8')));
const rules = { ...parseRules(fs.readFileSync(new URL('../../agent/rules.md', import.meta.url), 'utf8'), { allowZeroPrices: true }), priceInput: 3, priceOutput: 15, turnsPerVisit: 2 };
const usage = { input_tokens: 1000, output_tokens: 100 };
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
let answers = [];
const model = async (request, { requestId }) => { assert.ok(requestId); if (!answers.length) throw new Error('no script'); return answers.shift(); };
let t = 1_700_000_000_000;
const now = () => t;
const store = createMemoryStore({ now, visitMs: 60_000, retentionMs: 600_000, snapshotMs: 600_000 });
const logs = [];
const app = createAgentApp({ table, rules, store, model, siteToken: 'site-secret', log: (l) => logs.push(l), now });
let server, port;
before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; });
after(() => { server.closeAllConnections(); server.close(); });

const call = (method, path, body, token = 'site-secret') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data })); });
  req.on('error', reject);
  if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
});
const events = (data) => data.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
const turnBody = (over = {}) => ({ clientId: 'client-0001', prompt: 'make it red', hash: null, backend: 'webgpu', version: 1, address: '203.0.113.5', time: '2026-10-19T12:00:00Z', page: '/', ...over });

test('no token or the wrong one: 401 and nothing else; the health check needs none', async () => {
  assert.equal((await call('POST', '/v1/scene/turn', turnBody(), null)).status, 401);
  assert.equal((await call('POST', '/v1/scene/turn', turnBody(), 'wrong')).status, 401);
  assert.equal((await call('GET', '/healthz', undefined, null)).status, 200);
});

test('a malformed body is 400 naming the fields; nothing is called', async () => {
  const r = await call('POST', '/v1/scene/turn', turnBody({ clientId: 'x', prompt: '', backend: 'cpu', version: 2, page: 7 }));
  assert.equal(r.status, 400);
  assert.deepEqual(JSON.parse(r.data).detail, 'fields missing or malformed: clientId, prompt, backend, version, page');
  assert.equal((await call('POST', '/v1/scene/turn', 'not json')).status, 400);
  assert.equal((await call('POST', '/v1/scene/turn', turnBody({ prompt: 'x'.repeat(501) }))).status, 400);
});

test('a turn streams its events and ends with done: the document, its hash, the refusal flag; the scene is then kept and served', async () => {
  answers = [
    { stop_reason: 'tool_use', usage, content: [use('a', 'set', { path: 'main.colour', value: '#ff0000' }), use('b', 'say', { text: 'Red.' })] },
    { stop_reason: 'end_turn', usage, content: [] },
  ];
  const r = await call('POST', '/v1/scene/turn', turnBody());
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/event-stream/);
  const ev = events(r.data);
  assert.deepEqual(ev.map((e) => e.type), ['change', 'say', 'done']);
  assert.equal(ev[2].refused, false);
  assert.equal(ev[2].document.materials[0].color, 0xff0000);
  assert.equal(ev[2].hash, ev[0].hash);
  assert.ok(ev.every((e) => e.requestId === ev[0].requestId));
  const got = await call('GET', '/v1/scene/client-0001');
  assert.equal(got.status, 200);
  assert.equal(JSON.parse(got.data).hash, ev[2].hash);
  const line = logs.at(-2); // the GET logged last
  assert.equal(line.clientId, 'client-0001');
  assert.equal(line.prompt, 'make it red');
  assert.equal(line.calls.length, 2);
  assert.equal(line.spend, 0.009);
  assert.equal(line.outcome, 'end');
});

test('a stale page is told first and the turn runs against the server\'s scene; an unknown client is 404 on GET; a snapshot is stored and served by its hash', async () => {
  answers = [{ stop_reason: 'end_turn', usage, content: [] }];
  const r = await call('POST', '/v1/scene/turn', turnBody({ hash: 'a'.repeat(64) }));
  const ev = events(r.data);
  assert.deepEqual(ev.map((e) => e.type), ['stale', 'done']);
  assert.equal(ev[0].document.materials[0].color, 0xff0000);
  assert.equal((await call('GET', '/v1/scene/client-9999')).status, 404);
  const snap = await call('POST', '/v1/snapshot', { clientId: 'client-0001' });
  assert.equal(snap.status, 200);
  const { hash } = JSON.parse(snap.data);
  assert.equal(hash, ev[1].hash);
  const got = await call('GET', `/v1/snapshot/${hash}`);
  assert.equal(got.status, 200);
  assert.equal(JSON.parse(got.data).document.materials[0].color, 0xff0000);
  assert.equal((await call('GET', `/v1/snapshot/${'b'.repeat(64)}`)).status, 404);
  assert.equal((await call('GET', '/v1/snapshot/short')).status, 400);
});

test('the turns per visit bound: the third turn of this visit is refused as bound; a new visit after the window is not', async () => {
  const r = await call('POST', '/v1/scene/turn', turnBody());
  const ev = events(r.data);
  assert.deepEqual(ev.map((e) => e.type), ['bound', 'done']);
  assert.equal(ev[0].bound, 'turns');
  assert.equal(ev[1].refused, true);
  t += 61_000;
  answers = [{ stop_reason: 'end_turn', usage, content: [] }];
  const again = events((await call('POST', '/v1/scene/turn', turnBody())).data);
  assert.deepEqual(again.map((e) => e.type), ['done']);
  assert.equal(again[0].refused, false);
});

test('a refusal by the agent, a bound inside the loop and a model error each end the stream with done and the flag', async () => {
  const client = 'client-0002';
  answers = [{ stop_reason: 'tool_use', usage, content: [use('a', 'refuse', { reason: 'nonsense' })] }];
  let ev = events((await call('POST', '/v1/scene/turn', turnBody({ clientId: client }))).data);
  assert.deepEqual(ev.map((e) => e.type), ['refused', 'done']);
  assert.equal(ev[1].refused, true);
  answers = []; // the model throws: no script
  t += 61_000;
  ev = events((await call('POST', '/v1/scene/turn', turnBody({ clientId: client }))).data);
  assert.deepEqual(ev.map((e) => e.type), ['error', 'done']);
  assert.equal(ev[1].refused, false, 'a model error is not the visitor\'s refusal');
  assert.equal(ev[1].hash, hashOf(compose(table, initialState(table, 'webgpu'))));
});

test('the daily spend ceiling turns the feature off with a bound', async () => {
  const tight = createAgentApp({ table, rules: { ...rules, spendPerDayUsd: 0.001 }, store, model, siteToken: 'site-secret', log: () => {}, now });
  const s = http.createServer(tight); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  const r = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: p, method: 'POST', path: '/v1/scene/turn', headers: { authorization: 'Bearer site-secret', 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }); req.on('error', reject); req.end(JSON.stringify(turnBody({ clientId: 'client-0003' }))); });
  s.closeAllConnections(); s.close();
  const ev = events(r);
  assert.deepEqual(ev.map((e) => e.type), ['bound', 'done']);
  assert.equal(ev[0].bound, 'spend');
});
