// The Express app: identify the role, route by Host, decide by the policy table, proxy, log one line.
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { compile, decide } from './policy.js';
import { proxy, rewritePath } from './proxy.js';

export function createApp({ upstreams, policy, credentials, roleOf, log = (line) => console.log(JSON.stringify(line)), targetOf }) {
  const compiled = compile(policy);
  const domain = upstreams.domain;
  const hostToSubdomain = Object.entries(upstreams.upstreams).map(([key, u]) => [u.host, `${key}.${domain}`]);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res) => {
    const requestId = randomUUID();
    const host = String(req.headers.host || '').split(':')[0];
    const suffix = `.${domain}`;
    const key = host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
    const upstream = key && upstreams.upstreams[key];
    const finish = (status, body, extra = {}) => {
      res.status(status).set('x-request-id', requestId).json({ ...body, requestId });
      log({ ts: new Date().toISOString(), id: requestId, host, method: req.method, path: req.originalUrl, status, ...extra });
    };
    if (!upstream) return finish(421, { error: 'misdirected', detail: 'this gateway does not serve that host' });
    const role = roleOf(req);
    if (!role) return finish(401, { error: 'unauthenticated' });
    const verdict = decide(compiled, role, key, req.method, req.path);
    if (!verdict.allow) return finish(403, { error: 'policy', detail: 'no rule allows this request' }, { role, upstream: key, rule: verdict.rule });
    const target = targetOf ? targetOf(key, upstream) : { host: upstream.host, port: 443, scheme: 'https' };
    const path = rewritePath(req.originalUrl, upstream.rewrite);
    credentials.headersFor(upstream.credential).then(
      (credentialHeaders) =>
        proxy(req, res, {
          target, hostHeader: upstream.host, credentialHeaders, path, requestId, hostToSubdomain, passthrough: upstream.credential === 'passthrough',
          onDone: ({ status, ms, bytes }) => log({ ts: new Date().toISOString(), id: requestId, role, upstream: key, method: req.method, path, status, ms, bytes, rule: verdict.rule }),
        }),
      (err) => finish(503, { error: 'credential', detail: err.message }, { role, upstream: key }),
    );
  });
  return app;
}

// The role is the client certificate's common name, and the token in Proxy-Authorization (the header a proxy
// consumes, RFC 9110 §11.7.2; never forwarded) must be that role's token. Authorization stays the client's own,
// so a passthrough upstream can receive it.
export function roleFromCertificateAndToken(policy, tokens) {
  return function roleOf(req) {
    const cert = req.socket.getPeerCertificate && req.socket.getPeerCertificate();
    const cn = cert && cert.subject && cert.subject.CN;
    const role = cn && Object.entries(policy.roles).find(([, r]) => r.cn === cn)?.[0];
    if (!role) return null;
    const presented = String(req.headers['proxy-authorization'] || '').replace(/^Bearer\s+/i, '');
    const expected = tokens[role] || '';
    if (!presented || presented.length !== expected.length) return null;
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected)) ? role : null;
  };
}
