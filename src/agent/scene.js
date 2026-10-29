// The scene table and its pure functions (docs/scene-agent.spec.md, scene.1 to scene.6): the template is a
// three.js ObjectLoader document, the table beside it is the allowlist of every path and slot the agent may
// change, with each value's kind and bounds. The state is a value (the values set, the nodes in their slots, the
// history); the document the page receives is composed here from the template and the state, never written by
// the model (scene.3); its hash is the SHA-256 of its canonical JSON (scene.5); before it leaves it is validated
// again as defence in depth (scene.4). Nothing here reads a file, the clock or the network.
import { createHash } from 'node:crypto';

const KINDS = ['number', 'enum', 'colour', 'boolean'];
const TIERS = ['both', 'webgpu'];
const BACKENDS = ['webgl', 'webgpu'];
const COLOUR = /^#[0-9a-f]{6}$/;
const POINTER = /^(\/([^/~]|~[01])+)+$/; // a JSON pointer with no empty segment: /materials/0/color

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const targetsOf = (spec) => (spec.targets !== undefined ? spec.targets : [spec.target]);

// JSON pointer (RFC 6901) over a plain document: read, write, and remove a key.
const tokensOf = (pointer) => pointer.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
function pointerGet(doc, pointer) {
  let node = doc;
  for (const t of tokensOf(pointer)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[t];
  }
  return node;
}
function pointerParent(doc, pointer) {
  const tokens = tokensOf(pointer);
  const last = tokens.pop();
  let node = doc;
  for (const t of tokens) {
    if (node === null || typeof node !== 'object' || node[t] === undefined) throw new Error(`scene: the document has no ${pointer}`);
    node = node[t];
  }
  if (node === null || typeof node !== 'object') throw new Error(`scene: the document has no ${pointer}`);
  return [node, last];
}
function pointerSet(doc, pointer, value) { const [parent, key] = pointerParent(doc, pointer); parent[key] = value; }
function pointerDelete(doc, pointer) { const [parent, key] = pointerParent(doc, pointer); delete parent[key]; }

// What a kind takes, in words, for the model's refusals and the validator's reasons.
export function describeKind(spec) {
  if (spec.kind === 'number') return `a number from ${spec.min} to ${spec.max} (step ${spec.step})`;
  if (spec.kind === 'enum') return `one of ${spec.values.join(', ')}`;
  if (spec.kind === 'colour') return 'a colour as #rrggbb in lower-case hex';
  return 'true or false';
}

// Whether a value is of the kind and within its bounds. A number outside min..max is refused, never clamped
// (tools.3); a number off the step grid is accepted, the step is advice to the model.
export function accepts(spec, value) {
  if (spec.kind === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max;
  if (spec.kind === 'enum') return typeof value === 'string' && spec.values.includes(value);
  if (spec.kind === 'colour') return typeof value === 'string' && COLOUR.test(value);
  return typeof value === 'boolean';
}

// The table's form (a string colour, an enum name) to the document's (three's integer colour, the encode map's
// object, null meaning the key is absent), and back; decode gives undefined for a document value that is no
// encoding of any table value.
function encode(spec, value) {
  if (spec.kind === 'colour') return parseInt(value.slice(1), 16);
  if (spec.kind === 'enum' && spec.encode !== undefined) return spec.encode[value];
  return value;
}
function decode(spec, raw) {
  if (spec.kind === 'colour') return Number.isInteger(raw) && raw >= 0 && raw <= 0xffffff ? `#${raw.toString(16).padStart(6, '0')}` : undefined;
  if (spec.kind === 'enum' && spec.encode !== undefined) {
    const same = (encoded) => (encoded === null ? raw === undefined : canonicalJson(encoded) === canonicalJson(raw));
    return spec.values.find((v) => same(spec.encode[v]));
  }
  return raw;
}

// The table's own shape, checked once at load; a fault is thrown naming the path, slot or kind at fault.
export function loadTable(json) {
  const fail = (message) => { throw new Error(`scene table: ${message}`); };
  if (!isObject(json)) fail('not an object');
  if (!Number.isInteger(json.version)) fail('version must be an integer');
  if (!isObject(json.template) || !isObject(json.template.object)) fail('template must be an object document with an object');
  if (!isObject(json.paths) || !isObject(json.slots) || !isObject(json.kinds)) fail('paths, slots and kinds must be objects');
  for (const [path, spec] of Object.entries(json.paths)) checkSpec(`path ${path}`, spec, fail);
  for (const [name, kind] of Object.entries(json.kinds)) {
    if (!isObject(kind)) fail(`kind ${name} is not an object`);
    if (!TIERS.includes(kind.tier)) fail(`kind ${name}: tier ${JSON.stringify(kind.tier)} is not one of ${TIERS.join(', ')}`);
    if (!isObject(kind.node) || typeof kind.node.type !== 'string') fail(`kind ${name}: node must be an object with a string type`);
    if (!isObject(kind.values)) fail(`kind ${name}: values must be an object`);
    for (const [value, spec] of Object.entries(kind.values)) checkSpec(`kind ${name} value ${value}`, spec, fail);
  }
  for (const [name, slot] of Object.entries(json.slots)) {
    if (!isObject(slot)) fail(`slot ${name} is not an object`);
    if (!Array.isArray(slot.accepts) || slot.accepts.length === 0) fail(`slot ${name}: accepts must be a non-empty list of kinds`);
    for (const k of slot.accepts) if (typeof k !== 'string' || !Object.hasOwn(json.kinds, k)) fail(`slot ${name} accepts unknown kind ${JSON.stringify(k)}; the kinds are ${Object.keys(json.kinds).join(', ')}`);
    if (typeof slot.fixed !== 'boolean') fail(`slot ${name}: fixed must be a boolean`);
    if (typeof slot.target !== 'string' || !POINTER.test(slot.target)) fail(`slot ${name}: target must be a JSON pointer such as /object/children`);
    if (!Array.isArray(pointerGet(json.template, slot.target))) fail(`slot ${name}: target ${slot.target} is not an array in the template`);
  }
  // the representation's version, stamped into the template where three's loader keeps its own metadata
  // (scene.4 amended 2026-10-29), so every composed document carries it inside its hash and the page
  // reads it before loading and refuses another version; the table file itself stays as written
  json.template.metadata = { ...(json.template.metadata ?? {}), cocoon: { version: json.version } };
  return json;
}

function checkSpec(where, spec, fail) {
  if (!isObject(spec)) fail(`${where} is not an object`);
  if (!KINDS.includes(spec.kind)) fail(`${where}: kind ${JSON.stringify(spec.kind)} is not one of ${KINDS.join(', ')}`);
  if (spec.target !== undefined && spec.targets !== undefined) fail(`${where}: one target or a targets list, not both`);
  const targets = targetsOf(spec);
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every((t) => typeof t === 'string' && POINTER.test(t))) fail(`${where}: every target must be a JSON pointer such as /materials/0/color`);
  if (spec.kind === 'number') {
    for (const k of ['min', 'max', 'step']) if (typeof spec[k] !== 'number' || !Number.isFinite(spec[k])) fail(`${where}: ${k} must be a finite number`);
    if (!(spec.min < spec.max)) fail(`${where}: min ${spec.min} is not below max ${spec.max}`);
    if (!(spec.step > 0)) fail(`${where}: step ${spec.step} is not positive`);
  }
  if (spec.kind === 'enum') {
    if (!Array.isArray(spec.values) || spec.values.length === 0 || !spec.values.every((v) => typeof v === 'string')) fail(`${where}: values must be a non-empty list of strings`);
    if (spec.encode !== undefined) {
      if (!isObject(spec.encode)) fail(`${where}: encode must be an object`);
      if (canonicalJson(Object.keys(spec.encode).sort()) !== canonicalJson([...spec.values].sort())) fail(`${where}: encode must have exactly the keys ${spec.values.join(', ')}`);
    }
  }
  if (!accepts(spec, spec.default)) fail(`${where}: default ${JSON.stringify(spec.default)} is not ${describeKind(spec)}`);
}

// The template's state for a client: every path at its default, every slot empty, no history.
export function initialState(table, backend) {
  if (!BACKENDS.includes(backend)) throw new Error(`scene: backend ${JSON.stringify(backend)} is not one of ${BACKENDS.join(', ')}`);
  return {
    version: table.version,
    backend,
    values: Object.fromEntries(Object.entries(table.paths).map(([path, spec]) => [path, spec.default])),
    slots: Object.fromEntries(Object.keys(table.slots).map((slot) => [slot, null])),
    history: [],
  };
}

// The kinds a slot accepts for a backend: a webgpu-tier kind only when the backend is webgpu (scene.6).
export function kindsFor(table, slot, backend) {
  return slot.accepts.filter((k) => table.kinds[k].tier === 'both' || table.kinds[k].tier === backend);
}

// What read() shows the model (tools.2): every path with its value, kind and bounds; every slot with the kinds
// it accepts here, its node or null, and whether it is fixed; the history's length. No document, no shader, no URL.
export function readView(table, state) {
  const paths = {};
  for (const [path, spec] of Object.entries(table.paths)) {
    const entry = { value: state.values[path], kind: spec.kind };
    if (spec.kind === 'number') { entry.min = spec.min; entry.max = spec.max; entry.step = spec.step; }
    if (spec.kind === 'enum') entry.values = [...spec.values];
    paths[path] = entry;
  }
  const slots = {};
  for (const [name, slot] of Object.entries(table.slots)) {
    const node = state.slots[name];
    slots[name] = { accepts: kindsFor(table, slot, state.backend), node: node ? { id: node.id, kind: node.kind, values: { ...node.values } } : null, fixed: slot.fixed };
  }
  return { paths, slots, history: state.history.length };
}

// The renderer's form of one path's value (stream.1): each target of the path as a JSON pointer into the composed
// document, with the value as the document carries it (null meaning the key is removed), so the page lands a
// `set` on its objects without holding the table.
export function writesFor(table, path, value) {
  const spec = table.paths[path];
  const encoded = encode(spec, value);
  return targetsOf(spec).map((pointer) => ({ pointer, value: encoded }));
}

// A filled slot's node as the document carries it: the kind's node with uuid `slot:<slot>`, name the slot's, and
// the node's values encoded at their targets.
export function nodeFor(table, name, filled) {
  const kind = table.kinds[filled.kind];
  const node = structuredClone(kind.node);
  node.uuid = `slot:${name}`;
  node.name = name;
  for (const [value, spec] of Object.entries(kind.values)) {
    const encoded = encode(spec, filled.values[value]);
    for (const target of targetsOf(spec)) pointerSet(node, target, encoded);
  }
  return node;
}

// The document for the page: a clone of the template with every path's value encoded at its targets and every
// filled slot's node appended to its slot's array, as uuid `slot:<slot>` and name the slot's name.
export function compose(table, state) {
  const doc = structuredClone(table.template);
  for (const [path, spec] of Object.entries(table.paths)) {
    const encoded = encode(spec, state.values[path]);
    for (const target of targetsOf(spec)) {
      if (encoded === null) pointerDelete(doc, target); else pointerSet(doc, target, encoded);
    }
  }
  for (const [name, slot] of Object.entries(table.slots)) {
    const filled = state.slots[name];
    if (!filled) continue;
    pointerGet(doc, slot.target).push(nodeFor(table, name, filled));
  }
  return doc;
}

// Canonical JSON: keys sorted recursively, no whitespace; what JSON.stringify drops (an undefined value) is dropped.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The address of a state (scene.5): the SHA-256 hex of the composed document's canonical JSON.
export function hashOf(doc) {
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

// Defence in depth before the document leaves (scene.4): null when it may go, else the reason. The version is
// the client's, the serialized size is under the cap, and every path's value decodes back to one within its bounds.
export function validateDocument(table, doc, { version, sizeCap }) {
  if (version !== table.version) return `the document's version is ${table.version} and the client's is ${version}`;
  if (doc === null || typeof doc !== 'object') return 'the document is not an object';
  const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  if (bytes > sizeCap) return `the document is ${bytes} bytes, over the cap of ${sizeCap}`;
  for (const [path, spec] of Object.entries(table.paths)) {
    for (const target of targetsOf(spec)) {
      const raw = pointerGet(doc, target);
      if (!accepts(spec, decode(spec, raw))) return `${path}: the document carries ${JSON.stringify(raw)} at ${target}, not ${describeKind(spec)}`;
    }
  }
  return null;
}
