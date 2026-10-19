// A streaming pass-through: the request body is piped up and the response body is piped back, byte for
// byte, so git's packs and the model's event streams survive. The client's own credentials never go
// up; the upstream's credential is injected here; Host is rewritten to the upstream; Location headers
// in responses are rewritten back to the gateway's subdomains so a redirect stays inside the wall.
//
// Two timeouts, not one (2026-10-16). Until the upstream answers with headers, the connect timeout
// (30 s) bounds a dead or silent upstream. Once the response streams, the idle timeout (10 min) is the
// only cut: a model's event stream can go thirty seconds and more between bytes while it thinks, and the
// one 30 s socket timeout of the first version destroyed the upstream in that silence. Worse, the error
// path then wrote its JSON onto the body already half sent, so a gzip-encoded stream ended in garbage
// and the client's decoder threw a ZlibError (the owner saw it on 2026-10-13 and twice on the 16th; the
// gateway's own log showed a 502 for a request the relay had logged as 200). Now an upstream failure
// after the headers have gone closes the client's connection and writes nothing more: a cut stream is
// a cut stream, never a patched one; the log line carries the detail and the 502.
//
// An upstream marked `encoding: identity` in config/upstreams.json is asked for an uncompressed body
// (the owner's fix of 2026-10-13 for the model API): nothing on the path inflates, and a cut, should one
// still happen, is a short stream the client can see, not a decoder error. The other upstreams keep the
// client's Accept-Encoding: packuments and API bodies compress well, and git's packs are bytes anyway.
//
// A client that closes its own connection first (2026-10-17, Gemini's finding on the review of this change) has
// its upstream request destroyed at once and a 499 line in the log; before, the upstream ran on unread until the
// idle timeout and the line said 502.
import http from 'node:http';
import https from 'node:https';

// Hop-by-hop headers (RFC 9110 §7.6.1), Host, cookies, and Proxy-Authorization, which carries the role's token
// for this gateway and is consumed here. The client's own credentials (Authorization, x-api-key) are dropped
// too, unless the upstream is `passthrough`: then they are the credential, and nothing is injected.
const DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie']);
const CLIENT_CREDENTIALS = new Set(['authorization', 'x-api-key']);

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

export function proxy(req, res, { target, hostHeader, credentialHeaders, path, requestId, hostToSubdomain, onDone, passthrough = false, acceptEncoding, connectTimeoutMs = 30_000, idleTimeoutMs = 600_000, body, bodyHead, bodyEnded }) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (DROP.has(k)) continue;
    if (!passthrough && CLIENT_CREDENTIALS.has(k)) continue;
    headers[k] = v;
  }
  Object.assign(headers, credentialHeaders, { host: hostHeader, 'x-request-id': requestId }); // the upstream's name, whatever address we connect to
  if (acceptEncoding) headers['accept-encoding'] = acceptEncoding;
  if (body !== undefined) { headers['content-length'] = String(Buffer.byteLength(body)); delete headers['transfer-encoding']; } // a body the app read first (the GraphQL gate)
  const client = target.scheme === 'http' ? http : https;
  const started = Date.now();
  let bytes = 0;
  let phase = 'connect';
  let done = false;
  const cut = (err) => {
    if (done) return;
    done = true;
    // The headers and part of the body are gone: nothing is appended (an error document inside an encoded
    // or event stream is garbage to the client); the connection is closed so the client sees the cut.
    res.destroy();
    onDone && onDone({ status: 502, ms: Date.now() - started, bytes, detail: `upstream failed after the headers were sent: ${err.message}` });
  };
  const up = client.request({ host: target.host, port: target.port, method: req.method, path, headers, timeout: connectTimeoutMs }, (upRes) => {
    phase = 'stream';
    up.setTimeout(idleTimeoutMs);
    const out = { ...upRes.headers, 'x-request-id': requestId };
    delete out.connection;
    delete out['transfer-encoding'];
    if (out.location) out.location = rewriteLocation(out.location, hostToSubdomain);
    res.writeHead(upRes.statusCode, out);
    upRes.on('data', (chunk) => { bytes += chunk.length; });
    // 'end' can still fire after a cut (the buffered rest of a response drains after the destroy): one line per request.
    upRes.on('end', () => { if (done) return; done = true; onDone && onDone({ status: upRes.statusCode, ms: Date.now() - started, bytes }); });
    // The upstream can vanish mid-body without an error on the request object: the response then closes
    // incomplete. That is the same cut as a mid-stream error, handled the same way.
    upRes.on('error', () => {});
    upRes.on('close', () => { if (!done && !upRes.complete) cut(new Error('upstream closed the connection mid-stream')); });
    upRes.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error(phase === 'connect' ? `connect timeout (${connectTimeoutMs} ms with no response headers)` : `idle timeout (${idleTimeoutMs} ms with no bytes mid-stream)`)));
  up.on('error', (err) => {
    if (res.headersSent) return cut(err);
    if (done) return;
    done = true;
    res.writeHead(502, { 'content-type': 'application/json', 'x-request-id': requestId });
    res.end(JSON.stringify({ error: 'upstream', detail: err.message, requestId }));
    onDone && onDone({ status: 502, ms: Date.now() - started, bytes, detail: err.message });
  });
  // The client can go away first: a cancelled model call, a closed terminal, a dropped relay. Without this the
  // upstream request ran on (a model stream to its end, unread, the bytes sitting in the socket) and the log line
  // came only when the idle timeout fired, ten minutes later, as a 502 blamed on the upstream (Gemini's finding on
  // the review of 2026-10-17, measured). Now the upstream is destroyed at once and the line says what happened, 499.
  res.on('close', () => {
    if (done) return;
    done = true;
    up.destroy();
    onDone && onDone({ status: 499, ms: Date.now() - started, bytes, detail: `client closed the connection ${phase === 'connect' ? 'before the upstream answered' : 'mid-stream'}` });
  });
  // A body the app read in part (the receive-pack command list) is written first and the rest piped as it
  // comes, the client's own length and encoding headers untouched since every byte is forwarded; a push whose
  // body ended inside the head (deletions alone send no pack) ends here too.
  if (body !== undefined) up.end(body);
  else if (bodyHead !== undefined) { up.write(bodyHead); if (bodyEnded) up.end(); else req.pipe(up); }
  else req.pipe(up);
}
