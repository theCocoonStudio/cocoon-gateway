// The Express app: identify the role, route by Host, decide by the policy table, proxy, log one line.
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { compile, decide } from './policy.js';
import { proxy, rewritePath } from './proxy.js';

export function createApp({ upstreams, policy, credentials, roleOf, log = (line) => console.log(JSON.stringify(line)), targetOf, proxyOptions = {}, graphqlBodyCapBytes = 1 << 20 }) {
  const compiled = compile(policy);
  const domain = upstreams.domain;
  if (typeof domain !== 'string' || !domain) throw new Error('createApp: upstreams.domain is required (the gateway reads GATEWAY_DOMAIN from its environment; the repository carries no domain)');
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
    // the credential kind is the upstream's, or the role's own where the table names one (credentialByRole, 2026-10-19: the
    // site's agent reaches the model under its role with the owner's key injected here, while the agents' CLIs pass their own)
    const credentialKind = (upstream.credentialByRole && upstream.credentialByRole[role]) || upstream.credential;
    const path = rewritePath(req.originalUrl, upstream.rewrite);
    const go = (body) => credentials.headersFor(credentialKind, role).then(
      (credentialHeaders) =>
        proxy(req, res, {
          target, hostHeader: upstream.host, credentialHeaders, path, requestId, hostToSubdomain, passthrough: credentialKind === 'passthrough', body,
          acceptEncoding: upstream.encoding, ...proxyOptions,
          onDone: ({ status, ms, bytes, detail }) => log({ ts: new Date().toISOString(), id: requestId, role, upstream: key, method: req.method, path, status, ms, bytes, rule: verdict.rule, ...(detail ? { detail } : {}) }),
        }),
      (err) => finish(503, { error: 'credential', detail: err.message }, { role, upstream: key }),
    );
    if (!(key === 'github' && req.method === 'POST' && GRAPHQL_PATH.test(req.path))) return go();
    // The GraphQL gate (2026-10-17). A GraphQL body names no repository in its path and can do anything the
    // token can (createCommitOnBranch, mergePullRequest, addComment), so the path rules above cannot bound it,
    // and gh's pull-request subcommands write by exactly such mutations. Queries pass; a mutation never does,
    // for any role: a write goes by its REST route, where the table names the repository and the verb.
    readBody(req, graphqlBodyCapBytes).then((buf) => {
      const kind = classifyGraphql(buf);
      if (kind === 'query') return go(buf);
      const detail = kind === 'mutation' ? 'GraphQL mutations never pass this gateway: a write goes by its REST route' : 'the GraphQL body could not be read as a query document';
      finish(403, { error: 'policy', detail }, { role, upstream: key, rule: 'graphql' });
    }, (err) => finish(413, { error: 'policy', detail: err.message }, { role, upstream: key, rule: 'graphql' }));
  });
  return app;
}

const GRAPHQL_PATH = /^(\/api\/graphql|\/graphql)$/;

// Read a request body whole, up to a cap; past the cap the request is refused (a GraphQL document is small).
export function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > cap) { over = true; chunks.length = 0; req.resume(); reject(new Error(`the GraphQL body exceeds ${cap} bytes`)); return; } // the rest is drained and dropped, so the refusal can be sent
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// 'query' when every operation in the body is a query (named, anonymous, or the shorthand `{ ... }`); 'mutation'
// when any is a mutation or a subscription; 'unreadable' when the body is not what a GraphQL client sends
// (JSON with a `query` string, or an array of such for a batch). Comments and string literals are blanked before
// the keyword is looked for, so a word inside them does not count; anything else that says mutation does.
export function classifyGraphql(buf) {
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch { return 'unreadable'; }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  if (ops.length === 0) return 'unreadable';
  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.query !== 'string') return 'unreadable';
    const text = op.query.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/#[^\n\r]*/g, '');
    if (/(^|[^A-Za-z0-9_])(mutation|subscription)(?![A-Za-z0-9_])/.test(text)) return 'mutation';
  }
  return 'query';
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
