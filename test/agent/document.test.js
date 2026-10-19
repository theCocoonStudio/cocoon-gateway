import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ObjectLoader, Color, Fog } from 'three';
import { loadTable, initialState, compose } from '../../src/agent/scene.js';
import { applyTool } from '../../src/agent/tools.js';

// docs/scene-agent.spec.md tests.4: the document the service composes is what the renderer loads with three's
// own loader, so a template or a table change that three cannot read fails here first. three is a
// devDependency for this test alone (0.184.0, no advisory in GitHub's database on 2026-10-19).
const table = loadTable(JSON.parse(fs.readFileSync(new URL('../../agent/scene.json', import.meta.url), 'utf8')));
const ctx = { sayBound: 280, historyLimit: 50 };
const load = (doc) => new ObjectLoader().parse(doc);

test('three loads the template: a scene with the mesh and the ambient light, the material as composed', () => {
  const scene = load(compose(table, initialState(table, 'webgpu')));
  assert.equal(scene.type, 'Scene');
  assert.deepEqual(scene.children.map((c) => c.name), ['main', 'ambient']);
  const mesh = scene.getObjectByName('main');
  assert.equal(mesh.geometry.type, 'BoxGeometry');
  assert.equal(mesh.material.type, 'MeshStandardMaterial');
  assert.equal(mesh.material.color.getHex(), 0x2a9d8f);
  assert.equal(mesh.material.roughness, 0.5);
  assert.equal(scene.background.getHex(), 0x101418);
  assert.equal(scene.fog, null);
});

test('three loads a changed scene: the set colour, the fog, the added lights, the size', () => {
  let s = initialState(table, 'webgpu');
  for (const [name, input] of [['set', { path: 'main.colour', value: '#ff0000' }], ['set', { path: 'fog', value: 'thick' }], ['set', { path: 'main.size', value: 2 }], ['add', { kind: 'point', slot: 'light.key' }], ['add', { kind: 'area', slot: 'light.fill' }]]) {
    const r = applyTool(table, s, name, input, ctx);
    assert.equal(r.ok, true, r.result);
    s = r.state;
  }
  const scene = load(compose(table, s));
  assert.equal(scene.getObjectByName('main').material.color.getHex(), 0xff0000);
  assert.ok(scene.fog instanceof Fog);
  assert.equal(scene.fog.far, 12);
  assert.equal(scene.getObjectByName('main').geometry.parameters.width, 2);
  const key = scene.getObjectByName('light.key');
  assert.equal(key.type, 'PointLight');
  assert.equal(key.intensity, 1);
  assert.deepEqual(key.position.toArray(), [-4, 3, 4]);
  assert.equal(scene.getObjectByName('light.fill').type, 'RectAreaLight');
  assert.ok(new Color(key.color.getHex()).equals(new Color(0xffffff)));
});
