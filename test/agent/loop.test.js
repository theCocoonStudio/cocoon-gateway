import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runTurn, costOf } from '../../src/agent/loop.js';
import { loadTable, initialState, compose, hashOf } from '../../src/agent/scene.js';

const table = loadTable(JSON.parse(fs.readFileSync(new URL('../../agent/scene.json', import.meta.url), 'utf8')));
const ctx = { sayBound: 280, historyLimit: 50, callsPerTurn: 8, turnMs: 20_000, spendLeft: 1, prices: { input: 3, output: 15 }, model: 'test-model', system: 'the rules', maxTokens: 256 };
const usage = { input_tokens: 1000, output_tokens: 100 }; // 0.003 + 0.0015 = 0.0045 USD
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });
/** A scripted model: answers in order; records what it was asked. */
const scripted = (answers) => { const asked = []; const fn = async (request) => { asked.push(structuredClone(request)); if (!answers.length) throw new Error('the script ran out'); return answers.shift(); }; fn.asked = asked; return fn; };
const run = (model, over = {}) => { const events = []; const log = []; return runTurn({ table, state: initialState(table, 'webgpu'), messages: [], prompt: 'make it red', ctx: { ...ctx, ...over }, model, emit: (e) => events.push(e), log: (l) => log.push(l), ...over.extra }).then((r) => ({ ...r, events, log })); };

test('costOf prices the usage per million tokens', () => {
  assert.equal(costOf(usage, { input: 3, output: 15 }), 0.0045);
  assert.equal(costOf(undefined, { input: 3, output: 15 }), 0);
});

test('a turn of three changes and a word: the events in order with the hash after each, the conversation extended, the prompt a JSON field of the user message', async () => {
  const model = scripted([
    { stop_reason: 'tool_use', usage, content: [use('a', 'set', { path: 'main.colour', value: '#ff0000' }), use('b', 'set', { path: 'main.roughness', value: 0.2 })] },
    { stop_reason: 'tool_use', usage, content: [use('c', 'add', { kind: 'point', slot: 'light.key' }), use('d', 'say', { text: 'Red it is, with a point light.' })] },
    { stop_reason: 'end_turn', usage, content: [text('')] },
  ]);
  const r = await run(model);
  assert.equal(r.ended, 'end');
  assert.equal(r.calls, 4);
  assert.ok(Math.abs(r.spend - 0.0135) < 1e-9, `spend ${r.spend}`);
  assert.deepEqual(r.events.map((e) => e.type), ['change', 'change', 'change', 'say']);
  assert.equal(r.events[0].change, 'set');
  assert.deepEqual(r.events[0].input, { path: 'main.colour', value: '#ff0000' });
  assert.equal(r.events[2].result, 'slot:light.key');
  assert.equal(r.events[2].hash, hashOf(compose(table, r.state)));
  // the renderer's form (stream.1 amended 2026-10-29): before, the writes of a set, the node and pointer of an add
  const initialHash = hashOf(compose(table, initialState(table, 'webgpu')));
  assert.equal(r.events[0].before, initialHash);
  assert.equal(r.events[1].before, r.events[0].hash);
  assert.equal(r.events[2].before, r.events[1].hash);
  assert.deepEqual(r.events[0].writes, [{ pointer: '/materials/0/color', value: 0xff0000 }]);
  assert.deepEqual(r.events[1].writes, [{ pointer: '/materials/0/roughness', value: 0.2 }]);
  assert.equal(r.events[2].node.uuid, 'slot:light.key');
  assert.equal(r.events[2].node.type, 'PointLight');
  assert.equal(r.events[2].node.name, 'light.key');
  assert.equal(r.events[2].pointer, '/object/children');
  assert.equal(r.events[2].writes, undefined);
  assert.equal(r.state.values['main.colour'], '#ff0000');
  assert.equal(r.state.slots['light.key'].kind, 'point');
  assert.equal(model.asked[0].messages.length, 1);
  assert.deepEqual(JSON.parse(model.asked[0].messages[0].content[0].text), { visitor_prompt: 'make it red' });
  assert.equal(model.asked[0].system, 'the rules');
  assert.equal(model.asked[0].tools.length, 8);
  assert.equal(model.asked[1].messages.length, 3); // user, assistant, tool results
  assert.deepEqual(model.asked[1].messages[2].content.map((c) => c.type), ['tool_result', 'tool_result']);
  assert.equal(r.messages.length, 6);
});

test('a refusal ends the turn with its event; what follows in the same answer is not applied', async () => {
  const model = scripted([{ stop_reason: 'tool_use', usage, content: [use('a', 'refuse', { reason: 'abuse' }), use('b', 'set', { path: 'main.colour', value: '#ff0000' })] }]);
  const r = await run(model);
  assert.equal(r.ended, 'refused');
  assert.equal(r.refusal, 'abuse');
  assert.deepEqual(r.events, [{ type: 'refused', reason: 'abuse' }]);
  assert.equal(r.state.values['main.colour'], '#2a9d8f');
  assert.equal(r.calls, 1);
});

test('a tool refusal goes back as an error result and the model corrects within the turn', async () => {
  const model = scripted([
    { stop_reason: 'tool_use', usage, content: [use('a', 'set', { path: 'main.roughness', value: 7 })] },
    { stop_reason: 'tool_use', usage, content: [use('b', 'set', { path: 'main.roughness', value: 0.7 })] },
    { stop_reason: 'end_turn', usage, content: [] },
  ]);
  const r = await run(model);
  assert.equal(r.ended, 'end');
  assert.equal(model.asked[1].messages[2].content[0].is_error, true);
  assert.match(model.asked[1].messages[2].content[0].content, /main\.roughness/);
  assert.equal(r.events.length, 1);
  assert.equal(r.state.values['main.roughness'], 0.7);
});

test('the call cap ends the turn with a bound event; the ninth call is not applied', async () => {
  const uses = Array.from({ length: 9 }, (_, i) => use(`u${i}`, 'set', { path: 'main.roughness', value: i / 10 }));
  const model = scripted([{ stop_reason: 'tool_use', usage, content: uses }]);
  const r = await run(model);
  assert.equal(r.ended, 'bound:calls');
  assert.equal(r.calls, 8);
  assert.equal(r.state.values['main.roughness'], 0.7);
  assert.equal(r.events.at(-1).type, 'bound');
  assert.equal(r.events.at(-1).bound, 'calls');
});

test('the time cap ends the turn before the next model call', async () => {
  let t = 0;
  const now = () => { t += 15_000; return t; }; // every look at the clock is fifteen seconds later
  const model = scripted([{ stop_reason: 'tool_use', usage, content: [use('a', 'read', {})] }, { stop_reason: 'end_turn', usage, content: [] }]);
  const r = await run(model, { extra: { now } });
  assert.equal(r.ended, 'bound:time');
  assert.equal(model.asked.length, 1);
  assert.deepEqual(r.events, [{ type: 'bound', bound: 'time' }]);
});

test('the spend ceiling ends the turn before the next model call once reached', async () => {
  const model = scripted([{ stop_reason: 'tool_use', usage, content: [use('a', 'read', {})] }, { stop_reason: 'end_turn', usage, content: [] }]);
  const r = await run(model, { spendLeft: 0.004 });
  assert.equal(r.ended, 'bound:spend');
  assert.equal(model.asked.length, 1);
  assert.equal(r.spend, 0.0045);
});

test('text outside a tool call is dropped and logged, never an event; a model error ends the turn as such with the state as it was', async () => {
  const model = scripted([{ stop_reason: 'end_turn', usage, content: [text('Hello there, I changed it to red.')] }]);
  const r = await run(model);
  assert.equal(r.ended, 'end');
  assert.deepEqual(r.events, []);
  assert.ok(r.log.some((l) => l.event === 'dropped_text' && l.chars === 33));
  const failing = async () => { throw new Error('502 from the gateway'); };
  const e = await run(failing);
  assert.equal(e.ended, 'error');
  assert.deepEqual(e.events, []);
  assert.equal(e.state.values['main.colour'], '#2a9d8f');
  assert.ok(e.log.some((l) => l.event === 'model_error'));
});

test("the renderer's form of a remove (the uuid and the slot's pointer), of an undo and of a reset (the whole document), and of a set that removes a key (fog none: null)", async () => {
  const model = scripted([
    { stop_reason: 'tool_use', usage, content: [use('a', 'add', { kind: 'point', slot: 'light.fill' }), use('b', 'set', { path: 'fog', value: 'thin' })] },
    { stop_reason: 'tool_use', usage, content: [use('c', 'remove', { id: 'slot:light.fill' }), use('d', 'set', { path: 'fog', value: 'none' })] },
    { stop_reason: 'tool_use', usage, content: [use('e', 'undo', { n: 1 }), use('f', 'reset', {})] },
    { stop_reason: 'end_turn', usage, content: [] },
  ]);
  const r = await run(model);
  const [added, fogOn, removed, fogOff, undone, reset] = r.events;
  assert.equal(added.pointer, '/object/children');
  assert.deepEqual(fogOn.writes, [{ pointer: '/object/fog', value: { type: 'Fog', color: 1053720, near: 5, far: 30 } }]);
  assert.deepEqual({ uuid: removed.uuid, pointer: removed.pointer }, { uuid: 'slot:light.fill', pointer: '/object/children' });
  assert.equal(removed.before, fogOn.hash);
  assert.deepEqual(fogOff.writes, [{ pointer: '/object/fog', value: null }]);
  assert.equal(typeof undone.document, 'object');
  assert.equal(hashOf(undone.document), undone.hash);
  assert.equal(hashOf(reset.document), reset.hash);
  assert.equal(reset.hash, hashOf(compose(table, initialState(table, 'webgpu'))));
});
