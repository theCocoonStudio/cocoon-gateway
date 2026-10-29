import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTable, initialState, readView, compose, hashOf, canonicalJson, validateDocument } from '../../src/agent/scene.js';

// The repository's own table, and a copy of it broken one way at a time.
const raw = JSON.parse(fs.readFileSync(new URL('../../agent/scene.json', import.meta.url), 'utf8'));
const table = loadTable(raw);
const broken = (edit) => { const t = structuredClone(raw); edit(t); return t; };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('the table loads; a broken table is refused naming the path, slot or kind at fault', () => {
  assert.equal(table.version, 1);
  assert.deepEqual(Object.keys(table.paths), ['background', 'main.colour', 'main.emissive', 'main.roughness', 'main.metalness', 'main.size', 'ambient.intensity', 'ambient.colour', 'fog', 'main.visible']);
  assert.deepEqual(Object.keys(table.slots), ['light.key', 'light.fill']);
  assert.deepEqual(Object.keys(table.kinds), ['directional', 'point', 'area']);
  assert.throws(() => loadTable(broken((t) => { t.paths['main.roughness'].kind = 'float'; })), /scene table: path main\.roughness: kind "float" is not one of number, enum, colour, boolean/);
  assert.throws(() => loadTable(broken((t) => { t.paths['main.colour'].target = 'materials/0/color'; })), /path main\.colour: every target must be a JSON pointer/);
  assert.throws(() => loadTable(broken((t) => { t.paths['main.size'].targets = ['/geometries/0/width', 7]; })), /path main\.size: every target must be a JSON pointer/);
  assert.throws(() => loadTable(broken((t) => { t.slots['light.key'].accepts.push('spot'); })), /slot light\.key accepts unknown kind "spot"; the kinds are directional, point, area/);
  assert.throws(() => loadTable(broken((t) => { t.slots['light.key'].target = '/object'; })), /slot light\.key: target \/object is not an array in the template/);
  assert.throws(() => loadTable(broken((t) => { t.paths['main.roughness'].min = 2; })), /path main\.roughness: min 2 is not below max 1/);
  assert.throws(() => loadTable(broken((t) => { t.paths['main.roughness'].step = 0; })), /step 0 is not positive/);
  assert.throws(() => loadTable(broken((t) => { t.paths.fog.default = 'dense'; })), /path fog: default "dense" is not one of none, thin, thick/);
  assert.throws(() => loadTable(broken((t) => { delete t.paths.fog.encode.thick; })), /path fog: encode must have exactly the keys none, thin, thick/);
  assert.throws(() => loadTable(broken((t) => { t.paths.background.default = '#FFFFFF'; })), /path background: default "#FFFFFF" is not a colour as #rrggbb in lower-case hex/);
  assert.throws(() => loadTable(broken((t) => { t.kinds.area.tier = 'webgl'; })), /kind area: tier "webgl" is not one of both, webgpu/);
  assert.throws(() => loadTable(broken((t) => { t.kinds.point.values.colour.target = 'color'; })), /kind point value colour: every target must be a JSON pointer/);
  assert.throws(() => loadTable(broken((t) => { t.version = '1'; })), /version must be an integer/);
});

test('the initial state is the template: every path at its default, every slot empty, no history; composing it gives the template back', () => {
  const s = initialState(table, 'webgl');
  assert.deepEqual(s, {
    version: 1,
    backend: 'webgl',
    values: { background: '#101418', 'main.colour': '#2a9d8f', 'main.emissive': '#000000', 'main.roughness': 0.5, 'main.metalness': 0.1, 'main.size': 1, 'ambient.intensity': 0.6, 'ambient.colour': '#ffffff', fog: 'none', 'main.visible': true },
    slots: { 'light.key': null, 'light.fill': null },
    history: [],
  });
  assert.deepEqual(compose(table, s), table.template, 'every default equals the template\'s value at its target');
  const t = table.template;
  assert.equal(t.object.background, 0x101418);
  assert.equal(t.materials[0].color, 0x2a9d8f);
  assert.equal(t.object.children[1].color, 0xffffff);
  assert.equal(Object.hasOwn(t.object, 'fog'), false, 'fog none is no fog key');
  assert.deepEqual(t.object.matrix, IDENTITY);
  assert.equal(initialState(table, 'webgpu').backend, 'webgpu');
  assert.throws(() => initialState(table, 'metal'), /scene: backend "metal" is not one of webgl, webgpu/);
});

test('read() shows each path\'s value, kind and bounds by kind, each slot\'s kinds for the backend, node and fixed, the history\'s length, and nothing else', () => {
  const v = readView(table, initialState(table, 'webgl'));
  assert.deepEqual(Object.keys(v), ['paths', 'slots', 'history']);
  assert.deepEqual(v.paths['main.roughness'], { value: 0.5, kind: 'number', min: 0, max: 1, step: 0.05 });
  assert.deepEqual(v.paths['main.size'], { value: 1, kind: 'number', min: 0.5, max: 3, step: 0.1 });
  assert.deepEqual(v.paths.fog, { value: 'none', kind: 'enum', values: ['none', 'thin', 'thick'] });
  assert.deepEqual(v.paths.background, { value: '#101418', kind: 'colour' });
  assert.deepEqual(v.paths['main.visible'], { value: true, kind: 'boolean' });
  assert.deepEqual(v.slots['light.key'], { accepts: ['directional', 'point'], node: null, fixed: false });
  assert.deepEqual(v.slots['light.fill'], { accepts: ['directional', 'point'], node: null, fixed: false });
  assert.equal(v.history, 0);
  const text = JSON.stringify(v);
  for (const word of ['geometries', 'materials', 'matrix', 'uuid', 'shader', 'Shader', 'http', 'target', 'encode', 'Fog', 'tier']) assert.equal(text.includes(word), false, `read() shows no "${word}"`);
  const gpu = readView(table, initialState(table, 'webgpu'));
  assert.deepEqual(gpu.slots['light.key'].accepts, ['directional', 'point', 'area'], 'the webgpu tier is shown to a webgpu client');
  assert.deepEqual(gpu.slots['light.fill'].accepts, ['directional', 'point', 'area']);
  const filled = { ...initialState(table, 'webgpu'), slots: { 'light.key': { id: 'slot:light.key', kind: 'area', values: { intensity: 2, colour: '#ffeedd' } }, 'light.fill': null }, history: [{}, {}] };
  const fv = readView(table, filled);
  assert.deepEqual(fv.slots['light.key'].node, { id: 'slot:light.key', kind: 'area', values: { intensity: 2, colour: '#ffeedd' } });
  assert.equal(fv.slots['light.fill'].node, null);
  assert.equal(fv.history, 2);
});

test('compose: a colour becomes three\'s integer, a fog choice the object or no key, a size every dimension, a filled slot a node appended; the table is never written', () => {
  const before = structuredClone(table);
  const s0 = initialState(table, 'webgl');
  const s1 = { ...s0, values: { ...s0.values, 'main.colour': '#ff0000', background: '#000000', fog: 'thin', 'main.size': 2, 'main.visible': false, 'ambient.intensity': 1.5 } };
  const d1 = compose(table, s1);
  assert.equal(d1.materials[0].color, 0xff0000);
  assert.equal(d1.object.background, 0);
  assert.deepEqual(d1.object.fog, { type: 'Fog', color: 0x101418, near: 5, far: 30 });
  assert.deepEqual([d1.geometries[0].width, d1.geometries[0].height, d1.geometries[0].depth], [2, 2, 2]);
  assert.equal(d1.object.children[0].visible, false);
  assert.equal(d1.object.children[1].intensity, 1.5);
  assert.equal(d1.object.children.length, 2, 'no slot filled, no node appended');
  const d2 = compose(table, { ...s1, values: { ...s1.values, fog: 'thick' } });
  assert.deepEqual(d2.object.fog, { type: 'Fog', color: 0x101418, near: 2, far: 12 });
  const d3 = compose(table, { ...s1, values: { ...s1.values, fog: 'none' } });
  assert.equal(Object.hasOwn(d3.object, 'fog'), false, 'none removes the key');
  const s4 = { ...s0, slots: { 'light.key': null, 'light.fill': { id: 'slot:light.fill', kind: 'point', values: { intensity: 2.5, colour: '#00ff00' } } } };
  const d4 = compose(table, s4);
  assert.equal(d4.object.children.length, 3);
  assert.deepEqual(d4.object.children[2], { type: 'PointLight', color: 0x00ff00, intensity: 2.5, distance: 0, decay: 2, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, 3, 4, 1], uuid: 'slot:light.fill', name: 'light.fill' });
  const s5 = { ...s4, slots: { ...s4.slots, 'light.key': { id: 'slot:light.key', kind: 'directional', values: { intensity: 1, colour: '#ffffff' } } } };
  const d5 = compose(table, s5);
  assert.deepEqual(d5.object.children.slice(2).map((n) => [n.uuid, n.type]), [['slot:light.key', 'DirectionalLight'], ['slot:light.fill', 'PointLight']], 'slots append in the table\'s order');
  assert.deepEqual(table, before, 'compose clones: the table and its template are untouched');
  assert.deepEqual(compose(table, s0), table.template);
});

test('the hash is the SHA-256 of the canonical JSON: sorted keys, no whitespace, stable under key order, changed by a value; two states with the same values share it', () => {
  assert.equal(canonicalJson({ b: [1, { z: null, y: 'ÿ' }], a: true, u: undefined }), '{"a":true,"b":[1,{"y":"ÿ","z":null}]}');
  assert.equal(canonicalJson([undefined, 'x']), '[null,"x"]', 'what JSON.stringify writes for an undefined element');
  assert.equal(hashOf({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.equal(hashOf({ a: 1, b: { c: 2, d: [3, 4] } }), hashOf({ b: { d: [3, 4], c: 2 }, a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.match(hashOf(table.template), /^[0-9a-f]{64}$/);
  const s0 = initialState(table, 'webgl');
  const twin = { ...initialState(table, 'webgpu'), history: [{ values: {}, slots: {} }] };
  assert.equal(hashOf(compose(table, s0)), hashOf(compose(table, twin)), 'the same values, the same hash, whatever the backend or history');
  const s1 = { ...s0, values: { ...s0.values, 'main.roughness': 0.55 } };
  assert.notEqual(hashOf(compose(table, s1)), hashOf(compose(table, s0)));
});

test('validateDocument: null for a good document; a wrong version, a size over the cap, a value out of its bounds are reasons', () => {
  const s = initialState(table, 'webgl');
  const doc = compose(table, s);
  const sizeCap = JSON.stringify(doc).length + 256;
  assert.equal(validateDocument(table, doc, { version: 1, sizeCap }), null);
  assert.equal(validateDocument(table, compose(table, { ...s, values: { ...s.values, fog: 'thick', 'main.colour': '#ffffff', 'main.size': 3, 'main.visible': false } }), { version: 1, sizeCap }), null);
  assert.match(validateDocument(table, doc, { version: 2, sizeCap }), /the document's version is 1 and the client's is 2/);
  assert.match(validateDocument(table, doc, { version: '1', sizeCap }), /version is 1 and the client's is 1/, 'a string version is not the integer');
  assert.match(validateDocument(table, doc, { version: 1, sizeCap: 100 }), /the document is \d+ bytes, over the cap of 100/);
  assert.equal(validateDocument(table, null, { version: 1, sizeCap }), 'the document is not an object');
  const over = compose(table, s); over.materials[0].roughness = 1.5;
  assert.match(validateDocument(table, over, { version: 1, sizeCap }), /^main\.roughness: the document carries 1\.5 at \/materials\/0\/roughness, not a number from 0 to 1 \(step 0\.05\)$/);
  const under = compose(table, s); under.object.children[1].intensity = -0.1;
  assert.match(validateDocument(table, under, { version: 1, sizeCap }), /^ambient\.intensity: .* -0\.1 at \/object\/children\/1\/intensity/);
  const colour = compose(table, s); colour.object.background = 0x1000000;
  assert.match(validateDocument(table, colour, { version: 1, sizeCap }), /^background: the document carries 16777216 at \/object\/background, not a colour/);
  const fog = compose(table, s); fog.object.fog = { type: 'FogExp2', density: 0.1 };
  assert.match(validateDocument(table, fog, { version: 1, sizeCap }), /^fog: the document carries \{"type":"FogExp2","density":0\.1\} at \/object\/fog, not one of none, thin, thick$/);
  const visible = compose(table, s); delete visible.object.children[0].visible;
  assert.match(validateDocument(table, visible, { version: 1, sizeCap }), /^main\.visible: the document carries undefined at \/object\/children\/0\/visible, not true or false$/);
  const depth = compose(table, s); depth.geometries[0].depth = 5;
  assert.match(validateDocument(table, depth, { version: 1, sizeCap }), /^main\.size: the document carries 5 at \/geometries\/0\/depth, not a number from 0\.5 to 3/, 'each of a path\'s targets is checked');
});

test('the composed document carries the representation\'s version in its metadata (scene.4 amended 2026-10-29), inside the hash', () => {
  const doc = compose(table, initialState(table, 'webgpu'));
  assert.deepEqual(doc.metadata.cocoon, { version: table.version });
  const other = structuredClone(doc);
  other.metadata.cocoon.version = table.version + 1;
  assert.notEqual(hashOf(other), hashOf(doc));
});
