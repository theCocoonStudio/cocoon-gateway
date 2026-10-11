// A streaming pass-through: the request body is piped up and the response body is piped back, byte for
// byte, so git's packs and the model's event streams survive. The client's own credentials never go
// up; the upstream's credential is injected here; Host is rewritten to the upstream; Location headers
// in responses are rewritten back to the gateway's subdomains so a redirect stays inside the wall.
import http from 'node:http';
import https from 'node:https';

// Hop-by-hop headers (RFC 9110 §7.6.1) and the headers that would carry the client's own credentials.
const DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key', 'cookie']);

export function rewritePath(path, rewrite) {
  if (!rewrite) return path;
  for (const [pattern, replacement] of Object.entries(rewrite)) {
    const re = new RegExp(pattern);
    if (re.test(path)) return path.replace(re, replacement);
  }
  return path;
}

export function rewriteLocation(location, hostToSubdomain) {
  if (!location) return location;
  for (const [host, subdomain] of hostToSubdomain) {
    const prefix = `https://${host}`;
    if (location.startsWith(prefix)) return `https://${subdomain}${location.slice(prefix.length)}`;
  }
  return location;
}

export function proxy(req, res, { target, hostHeader, credentialHeaders, path, requestId, hostToSubdomain, onDone }) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
  Object.assign(headers, credentialHeaders, { host: hostHeader, 'x-request-id': requestId }); // the upstream's name, whatever address we connect to
  const client = target.scheme === 'http' ? http : https;
  const started = Date.now();
  let bytes = 0;
  const up = client.request({ host: target.host, port: target.port, method: req.method, path, headers, timeout: 30_000 }, (upRes) => {
    const out = { ...upRes.headers, 'x-request-id': requestId };
    delete out.connection;
    delete out['transfer-encoding'];
    if (out.location) out.location = rewriteLocation(out.location, hostToSubdomain);
    res.writeHead(upRes.statusCode, out);
    upRes.on('data', (chunk) => { bytes += chunk.length; });
    upRes.on('end', () => onDone && onDone({ status: upRes.statusCode, ms: Date.now() - started, bytes }));
    upRes.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('connect timeout')));
  up.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'x-request-id': requestId });
    res.end(JSON.stringify({ error: 'upstream', detail: err.message, requestId }));
    onDone && onDone({ status: 502, ms: Date.now() - started, bytes });
  });
  req.pipe(up);
}
