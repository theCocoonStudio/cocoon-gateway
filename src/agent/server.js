// The service's endpoint (docs/scene-agent.spec.md, api.*, stream.*, log.*): the Next backend's one caller
// with the site's token, a turn as an event stream, the scene and the snapshots by GET. Everything in and out
// is logged (log.1); the store, the model and the clock are given, so the tests run the whole path without a
// network. The request body is small and bounded; the prompt is bounded again here (api.2).
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { compose, hashOf, initialState } from './scene.js';
import { runTurn } from './loop.js';

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const BACKENDS = new Set(['webgpu', 'webgl']);

function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function same(a, b) { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

/** A server-sent event writer: one JSON object per event. */
export function openStream(res, requestId) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-request-id': requestId });
  return { event(obj) { res.write(`data: ${JSON.stringify({ ...obj, requestId })}\n\n`); }, end() { res.end(); } };
}

export function createAgentApp({ table, rules, store, model, siteToken, log = (line) => console.log(JSON.stringify(line)), now = () => Date.now() }) {
  if (!siteToken) throw new Error('createAgentApp: the site token is required');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.path === '/healthz') return res.json({ ok: true });
    if (!same(bearer(req), siteToken)) { log({ ts: new Date(now()).toISOString(), status: 401, method: req.method, path: req.path }); return res.status(401).json({ error: 'unauthenticated' }); }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use((err, req, res, next) => { if (err) return res.status(400).json({ error: 'body', detail: 'the body is not a JSON object under 16 kB' }); next(); });

  const current = (clientId, backend) => store.getScene(clientId) || initialState(table, backend || 'webgl');
  const documentOf = (state) => { const document = compose(table, state); return { document, hash: hashOf(document) }; };

  app.post('/v1/scene/turn', async (req, res) => {
    const requestId = randomUUID();
    const b = req.body || {};
    const bad = [];
    if (!ID.test(String(b.clientId))) bad.push('clientId');
    if (typeof b.prompt !== 'string' || [...b.prompt].length === 0 || [...b.prompt].length > rules.promptBound) bad.push('prompt');
    if (b.hash !== null && b.hash !== undefined && !HASH.test(String(b.hash))) bad.push('hash');
    if (!BACKENDS.has(b.backend)) bad.push('backend');
    if (b.version !== table.version) bad.push('version');
    for (const f of ['address', 'time', 'page']) if (typeof b[f] !== 'string') bad.push(f);
    if (bad.length) { log({ ts: new Date(now()).toISOString(), id: requestId, status: 400, fields: bad }); return res.status(400).json({ error: 'request', detail: `fields missing or malformed: ${bad.join(', ')}`, requestId }); }
    // the prompt as received, control characters other than newline stripped (layer 2 did it once; once more here)
    const prompt = b.prompt.replace(/(?!\n)\p{Cc}/gu, '');
    const stream = openStream(res, requestId);
    let state = { ...current(b.clientId, b.backend), backend: b.backend };
    const before = documentOf(state);
    if (b.hash && b.hash !== before.hash) stream.event({ type: 'stale', document: before.document, hash: before.hash });
    const conversation = store.getConversation(b.clientId);
    const line = { ts: new Date(now()).toISOString(), id: requestId, clientId: b.clientId, address: b.address, page: b.page, backend: b.backend, prompt, hashBefore: before.hash, calls: [] };
    let refused = false;
    let outcome;
    if (conversation.turns >= rules.turnsPerVisit) {
      stream.event({ type: 'bound', bound: 'turns' });
      refused = true; outcome = 'bound:turns';
    } else {
      const spendLeft = Math.min(rules.spendPerVisitUsd - conversation.spend, rules.spendPerDayUsd - store.spendOfDay());
      if (spendLeft <= 0) { stream.event({ type: 'bound', bound: 'spend' }); refused = true; outcome = 'bound:spend'; } else {
        const turn = await runTurn({
          table, state, messages: conversation.messages, prompt,
          ctx: { sayBound: rules.sayBound, historyLimit: rules.historyLimit, callsPerTurn: rules.callsPerTurn, turnMs: rules.turnSeconds * 1000, spendLeft, prices: { input: rules.priceInput, output: rules.priceOutput }, model: rules.model, system: rules.system, maxTokens: rules.maxTokens },
          model: (request) => model(request, { requestId }), emit: (e) => stream.event(e), now,
          log: (entry) => { if (entry.event === 'tool') line.calls.push({ tool: entry.tool, input: entry.input, ok: entry.ok, result: entry.result }); else line.calls.push(entry); },
        });
        state = turn.state;
        outcome = turn.ended;
        refused = turn.ended === 'refused' || turn.ended.startsWith('bound:');
        line.refusal = turn.refusal;
        line.spend = turn.spend;
        store.putConversation(b.clientId, { ...conversation, messages: turn.messages, turns: conversation.turns + 1 });
        store.addSpend(b.clientId, turn.spend);
        if (turn.ended === 'error') stream.event({ type: 'error', detail: 'the model did not answer; the scene is as it was' });
      }
    }
    store.putScene(b.clientId, state);
    const after = documentOf(state);
    stream.event({ type: 'done', document: after.document, hash: after.hash, refused });
    stream.end();
    log({ ...line, hashAfter: after.hash, outcome, refused });
  });

  app.get('/v1/scene/:clientId', (req, res) => {
    const requestId = randomUUID();
    if (!ID.test(req.params.clientId)) return res.status(400).json({ error: 'request', detail: 'clientId', requestId });
    const state = store.getScene(req.params.clientId);
    if (!state) return res.status(404).json({ error: 'none', detail: 'no scene for this client; the page starts at the template', requestId });
    const { document, hash } = documentOf(state);
    log({ ts: new Date(now()).toISOString(), id: requestId, clientId: req.params.clientId, get: 'scene', hash });
    res.set('x-request-id', requestId).json({ document, hash, version: table.version });
  });

  app.post('/v1/snapshot', (req, res) => {
    const requestId = randomUUID();
    const clientId = String(req.body?.clientId || '');
    if (!ID.test(clientId)) return res.status(400).json({ error: 'request', detail: 'clientId', requestId });
    const state = store.getScene(clientId);
    if (!state) return res.status(404).json({ error: 'none', detail: 'no scene for this client', requestId });
    const { document, hash } = documentOf(state);
    store.putSnapshot(hash, document);
    log({ ts: new Date(now()).toISOString(), id: requestId, clientId, snapshot: hash });
    res.set('x-request-id', requestId).json({ hash });
  });

  app.get('/v1/snapshot/:hash', (req, res) => {
    const requestId = randomUUID();
    if (!HASH.test(req.params.hash)) return res.status(400).json({ error: 'request', detail: 'hash', requestId });
    const document = store.getSnapshot(req.params.hash);
    if (!document) return res.status(404).json({ error: 'none', detail: 'no snapshot at this hash', requestId });
    log({ ts: new Date(now()).toISOString(), id: requestId, get: 'snapshot', hash: req.params.hash });
    res.set('x-request-id', requestId).json({ document, hash: req.params.hash, version: table.version });
  });

  app.use((req, res) => res.status(404).json({ error: 'none' }));
  return app;
}
