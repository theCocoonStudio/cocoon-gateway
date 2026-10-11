// Production entry: mutual TLS with the private root, the role from the client certificate and its token.
import fs from 'node:fs';
import https from 'node:https';
import { createApp, roleFromCertificateAndToken } from './app.js';
import { fromEnvironment } from './credentials.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const upstreams = read('../config/upstreams.json');
const policy = read('../config/policy.json');
const pem = (name) => (process.env[name] || '').replace(/\\n/g, '\n');
const tokens = Object.fromEntries(Object.keys(policy.roles).map((role) => [role, process.env[`GATEWAY_TOKEN_${role.toUpperCase()}`] || '']));

const app = createApp({ upstreams, policy, credentials: fromEnvironment(), roleOf: roleFromCertificateAndToken(policy, tokens) });
const server = https.createServer(
  { key: pem('GATEWAY_TLS_KEY'), cert: pem('GATEWAY_TLS_CERT'), ca: pem('GATEWAY_CLIENT_CA'), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
  app,
);
server.on('tlsClientError', (err, socket) => { console.log(JSON.stringify({ ts: new Date().toISOString(), tls: err.message, from: socket.remoteAddress })); socket.destroy(); });
const port = Number(process.env.PORT || 8443);
server.listen(port, () => console.log(JSON.stringify({ ts: new Date().toISOString(), listening: port, domain: upstreams.domain })));
