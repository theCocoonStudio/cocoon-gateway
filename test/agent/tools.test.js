import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTable, initialState, readView, compose, hashOf } from '../../src/agent/scene.js';
import { TOOLS, REFUSAL_REASONS, applyTool } from '../../src/agent/tools.js';

const table = loadTable(JSON.parse(fs.readFileSync(new URL('../../agent/scene.json', import.meta.url), 'utf8')));
const ctx = { sayBound: 20, historyLimit: 3 };
const gl = initialState(table, 'webgl');
const gpu = initialState(table, 'webgpu');

// Every call goes through here: the state handed in is deep-equal before and after (tools.1: pure).
const call = (state, name, input, c = ctx, t = table) => {
  const before = structuredClone(state);
  const out = applyTool(t, state, name, input, c);
  assert.deepEqual(state, before, `${name} mutated the state`);
  return out;
};
const ok = (state, name, input, c, t) => {
  const out = call(state, name, input, c, t);
  assert.equal(out.ok, true, `${name} ${JSON.stringify(input)} refused: ${out.result}`);
  return out;
};
const refused = (state, name, input, re, c, t) => {
  const out = call(state, name, input, c, t);
  assert.equal(out.ok, false, `${name} ${JSON.stringify(input)} was accepted: ${out.result}`);
  assert.equal(out.state, state, 'a refusal hands the state back as it was');
  assert.match(out.result, re);
  return out;
};
const entry = (state) => ({ values: state.values, slots: state.slots });

test('the eight tools in the Messages API\'s shape: a name, one sentence, a closed object schema; every name is a tool applyTool knows', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['read', 'set', 'add', 'remove', 'undo', 'reset', 'say', 'refuse']);
  for (const t of TOOLS) {
    assert.match(t.description, /^[A-Z][^]*\.$/, `${t.name}: a sentence`);
    assert.doesNotMatch(t.description, /\. [A-Z]/, `${t.name}: one sentence`);
    assert.equal(t.input_schema.type, 'object');
    assert.equal(t.input_schema.additionalProperties, false);
    assert.ok(Array.isArray(t.input_schema.required));
    for (const r of t.input_schema.required) assert.ok(Object.hasOwn(t.input_schema.properties, r), `${t.name}: required ${r} is a property`);
    assert.doesNotMatch(applyTool(table, gl, t.name, {}, ctx).result, /unknown tool/);
  }
  assert.deepEqual(TOOLS.find((t) => t.name === 'refuse').input_schema.properties.reason.enum, REFUSAL_REASONS);
  assert.deepEqual(REFUSAL_REASONS, ['abuse', 'nonsense', 'out_of_scope', 'unsafe']);
  assert.equal(TOOLS.find((t) => t.name === 'undo').input_schema.properties.n.type, 'integer');
});

test('read: the state unchanged, the result the JSON of the view', () => {
  const out = ok(gl, 'read', {});
  assert.equal(out.state, gl);
  assert.deepEqual(JSON.parse(out.result), readView(table, gl));
  assert.equal(applyTool(table, gl, 'read', undefined, ctx).ok, true, 'no input is an empty input');
  const withKey = ok(gpu, 'add', { kind: 'area', slot: 'light.key' }).state;
  assert.deepEqual(JSON.parse(ok(withKey, 'read', {}).result).slots['light.key'].node, { id: 'slot:light.key', kind: 'area', values: { intensity: 1, colour: '#ffffff' } });
});

test('set accepts a value of each kind within its bounds, off the step grid too, and records the previous state', () => {
  const s1 = ok(gl, 'set', { path: 'main.roughness', value: 0.25 });
  assert.equal(s1.result, 'set main.roughness to 0.25');
  assert.notEqual(s1.state, gl, 'a new object');
  assert.deepEqual(s1.state, { version: 1, backend: 'webgl', values: { ...gl.values, 'main.roughness': 0.25 }, slots: gl.slots, history: [entry(gl)] });
  assert.equal(ok(gl, 'set', { path: 'main.roughness', value: 0.33 }).state.values['main.roughness'], 0.33, 'the step is advice, not a grid');
  assert.equal(ok(gl, 'set', { path: 'main.roughness', value: 0 }).state.values['main.roughness'], 0, 'min is within');
  assert.equal(ok(gl, 'set', { path: 'main.roughness', value: 1 }).state.values['main.roughness'], 1, 'max is within');
  assert.equal(ok(gl, 'set', { path: 'main.size', value: 2.5 }).result, 'set main.size to 2.5');
  const fog = ok(gl, 'set', { path: 'fog', value: 'thin' });
  assert.equal(fog.result, 'set fog to thin');
  assert.equal(fog.state.values.fog, 'thin');
  const colour = ok(gl, 'set', { path: 'main.colour', value: '#ff8800' });
  assert.equal(colour.result, 'set main.colour to #ff8800');
  assert.equal(compose(table, colour.state).materials[0].color, 0xff8800);
  const visible = ok(gl, 'set', { path: 'main.visible', value: false });
  assert.equal(visible.result, 'set main.visible to false');
  assert.equal(visible.state.values['main.visible'], false);
  const s2 = ok(s1.state, 'set', { path: 'fog', value: 'thick' });
  assert.deepEqual(s2.state.values, { ...gl.values, 'main.roughness': 0.25, fog: 'thick' }, 'the first value kept');
  assert.deepEqual(s2.state.history, [entry(gl), entry(s1.state)]);
});

test('set refuses an unknown path, a value of the wrong kind, a number outside its bounds, an enum value not in the set, a colour not #rrggbb; each refusal names what is right', () => {
  refused(gl, 'set', { path: 'main.shader', value: 1 }, /^no path "main\.shader"; the paths are background, main\.colour, main\.emissive, main\.roughness, main\.metalness, main\.size, ambient\.intensity, ambient\.colour, fog, main\.visible$/);
  refused(gl, 'set', { path: 42, value: 1 }, /^no path 42; the paths are/);
  refused(gl, 'set', { value: 1 }, /^no path undefined; the paths are/);
  refused(gl, 'set', { path: 'main.roughness', value: 1.01 }, /^main\.roughness takes a number from 0 to 1 \(step 0\.05\), not 1\.01$/);
  refused(gl, 'set', { path: 'main.roughness', value: -0.1 }, /not -0\.1$/);
  refused(gl, 'set', { path: 'main.roughness', value: '0.5' }, /takes a number from 0 to 1 \(step 0\.05\), not "0\.5"$/);
  refused(gl, 'set', { path: 'main.roughness' }, /not undefined$/);
  refused(gl, 'set', { path: 'main.size', value: 3.1 }, /^main\.size takes a number from 0\.5 to 3 \(step 0\.1\), not 3\.1$/);
  refused(gl, 'set', { path: 'ambient.intensity', value: true }, /^ambient\.intensity takes a number from 0 to 2 \(step 0\.1\), not true$/);
  refused(gl, 'set', { path: 'fog', value: 'dense' }, /^fog takes one of none, thin, thick, not "dense"$/);
  refused(gl, 'set', { path: 'fog', value: 1 }, /^fog takes one of none, thin, thick, not 1$/);
  refused(gl, 'set', { path: 'main.colour', value: '#FF0000' }, /^main\.colour takes a colour as #rrggbb in lower-case hex, not "#FF0000"$/);
  refused(gl, 'set', { path: 'main.colour', value: 'red' }, /not "red"$/);
  refused(gl, 'set', { path: 'main.colour', value: '#fff' }, /not "#fff"$/);
  refused(gl, 'set', { path: 'main.colour', value: 0xff0000 }, /^main\.colour takes a colour as #rrggbb in lower-case hex, not 16711680$/);
  refused(gl, 'set', { path: 'background', value: '#0000000' }, /not "#0000000"$/);
  refused(gl, 'set', { path: 'main.visible', value: 'true' }, /^main\.visible takes true or false, not "true"$/);
  refused(gl, 'set', { path: 'main.visible', value: 1 }, /^main\.visible takes true or false, not 1$/);
});

test('the history is bounded at historyLimit, the oldest dropped', () => {
  let s = gl;
  for (const v of [0.2, 0.3, 0.4, 0.5, 0.6]) s = ok(s, 'set', { path: 'main.metalness', value: v }).state;
  assert.equal(s.values['main.metalness'], 0.6);
  assert.equal(s.history.length, 3);
  assert.deepEqual(s.history.map((h) => h.values['main.metalness']), [0.3, 0.4, 0.5], 'the two oldest states are gone');
  let one = gl;
  for (const v of [0.2, 0.3]) one = ok(one, 'set', { path: 'main.metalness', value: v }, { sayBound: 20, historyLimit: 1 }).state;
  assert.deepEqual(one.history.map((h) => h.values['main.metalness']), [0.2]);
  const none = ok(gl, 'set', { path: 'main.metalness', value: 0.2 }, { sayBound: 20, historyLimit: 0 }).state;
  assert.deepEqual(none.history, [], 'a limit of zero keeps nothing');
});

test('add places a kind the slot accepts into an empty slot with the kind\'s defaults, for the client\'s tier; refuses an unknown slot, a full slot, a kind not accepted, a webgpu kind on webgl', () => {
  const key = ok(gl, 'add', { kind: 'directional', slot: 'light.key' });
  assert.equal(key.result, 'slot:light.key');
  assert.deepEqual(key.state, { version: 1, backend: 'webgl', values: gl.values, slots: { 'light.key': { id: 'slot:light.key', kind: 'directional', values: { intensity: 1, colour: '#ffffff' } }, 'light.fill': null }, history: [entry(gl)] });
  const both = ok(key.state, 'add', { kind: 'point', slot: 'light.fill' });
  assert.equal(both.result, 'slot:light.fill');
  assert.deepEqual(both.state.slots['light.fill'], { id: 'slot:light.fill', kind: 'point', values: { intensity: 1, colour: '#ffffff' } });
  assert.deepEqual(both.state.history, [entry(gl), entry(key.state)]);
  const doc = compose(table, both.state);
  assert.equal(doc.object.children.length, 4);
  assert.deepEqual(doc.object.children.slice(2).map((n) => n.type), ['DirectionalLight', 'PointLight']);
  assert.notEqual(hashOf(doc), hashOf(compose(table, gl)));
  refused(gl, 'add', { kind: 'directional', slot: 'light.rim' }, /^no slot "light\.rim"; the slots are light\.key, light\.fill$/);
  refused(gl, 'add', { kind: 'directional' }, /^no slot undefined; the slots are/);
  refused(key.state, 'add', { kind: 'point', slot: 'light.key' }, /^slot light\.key holds slot:light\.key; remove it first or use an empty slot$/);
  refused(gl, 'add', { kind: 'spot', slot: 'light.key' }, /^slot light\.key does not accept "spot"; it accepts directional, point$/);
  refused(gl, 'add', { slot: 'light.key' }, /^slot light\.key does not accept undefined; it accepts directional, point$/);
  refused(gl, 'add', { kind: 'area', slot: 'light.key' }, /^kind area is of the webgpu tier and this client's backend is webgl; slot light\.key accepts directional, point here$/);
  const area = ok(gpu, 'add', { kind: 'area', slot: 'light.fill' });
  assert.equal(area.result, 'slot:light.fill');
  assert.deepEqual(area.state.slots['light.fill'], { id: 'slot:light.fill', kind: 'area', values: { intensity: 1, colour: '#ffffff' } });
  assert.equal(compose(table, area.state).object.children[2].type, 'RectAreaLight');
  refused(gpu, 'add', { kind: 'spot', slot: 'light.key' }, /it accepts directional, point, area$/);
});

test('remove empties the slot the node holds; refuses an id that names no node and a fixed slot', () => {
  const key = ok(gl, 'add', { kind: 'directional', slot: 'light.key' }).state;
  const out = ok(key, 'remove', { id: 'slot:light.key' });
  assert.equal(out.result, 'light.key');
  assert.deepEqual(out.state.slots, { 'light.key': null, 'light.fill': null });
  assert.deepEqual(out.state.values, gl.values);
  assert.deepEqual(out.state.history, [entry(gl), entry(key)]);
  assert.equal(hashOf(compose(table, out.state)), hashOf(compose(table, gl)));
  refused(key, 'remove', { id: 'slot:nothing' }, /^no node "slot:nothing"; the nodes are slot:light\.key$/);
  refused(key, 'remove', {}, /^no node undefined; the nodes are slot:light\.key$/);
  refused(gl, 'remove', { id: 'slot:light.key' }, /^no node "slot:light\.key"; no slot is filled$/);
  const fixedTable = loadTable((() => { const t = structuredClone(table); t.slots['light.key'].fixed = true; return t; })());
  assert.equal(readView(fixedTable, key).slots['light.key'].fixed, true);
  refused(key, 'remove', { id: 'slot:light.key' }, /^slot light\.key is fixed: the template carries its node and it cannot be removed$/, ctx, fixedTable);
  assert.equal(ok(key, 'remove', { id: 'slot:light.key' }).ok, true, 'the same node leaves an unfixed slot');
});

test('undo takes n from 1 to the history\'s length and returns that state with the current one added to the history, so an undo can be undone', () => {
  const s1 = ok(gl, 'set', { path: 'main.roughness', value: 0.25 }).state;
  const s2 = ok(s1, 'set', { path: 'fog', value: 'thin' }).state;
  assert.equal(s2.history.length, 2);
  refused(s2, 'undo', { n: 0 }, /^undo takes an integer n from 1 to 2, not 0$/);
  refused(s2, 'undo', { n: 3 }, /^undo takes an integer n from 1 to 2, not 3$/);
  refused(s2, 'undo', { n: '1' }, /not "1"$/);
  refused(s2, 'undo', { n: 1.5 }, /not 1\.5$/);
  refused(s2, 'undo', {}, /not undefined$/);
  refused(gl, 'undo', { n: 1 }, /^the history is empty; undo needs at least one earlier state$/);
  const u1 = ok(s2, 'undo', { n: 1 });
  assert.equal(u1.result, 'undone 1');
  assert.deepEqual(u1.state.values, s1.values);
  assert.deepEqual(u1.state.slots, s1.slots);
  assert.deepEqual(u1.state.history, [entry(gl), entry(s1), entry(s2)], 'a list, not a stack: the current state joins the history');
  assert.equal(hashOf(compose(table, u1.state)), hashOf(compose(table, s1)), 'the same values, the same hash');
  const u2 = ok(s2, 'undo', { n: 2 });
  assert.deepEqual(u2.state.values, gl.values);
  assert.deepEqual(u2.state.history, [entry(gl), entry(s1), entry(s2)]);
  const back = ok(u1.state, 'undo', { n: 1 });
  assert.deepEqual(back.state.values, s2.values, 'the undo undone');
  assert.deepEqual(back.state.history, [entry(s1), entry(s2), entry(u1.state)], 'bounded at the limit');
  assert.equal(hashOf(compose(table, back.state)), hashOf(compose(table, s2)));
  assert.equal(back.state.version, 1);
  assert.equal(back.state.backend, 'webgl');
});

test('reset returns the template\'s state for the same client, the history gaining the current state', () => {
  const s = ok(ok(gpu, 'set', { path: 'main.colour', value: '#123456' }).state, 'add', { kind: 'area', slot: 'light.key' }).state;
  const r = ok(s, 'reset', {});
  assert.equal(r.result, 'reset to the template');
  assert.deepEqual(r.state, { ...gpu, history: [...s.history, entry(s)] });
  assert.equal(r.state.backend, 'webgpu');
  assert.equal(hashOf(compose(table, r.state)), hashOf(compose(table, gpu)));
  const again = ok(r.state, 'undo', { n: 1 });
  assert.deepEqual(again.state.values, s.values, 'a reset can be undone');
  assert.deepEqual(again.state.slots, s.slots);
});

test('say: a string of at most sayBound code points with no control character but the newline; the state unchanged', () => {
  const atBound = ok(gl, 'say', { text: `${'a'.repeat(19)}\u{1F600}` });
  assert.equal(atBound.result, 'said');
  assert.equal(atBound.state, gl);
  assert.equal(ok(gl, 'say', { text: '\u{1F600}'.repeat(20) }).ok, true, 'twenty code points in forty UTF-16 units');
  assert.equal(ok(gl, 'say', { text: 'two lines\nof text' }).ok, true);
  refused(gl, 'say', { text: 'a'.repeat(21) }, /^the text is 21 characters; the bound is 20$/);
  refused(gl, 'say', { text: '\u{1F600}'.repeat(21) }, /^the text is 21 characters; the bound is 20$/);
  refused(gl, 'say', { text: 'a\tb' }, /^the text carries a control character; plain text with newlines only$/);
  refused(gl, 'say', { text: 'a\rb' }, /control character/);
  refused(gl, 'say', { text: 'a\u0000b' }, /control character/);
  refused(gl, 'say', { text: 'a\u001bb' }, /control character/);
  refused(gl, 'say', { text: 'a\u0085b' }, /control character/);
  refused(gl, 'say', { text: 42 }, /^say takes one string of plain text$/);
  refused(gl, 'say', {}, /^say takes one string of plain text$/);
  assert.equal(ok(gl, 'say', { text: 'hello' }, { sayBound: 5, historyLimit: 3 }).ok, true, 'the bound is the ctx\'s');
  refused(gl, 'say', { text: 'hello!' }, /^the text is 6 characters; the bound is 5$/, { sayBound: 5, historyLimit: 3 });
});

test('refuse: a reason from the enum ends the turn and changes no state; any other reason is itself refused naming the enum', () => {
  for (const reason of REFUSAL_REASONS) {
    const out = ok(gl, 'refuse', { reason });
    assert.equal(out.result, `refused: ${reason}`);
    assert.equal(out.state, gl);
  }
  refused(gl, 'refuse', { reason: 'rude' }, /^unknown reason "rude"; the reasons are abuse, nonsense, out_of_scope, unsafe$/);
  refused(gl, 'refuse', { reason: 'ABUSE' }, /^unknown reason "ABUSE"/);
  refused(gl, 'refuse', {}, /^unknown reason undefined; the reasons are/);
});

test('an unknown tool is a refusal naming the tools; a bad ctx is the service\'s error, thrown', () => {
  refused(gl, 'delete', {}, /^unknown tool "delete"; the tools are read, set, add, remove, undo, reset, say, refuse$/);
  refused(gl, 7, {}, /^unknown tool 7; the tools are/);
  refused(gl, 'constructor', {}, /^unknown tool "constructor"/);
  assert.throws(() => applyTool(table, gl, 'read', {}, {}), TypeError);
  assert.throws(() => applyTool(table, gl, 'read', {}, { sayBound: 20 }), /ctx needs integer sayBound and historyLimit/);
  assert.throws(() => applyTool(table, gl, 'read', {}, undefined), TypeError);
});
