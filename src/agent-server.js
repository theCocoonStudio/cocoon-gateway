// The scene agent's entry on the Droplet (docs/scene-agent.spec.md, meta.*; its deploy is the step after the
// first build, scope.4). Everything secret comes from the environment or the files it names (src/env.js):
// AGENT_SITE_TOKEN (the Next backend's bearer token), GATEWAY_DOMAIN, AGENT_GATEWAY_CERT, AGENT_GATEWAY_KEY,
// AGENT_GATEWAY_TOKEN and GATEWAY_CLIENT_CA_PUBLIC (the site role's client certificate, key and token for the
// gateway, and the private root's public half), AGENT_TLS_KEY and AGENT_TLS_CERT (this service's own
// certificate for the Next backend). The rules and the table are the repository's files.
import fs from 'node:fs';
import https from 'node:https';
import { createAgentApp } from './agent/server.js';
import { parseRules } from './agent/config.js';
import { loadTable } from './agent/scene.js';
import { createMemoryStore } from './agent/store.js';
import { createModel } from './agent/model.js';
import { secret } from './env.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const rules = parseRules(read('../agent/rules.md'));
const table = loadTable(JSON.parse(read('../agent/scene.json')));
const domain = secret('GATEWAY_DOMAIN', { required: true });
const store = createMemoryStore({ visitMs: rules.visitMinutes * 60_000, retentionMs: rules.retentionDays * 86_400_000, snapshotMs: rules.snapshotDays * 86_400_000 });
const gateway = { token: secret('AGENT_GATEWAY_TOKEN', { required: true }), cert: secret('AGENT_GATEWAY_CERT', { required: true }), key: secret('AGENT_GATEWAY_KEY', { required: true }), ca: secret('GATEWAY_CLIENT_CA_PUBLIC', { required: true }) };
const model = (request, { requestId } = {}) => createModel({ url: `https://anthropic.${domain}/v1/messages`, ...gateway, requestId })(request);
const app = createAgentApp({ table, rules, store, model, siteToken: secret('AGENT_SITE_TOKEN', { required: true }) });
setInterval(() => { const gone = store.sweep(); if (gone.scenesGone || gone.snapshotsGone) console.log(JSON.stringify({ ts: new Date().toISOString(), sweep: gone })); }, 3_600_000).unref();
const port = Number(process.env.PORT || 8444);
https.createServer({ key: secret('AGENT_TLS_KEY', { required: true }), cert: secret('AGENT_TLS_CERT', { required: true }), minVersion: 'TLSv1.3' }, app)
  .listen(port, () => console.log(JSON.stringify({ ts: new Date().toISOString(), agent: port, model: rules.model })));
