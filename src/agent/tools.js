// The agent's eight tools (docs/scene-agent.spec.md, tools.1 to tools.10): each a pure function of the table,
// the state and the model's arguments, returning the next state or a refusal. A refusal is a result the model
// reads and corrects within the turn, never an exception (tools.9), and every refusal names what was wrong and
// what would be right. No tool reaches the network, a file, the page or the clock (tools.10). The state is never
// mutated: every acceptance is a new object, with the previous `{ values, slots }` pushed onto the history,
// bounded to the limit, the oldest dropped; the history is a list, not a stack, so an undo can be undone (tools.6).
import { accepts, describeKind, initialState, kindsFor, readView } from './scene.js';

export const REFUSAL_REASONS = ['abuse', 'nonsense', 'out_of_scope', 'unsafe'];

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

// The tools as the Messages API sees them: name, one sentence, a closed JSON Schema.
export const TOOLS = [
  { name: 'read', description: 'Read the scene as you may change it: every path with its value, kind and bounds, every slot with its node and the kinds it accepts, and the length of the history.', input_schema: schema({}, []) },
  { name: 'set', description: 'Set one path of the scene to a value of its kind within its bounds, as read shows them.', input_schema: schema({ path: { type: 'string', description: 'A path from read.' }, value: { type: ['number', 'string', 'boolean'], description: 'A number within min and max, one of the enum values, a colour as #rrggbb, or a boolean, by the path\'s kind.' } }, ['path', 'value']) },
  { name: 'add', description: 'Place a node of a kind into an empty slot that accepts it, with the kind\'s default values, and get the node\'s id.', input_schema: schema({ kind: { type: 'string', description: 'A kind the slot accepts, as read shows.' }, slot: { type: 'string', description: 'An empty slot from read.' } }, ['kind', 'slot']) },
  { name: 'remove', description: 'Remove the node with this id from its slot; a node the template carries cannot be removed.', input_schema: schema({ id: { type: 'string', description: 'A node id from read.' } }, ['id']) },
  { name: 'undo', description: 'Return to the state n steps back in this visit\'s history, from 1 to the history\'s length.', input_schema: schema({ n: { type: 'integer', minimum: 1, description: 'How many steps back.' } }, ['n']) },
  { name: 'reset', description: 'Return the scene to the template.', input_schema: schema({}, []) },
  { name: 'say', description: 'Say something to the visitor as plain text within the length bound; it changes no state.', input_schema: schema({ text: { type: 'string', description: 'Plain text; a newline is allowed, no other control character.' } }, ['text']) },
  { name: 'refuse', description: 'End the turn with a refusal the page shows once.', input_schema: schema({ reason: { type: 'string', enum: REFUSAL_REASONS, description: 'Why the request is refused.' } }, ['reason']) },
];

const CONTROL = /(?!\n)\p{Cc}/u; // any control character but the newline (words.3)

const refusal = (state, result) => ({ ok: false, state, result });
const accepted = (state, result) => ({ ok: true, state, result });
const pushHistory = (state, limit) => {
  const next = [...state.history, { values: state.values, slots: state.slots }];
  return next.length > limit ? next.slice(next.length - limit) : next;
};

const HANDLERS = {
  read(table, state) {
    return accepted(state, JSON.stringify(readView(table, state)));
  },
  set(table, state, { path, value }, ctx) {
    if (typeof path !== 'string' || !Object.hasOwn(table.paths, path)) return refusal(state, `no path ${JSON.stringify(path)}; the paths are ${Object.keys(table.paths).join(', ')}`);
    const spec = table.paths[path];
    if (!accepts(spec, value)) return refusal(state, `${path} takes ${describeKind(spec)}, not ${JSON.stringify(value)}`);
    return accepted({ ...state, values: { ...state.values, [path]: value }, history: pushHistory(state, ctx.historyLimit) }, `set ${path} to ${value}`);
  },
  add(table, state, { kind, slot }, ctx) {
    if (typeof slot !== 'string' || !Object.hasOwn(table.slots, slot)) return refusal(state, `no slot ${JSON.stringify(slot)}; the slots are ${Object.keys(table.slots).join(', ')}`);
    const entry = table.slots[slot];
    const allowed = kindsFor(table, entry, state.backend);
    if (state.slots[slot]) return refusal(state, `slot ${slot} holds ${state.slots[slot].id}; remove it first or use an empty slot`);
    if (typeof kind !== 'string' || !entry.accepts.includes(kind)) return refusal(state, `slot ${slot} does not accept ${JSON.stringify(kind)}; it accepts ${allowed.join(', ')}`);
    const tier = table.kinds[kind].tier;
    if (tier !== 'both' && tier !== state.backend) return refusal(state, `kind ${kind} is of the ${tier} tier and this client's backend is ${state.backend}; slot ${slot} accepts ${allowed.join(', ')} here`);
    const values = Object.fromEntries(Object.entries(table.kinds[kind].values).map(([name, spec]) => [name, spec.default]));
    const id = `slot:${slot}`;
    return accepted({ ...state, slots: { ...state.slots, [slot]: { id, kind, values } }, history: pushHistory(state, ctx.historyLimit) }, id);
  },
  remove(table, state, { id }, ctx) {
    const found = Object.entries(state.slots).find(([, node]) => node !== null && node.id === id);
    if (!found) {
      const ids = Object.values(state.slots).filter((node) => node !== null).map((node) => node.id);
      return refusal(state, ids.length ? `no node ${JSON.stringify(id)}; the nodes are ${ids.join(', ')}` : `no node ${JSON.stringify(id)}; no slot is filled`);
    }
    const [slot] = found;
    if (table.slots[slot].fixed) return refusal(state, `slot ${slot} is fixed: the template carries its node and it cannot be removed`);
    return accepted({ ...state, slots: { ...state.slots, [slot]: null }, history: pushHistory(state, ctx.historyLimit) }, slot);
  },
  undo(table, state, { n }, ctx) {
    const length = state.history.length;
    if (length === 0) return refusal(state, 'the history is empty; undo needs at least one earlier state');
    if (!Number.isInteger(n) || n < 1 || n > length) return refusal(state, `undo takes an integer n from 1 to ${length}, not ${JSON.stringify(n)}`);
    const past = state.history[length - n];
    return accepted({ ...state, values: past.values, slots: past.slots, history: pushHistory(state, ctx.historyLimit) }, `undone ${n}`);
  },
  reset(table, state, input, ctx) {
    return accepted({ ...initialState(table, state.backend), history: pushHistory(state, ctx.historyLimit) }, 'reset to the template');
  },
  say(table, state, { text }, ctx) {
    if (typeof text !== 'string') return refusal(state, 'say takes one string of plain text');
    const length = [...text].length;
    if (length > ctx.sayBound) return refusal(state, `the text is ${length} characters; the bound is ${ctx.sayBound}`);
    if (CONTROL.test(text)) return refusal(state, 'the text carries a control character; plain text with newlines only');
    return accepted(state, 'said');
  },
  refuse(table, state, { reason }) {
    if (!REFUSAL_REASONS.includes(reason)) return refusal(state, `unknown reason ${JSON.stringify(reason)}; the reasons are ${REFUSAL_REASONS.join(', ')}`);
    return accepted(state, `refused: ${reason}`);
  },
};

// One tool call: `{ ok, state, result }`, the result the plain text handed back to the model. An unknown tool is a
// refusal. `ctx` is the service's configuration (`sayBound`, `historyLimit`); a bad ctx is the service's bug and throws.
export function applyTool(table, state, name, input, ctx) {
  if (!ctx || !Number.isInteger(ctx.sayBound) || ctx.sayBound < 0 || !Number.isInteger(ctx.historyLimit) || ctx.historyLimit < 0) throw new TypeError('applyTool: ctx needs integer sayBound and historyLimit');
  if (typeof name !== 'string' || !Object.hasOwn(HANDLERS, name)) return refusal(state, `unknown tool ${JSON.stringify(name)}; the tools are ${TOOLS.map((t) => t.name).join(', ')}`);
  const args = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return HANDLERS[name](table, state, args, ctx);
}
