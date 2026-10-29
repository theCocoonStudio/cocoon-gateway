// The model behind the gateway: one POST to the anthropic upstream's /v1/messages under the service's own role
// (docs/scene-agent.spec.md, loop.1, sec.1): mutual TLS with the role's client certificate, the role's token in
// Proxy-Authorization, the request id in x-request-id so the gateway's line and the service's line meet; the
// gateway injects the owner's model key for this role (credentialByRole), so none is here. `url` may be plain
// http in the tests, as the gateway's own tests do with their fake upstream.
import http from 'node:http';
import https from 'node:https';

export function createModel({ url, token, cert, key, ca, requestId, timeoutMs = 60_000 }) {
  const target = new URL(url);
  const client = target.protocol === 'http:' ? http : https;
  return (request) => new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const req = client.request({
      host: target.hostname, port: target.port || (client === https ? 443 : 80), path: target.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'anthropic-version': '2023-06-01', 'proxy-authorization': `Bearer ${token}`, ...(requestId ? { 'x-request-id': requestId } : {}) },
      ...(client === https ? { cert, key, ca, minVersion: 'TLSv1.3' } : {}),
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`the model answered ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('the model\'s answer was not JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`the model did not answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
