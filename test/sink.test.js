import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSink, tableOf, rowOf, insertStatement } from '../src/sink.js';

// Timers under the test's control: nothing fires unless the test fires it.
function fakeTimers() {
  const pending = new Map(); let next = 1;
  return {
    timers: { set: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; }, clear: (id) => pending.delete(id) },
    pending,
    fire() { const [id, t] = [...pending.entries()][0]; pending.delete(id); t.fn(); return t.ms; },
  };
}
const request = (n) => ({ ts: 't', id: `id-${n}`, role: 'claude', upstream: 'github', method: 'GET', path: '/p', status: 200, ms: 5, bytes: 10, rule: 0, peer: '10.0.0.1' });
const refusal = { ts: 't', id: 'id-r', kind: 'policy', host: 'github.gw.test', role: 'claude', upstream: 'github', method: 'DELETE', path: '/x', status: 403, detail: 'no rule allows this request', peer: '10.0.0.1' };
const tls = { ts: 't', tls: 'socket hang up', from: '10.0.0.2' };

test('a line goes to requests when the policy allowed it and the upstream answered; everything else is a refusal', () => {
  assert.equal(tableOf(request(1)), 'requests');
  assert.equal(tableOf(refusal), 'refusals');
  assert.equal(tableOf(tls), 'refusals');
  assert.equal(tableOf({ ts: 't', id: 'x', kind: 'log', status: 503 }), 'refusals');
  assert.deepEqual(rowOf(request(1)), ['id-1', 't', 'claude', 'github', 'GET', '/p', 200, 5, 10, 0, '10.0.0.1']);
  assert.deepEqual(rowOf(tls), [null, 't', 'tls', null, null, null, null, null, null, 'socket hang up', '10.0.0.2']);
  assert.deepEqual(rowOf(refusal)[2], 'policy');
});

test('one INSERT per table per batch, every value a parameter', () => {
  const s = insertStatement('requests', [rowOf(request(1)), rowOf(request(2))]);
  assert.equal(s.text, 'INSERT INTO requests (id, ts, role, upstream, method, path, status, ms, bytes, rule, peer) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11), ($12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)');
  assert.equal(s.values.length, 22);
  assert.equal(s.values[0], 'id-1');
  assert.equal(s.values[11], 'id-2');
});

test('lines wait for the timer, then one insert per table, in order', async () => {
  const calls = []; const ft = fakeTimers();
  const sink = createSink({ query: async (text, values) => { calls.push({ text, values }); }, flushMs: 1000, batch: 100, timers: ft.timers, report: () => {} });
  assert.equal(sink.write(request(1)), true);
  assert.equal(sink.write(refusal), true);
  assert.equal(sink.write(request(2)), true);
  assert.equal(calls.length, 0, 'nothing inserted before the timer');
  assert.equal(ft.fire(), 1000);
  await sink.flush();
  assert.equal(calls.length, 3, 'requests, refusals, requests: the order is kept, so a table switch starts a new insert');
  assert.match(calls[0].text, /^INSERT INTO requests/); assert.equal(calls[0].values[0], 'id-1');
  assert.match(calls[1].text, /^INSERT INTO refusals/);
  assert.match(calls[2].text, /^INSERT INTO requests/); assert.equal(calls[2].values[0], 'id-2');
  assert.deepEqual([sink.state().inserted, sink.state().queued, sink.state().failures], [3, 0, 0]);
});

test('the batch size flushes without waiting for the timer', async () => {
  const calls = []; const ft = fakeTimers();
  const sink = createSink({ query: async (text, values) => { calls.push({ text, values }); }, flushMs: 1000, batch: 2, timers: ft.timers, report: () => {} });
  sink.write(request(1)); sink.write(request(2));
  await sink.flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].values.length, 22);
  assert.equal(ft.pending.size, 0, 'the pending timer was cleared by the immediate flush');
});

test('a failed insert keeps its lines in order, retries with a doubling delay, and recovers', async () => {
  const calls = []; const ft = fakeTimers(); const reports = [];
  let fail = 2;
  const sink = createSink({ query: async (text, values) => { calls.push(values[0]); if (fail-- > 0) throw new Error('connection refused'); }, flushMs: 1000, batch: 100, maxBackoffMs: 30_000, timers: ft.timers, report: (l) => reports.push(l) });
  sink.write(request(1)); sink.write(request(2));
  ft.fire(); await sink.flush();
  assert.deepEqual([sink.state().failures, sink.state().queued, sink.state().lastError], [1, 2, 'connection refused']);
  assert.equal(reports[0].sink, 'insert failed');
  assert.equal(sink.write(request(3)), true, 'still accepting while the database is away');
  assert.equal(ft.pending.size, 1, 'one retry timer');
  assert.equal(ft.fire(), 2000, 'the first retry after 2 s'); await sink.flush();
  assert.equal(sink.state().failures, 2);
  assert.equal(ft.fire(), 4000, 'the second after 4 s'); await sink.flush();
  assert.deepEqual([sink.state().failures, sink.state().queued, sink.state().inserted, sink.state().lastError], [0, 0, 3, null]);
  assert.equal(calls[calls.length - 1], 'id-1', 'the retried insert begins with the first line kept');
});

test('a full queue stops accepting: the line is refused and counted, and acceptance returns after a flush', async () => {
  const ft = fakeTimers();
  const sink = createSink({ query: async () => {}, flushMs: 1000, batch: 100, capacity: 2, timers: ft.timers, report: () => {} });
  assert.equal(sink.write(request(1)), true);
  assert.equal(sink.write(request(2)), true);
  assert.equal(sink.accepting(), false);
  assert.equal(sink.write(request(3)), false);
  assert.equal(sink.state().dropped, 1);
  ft.fire(); await sink.flush();
  assert.equal(sink.accepting(), true);
  assert.equal(sink.write(request(4)), true);
});

test('close flushes what is queued and refuses what comes after; probe is one round trip', async () => {
  const calls = []; const ft = fakeTimers();
  const sink = createSink({ query: async (text) => { calls.push(text); }, timers: ft.timers, report: () => {} });
  await sink.probe();
  assert.equal(calls[0], 'SELECT 1');
  sink.write(request(1));
  await sink.close();
  assert.equal(calls.length, 2);
  assert.equal(ft.pending.size, 0, 'no timer left behind');
  assert.equal(sink.write(request(2)), false);
  assert.equal(sink.state().dropped, 1);
});

test('the sink refuses to exist without a query function', () => {
  assert.throws(() => createSink({}), /a query function is required/);
});
