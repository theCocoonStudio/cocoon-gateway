// One turn of the agent: a loop over the Messages API (through the gateway) with the eight tools, bounded in
// calls, time and spend (docs/scene-agent.spec.md, loop.1 to loop.8). The model is a function given by the
// caller (src/agent/model.js in production, a script in the tests), so the loop itself touches no network.
// Events are emitted as they happen (stream.*): `say`, `change` (with the hash after it), `refused`, `bound`;
// `stale`, `done` and `error` are the endpoint's. Text the model writes outside a tool call reaches nobody
// and is logged as dropped (loop.5). The visitor's prompt travels as a field of a JSON object in the user
// message, never joined to an instruction (sec.4).
import { applyTool, TOOLS } from './tools.js';
import { compose, hashOf } from './scene.js';

export function costOf(usage, prices) {
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  return (input * prices.input + output * prices.output) / 1e6;
}

/**
 * ctx: { sayBound, historyLimit, callsPerTurn, turnMs, spendLeft, prices: { input, output }, model, system, maxTokens }.
 * Returns { state, messages, calls, spend, ended, refusal }: ended is 'end', 'refused', 'bound:calls', 'bound:time',
 * 'bound:spend' or 'error'.
 */
export async function runTurn({ table, state, messages, prompt, ctx, model, emit = () => {}, log = () => {}, now = () => Date.now() }) {
  const started = now();
  const toolCtx = { sayBound: ctx.sayBound, historyLimit: ctx.historyLimit };
  const msgs = [...messages, { role: 'user', content: [{ type: 'text', text: JSON.stringify({ visitor_prompt: prompt }) }] }];
  let calls = 0;
  let spend = 0;
  let ended = null;
  let refusal = null;
  while (!ended) {
    if (now() - started > ctx.turnMs) { ended = 'bound:time'; emit({ type: 'bound', bound: 'time' }); break; }
    if (spend >= ctx.spendLeft) { ended = 'bound:spend'; emit({ type: 'bound', bound: 'spend' }); break; }
    let response;
    try {
      response = await model({ model: ctx.model, system: ctx.system, tools: TOOLS, messages: msgs, max_tokens: ctx.maxTokens });
    } catch (err) {
      ended = 'error';
      log({ event: 'model_error', detail: err.message });
      break;
    }
    spend += costOf(response.usage, ctx.prices);
    const blocks = Array.isArray(response.content) ? response.content : [];
    msgs.push({ role: 'assistant', content: blocks });
    for (const b of blocks) if (b.type === 'text' && String(b.text || '').trim()) log({ event: 'dropped_text', chars: [...b.text].length });
    const uses = blocks.filter((b) => b.type === 'tool_use');
    if (uses.length === 0) { ended = 'end'; break; }
    const results = [];
    for (const use of uses) {
      if (calls >= ctx.callsPerTurn) { ended = 'bound:calls'; emit({ type: 'bound', bound: 'calls' }); break; }
      calls += 1;
      const r = applyTool(table, state, use.name, use.input, toolCtx);
      log({ event: 'tool', tool: use.name, input: use.input, ok: r.ok, result: r.result });
      if (r.ok) {
        state = r.state;
        if (use.name === 'say') emit({ type: 'say', text: use.input.text });
        else if (use.name === 'refuse') { refusal = use.input.reason; ended = 'refused'; emit({ type: 'refused', reason: refusal }); }
        else if (use.name !== 'read') emit({ type: 'change', change: use.name, input: use.input, result: r.result, hash: hashOf(compose(table, state)) });
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: r.result, ...(r.ok ? {} : { is_error: true }) });
      if (ended) break;
    }
    msgs.push({ role: 'user', content: results });
    if (ended) break;
    if (now() - started > ctx.turnMs) { ended = 'bound:time'; emit({ type: 'bound', bound: 'time' }); break; }
  }
  return { state, messages: msgs, calls, spend, ended, refusal };
}
