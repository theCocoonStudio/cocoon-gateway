// Production entry: mutual TLS with the private root, the role from the client certificate and its token, and
// the request log written to the backend database (src/sink.js) with stdout as the container-lifetime copy.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import pg from 'pg';
import { createApp, roleFromCertificateAndToken } from './app.js';
import { fromEnvironment } from './credentials.js';
import { databaseConfig } from './database.js';
import { secret } from './env.js';
import { createSink } from './sink.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
// The gateway's domain is deployment configuration, not repository content: GATEWAY_DOMAIN in the environment
// (or the file it names), never a value in config/upstreams.json.
const upstreams = { ...read('../config/upstreams.json'), domain: secret('GATEWAY_DOMAIN', { required: true }) };
const policy = read('../config/policy.json');
const tokens = Object.fromEntries(Object.keys(policy.roles).map((role) => [role, secret(`GATEWAY_TOKEN_${role.toUpperCase()}`, { required: true })]));

// The database is required: without it there is no record, and without a record the gateway does not serve
// (the owner, 2026-10-13). The start probes it once; a failure ends the start, and the deploy keeps the previous image.
const stamp = () => new Date().toISOString();
const pool = new pg.Pool(databaseConfig(secret('GATEWAY_DATABASE_URL', { required: true }), secret('GATEWAY_DATABASE_CA', { required: true })));
pool.on('error', (err) => console.log(JSON.stringify({ ts: stamp(), database: 'pool error', detail: err.message })));
const sink = createSink({ query: (text, values) => pool.query(text, values) });
try {
  await sink.probe();
} catch (err) {
  console.log(JSON.stringify({ ts: stamp(), fatal: 'the request log database is unreachable; not serving', detail: err.message }));
  process.exit(1);
}
const log = (line) => { console.log(JSON.stringify(line)); sink.write(line); };

const app = createApp({ upstreams, policy, credentials: fromEnvironment(upstreams), roleOf: roleFromCertificateAndToken(policy, tokens), log, accept: () => sink.accepting() });
const server = https.createServer(
  { key: secret('GATEWAY_TLS_KEY', { required: true }), cert: secret('GATEWAY_TLS_CERT', { required: true }), ca: secret('GATEWAY_CLIENT_CA', { required: true }), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
  app,
);
server.on('tlsClientError', (err, socket) => { log({ ts: stamp(), tls: err.message, from: socket.remoteAddress }); socket.destroy(); });
const port = Number(process.env.PORT || 8443);
server.listen(port, () => console.log(JSON.stringify({ ts: new Date().toISOString(), listening: port, domain: upstreams.domain })));

// The health check: mutual TLS refuses a checker that holds no client certificate, so a plain listener on
// the loopback interface only answers /healthz (and nothing else) for the platform's or compose's probe
// running inside the container. It never proxies and is not reachable from outside.
const healthPort = Number(process.env.HEALTH_PORT || 8080);
http
  .createServer((req, res) => {
    // ok stays true while the process serves; the sink's state beside it says whether lines are being kept
    // (queued, inserted, dropped, failures, lastError, lastFlushAt, accepting), so a stalled log is visible
    // without being read as a dead container (a restart would not bring the database back).
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, sink: sink.state() })); }
    res.writeHead(404); res.end();
  })
  .listen(healthPort, '127.0.0.1', () => console.log(JSON.stringify({ ts: new Date().toISOString(), health: healthPort })));

// docker stop sends SIGTERM: the queued lines are inserted before the process ends, so a redeploy loses none.
process.on('SIGTERM', async () => {
  console.log(JSON.stringify({ ts: stamp(), stopping: 'SIGTERM', queued: sink.state().queued }));
  server.close();
  await sink.close();
  await pool.end();
  process.exit(0);
});
