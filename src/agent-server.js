// The scene agent's entry on the Droplet (docs/scene-agent.spec.md, meta.*; its deploy is docs/deploy.md step 9,
// scripts/deploy-agent.sh). Everything secret comes from the environment or the files it names (src/env.js):
// AGENT_SITE_TOKEN (the Next backend's bearer token), GATEWAY_DOMAIN, AGENT_GATEWAY_CERT, AGENT_GATEWAY_KEY,
// AGENT_GATEWAY_TOKEN and GATEWAY_CLIENT_CA_PUBLIC (the site role's client certificate, key and token for the
// gateway, and the private root's public half), AGENT_TLS_KEY and AGENT_TLS_CERT (this service's own
// certificate for the Next backend). The rules and the table are the repository's files; the two prices the
// rules file leaves at zero (agent/rules.md: the one number the repository does not carry) are
// AGENT_PRICE_INPUT_PER_MILLION_USD and AGENT_PRICE_OUTPUT_PER_MILLION_USD, from the model's price page, and
// the start refuses a missing or non-positive one, since a spend ceiling counted against zero never fires.
// AGENT_GATEWAY_ADDRESS (host:port) pins where the model call is dialed while the URL keeps the gateway's
// name: on the Droplet the gateway's container on the network the two share (src/agent/model.js, `connect`).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createAgentApp } from './agent/server.js';
import { parseRules } from './agent/config.js';
import { loadTable } from './agent/scene.js';
import { createMemoryStore } from './agent/store.js';
import { createModel } from './agent/model.js';
import { secret } from './env.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const price = (name) => {
  const n = Number(secret(name, { required: true }));
  if (!(Number.isFinite(n) && n > 0)) throw new Error(`${name} must be a positive number (USD per million tokens, from the model's price page)`);
  return n;
};
const file = parseRules(read('../agent/rules.md'), { allowZeroPrices: true });
if (file.priceInput !== 0 || file.priceOutput !== 0) throw new Error('agent/rules.md carries a price; the prices are the environment\'s (AGENT_PRICE_*_PER_MILLION_USD) and the file keeps zero');
const rules = { ...file, priceInput: price('AGENT_PRICE_INPUT_PER_MILLION_USD'), priceOutput: price('AGENT_PRICE_OUTPUT_PER_MILLION_USD') };
const table = loadTable(JSON.parse(read('../agent/scene.json')));
const domain = secret('GATEWAY_DOMAIN', { required: true });
const address = secret('AGENT_GATEWAY_ADDRESS');
const connect = address ? (([host, port]) => { if (!host || !/^[0-9]+$/.test(port || '')) throw new Error('AGENT_GATEWAY_ADDRESS must be host:port'); return { host, port: Number(port) }; })(address.split(':')) : undefined;
const store = createMemoryStore({ visitMs: rules.visitMinutes * 60_000, retentionMs: rules.retentionDays * 86_400_000, snapshotMs: rules.snapshotDays * 86_400_000 });
const gateway = { token: secret('AGENT_GATEWAY_TOKEN', { required: true }), cert: secret('AGENT_GATEWAY_CERT', { required: true }), key: secret('AGENT_GATEWAY_KEY', { required: true }), ca: secret('GATEWAY_CLIENT_CA_PUBLIC', { required: true }) };
const model = (request, { requestId } = {}) => createModel({ url: `https://anthropic.${domain}/v1/messages`, ...gateway, requestId, connect })(request);
const app = createAgentApp({ table, rules, store, model, siteToken: secret('AGENT_SITE_TOKEN', { required: true }) });
setInterval(() => { const gone = store.sweep(); if (gone.scenesGone || gone.snapshotsGone) console.log(JSON.stringify({ ts: new Date().toISOString(), sweep: gone })); }, 3_600_000).unref();
const port = Number(process.env.PORT || 8444);
https.createServer({ key: secret('AGENT_TLS_KEY', { required: true }), cert: secret('AGENT_TLS_CERT', { required: true }), minVersion: 'TLSv1.3' }, app)
  .listen(port, () => console.log(JSON.stringify({ ts: new Date().toISOString(), agent: port, model: rules.model, gateway: address || `anthropic.${domain}:443` })));

// The health check, the gateway's shape (src/server.js): a plain listener on the loopback interface answers
// /healthz and nothing else for the deploy's probe inside the container, so the probe needs no certificate
// and the same --health-cmd serves both containers. Not reachable from outside.
const healthPort = Number(process.env.HEALTH_PORT || 8080);
http
  .createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    res.writeHead(404); res.end();
  })
  .listen(healthPort, '127.0.0.1', () => console.log(JSON.stringify({ ts: new Date().toISOString(), health: healthPort })));
