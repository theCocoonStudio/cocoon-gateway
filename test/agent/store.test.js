import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/agent/store.js';

const clock = (start = 1_700_000_000_000) => { let t = start; const now = () => t; now.advance = (ms) => { t += ms; }; return now; };

test('a scene is kept under its client id; a conversation is fresh after the visit window; turns and spend accrue', () => {
  const now = clock();
  const store = createMemoryStore({ now, visitMs: 60_000, retentionMs: 600_000, snapshotMs: 300_000 });
  assert.equal(store.getScene('c1'), null);
  store.putScene('c1', { values: { a: 1 } });
  assert.deepEqual(store.getScene('c1'), { values: { a: 1 } });
  const conv = store.getConversation('c1');
  assert.deepEqual(conv.messages, []);
  store.putConversation('c1', { ...conv, messages: ['m'], turns: 1 });
  store.addSpend('c1', 0.01);
  now.advance(30_000);
  assert.equal(store.getConversation('c1').turns, 1);
  assert.equal(store.getConversation('c1').spend, 0.01);
  assert.equal(store.spendOfDay(), 0.01);
  now.advance(31_000);
  assert.equal(store.getConversation('c1').turns, 0, 'the window passed since the last turn: a fresh conversation over the kept scene');
  assert.deepEqual(store.getScene('c1'), { values: { a: 1 } });
});

test('retention: a scene not seen for the period goes, with its conversation; a snapshot not read goes; the day\'s spend resets with the day', () => {
  const now = clock(Date.UTC(2026, 9, 19, 23, 59, 0));
  const store = createMemoryStore({ now, visitMs: 60_000, retentionMs: 1000, snapshotMs: 500 });
  store.putScene('c1', { values: {} });
  store.putSnapshot('a'.repeat(64), { doc: 1 });
  store.addSpend('c1', 2);
  assert.equal(store.spendOfDay(), 2);
  now.advance(120_000); // past midnight UTC
  assert.equal(store.spendOfDay(), 0);
  assert.deepEqual(store.getSnapshot('a'.repeat(64)), { doc: 1 }); // read now: its clock restarts
  now.advance(600);
  assert.deepEqual(store.sweep(), { scenesGone: 1, snapshotsGone: 1 });
  assert.equal(store.getScene('c1'), null);
  assert.equal(store.getSnapshot('a'.repeat(64)), null);
  assert.deepEqual(store.size(), { scenes: 0, conversations: 0, snapshots: 0 });
});
