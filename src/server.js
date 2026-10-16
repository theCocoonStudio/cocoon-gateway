// Production entry: mutual TLS with the private root, the role from the client certificate and its token.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp, roleFromCertificateAndToken } from './app.js';
import { fromEnvironment } from './credentials.js';
import { secret } from './env.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
// The gateway's domain is deployment configuration, not repository content: GATEWAY_DOMAIN in the environment
// (or the file it names), never a value in config/upstreams.json.
const upstreams = { ...read('../config/upstreams.json'), domain: secret('GATEWAY_DOMAIN', { required: true }) };
const policy = read('../config/policy.json');
const tokens = Object.fromEntries(Object.keys(policy.roles).map((role) => [role, secret(`GATEWAY_TOKEN_${role.toUpperCase()}`, { required: true })]));

const app = createApp({ upstreams, policy, credentials: fromEnvironment(upstreams, policy), roleOf: roleFromCertificateAndToken(policy, tokens) });
const server = https.createServer(
  { key: secret('GATEWAY_TLS_KEY', { required: true }), cert: secret('GATEWAY_TLS_CERT', { required: true }), ca: secret('GATEWAY_CLIENT_CA', { required: true }), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
  app,
);
server.on('tlsClientError', (err, socket) => { console.log(JSON.stringify({ ts: new Date().toISOString(), tls: err.message, from: socket.remoteAddress })); socket.destroy(); });
const port = Number(process.env.PORT || 8443);
server.listen(port, () => console.log(JSON.stringify({ ts: new Date().toISOString(), listening: port, domain: upstreams.domain })));

// The health check: mutual TLS refuses a checker that holds no client certificate, so a plain listener on
// the loopback interface only answers /healthz (and nothing else) for the platform's or compose's probe
// running inside the container. It never proxies and is not reachable from outside.
const healthPort = Number(process.env.HEALTH_PORT || 8080);
http
  .createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    res.writeHead(404); res.end();
  })
  .listen(healthPort, '127.0.0.1', () => console.log(JSON.stringify({ ts: new Date().toISOString(), health: healthPort })));
