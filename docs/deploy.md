# Deploying the gateway: a new Droplet, and a redeploy

Three machines, each holding only its own. **Your machine**: the root's key and serial file, the App's private key, and the start of every copy. **The box** (the sandbox host): the sandbox configuration, the launcher, and the four files its container mounts; it reaches nothing and nothing is copied from it. **The Droplet**: the gateway's six files and the container. Replace `DOMAIN` (the parent of the subdomains, e.g. `gw.example.com`), `IP` (the Droplet's address), `APP_ID`, `INSTALLATION_ID` (the number in the App's installation page URL) and `APP_KEY` (the path of the App's private key on your machine) with your values; none of them belongs in a repository.

## 1. Once per installation: the certificates, on your machine

Skip when they exist on your machine already: they are issued to the names, not to an address, so a new Droplet needs no new ones. If they were ever made on the box, make them again here and let the copies below replace the box's: the root's key belongs on no host it signs for.

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/certs.sh -o certs.sh && bash certs.sh root ~/.config/cocoon/gateway && bash certs.sh server ~/.config/cocoon/gateway DOMAIN github git anthropic npm arxiv export-arxiv && bash certs.sh client ~/.config/cocoon/gateway claude && bash certs.sh client ~/.config/cocoon/gateway gemini
```

Writes, at mode 600 for the keys, refusing to overwrite: `root.key` and `root.srl` (stay here), `root.crt`, `server.key`, `server.crt`, `claude.key`, `claude.crt`, `claude.token`, `gemini.key`, `gemini.crt`, `gemini.token` (one client set per role in `config/policy.json`).

## 2. What goes where

| file | the box, `~/.config/cocoon/gateway/` | the Droplet, `/etc/cocoon-gateway/` |
|---|---|---|
| `root.crt` | yes | yes |
| `claude.crt` | yes | no |
| `claude.key` | yes | no |
| `claude.token` | yes | yes |
| `gemini.crt` | yes | no |
| `gemini.key` | yes | no |
| `gemini.token` | yes | yes |
| `server.key` | no | yes |
| `server.crt` | no | yes |
| the App's private key | no (once the gateway shape is on) | yes, as `app.pem` |
| `database.url` (step 4b) | no | yes |
| `database.crt` (step 4b) | no | yes |
| `env` (step 5) | no | yes |

Copy them however your machine reaches each host; the box's directory is the one the sandbox configuration names.

## 3. The Droplet and its firewall, on DigitalOcean

Create the Droplet: Debian 12 or 13, the smallest size, your ssh key. Note its public IP. A Cloud Firewall applied to it: inbound 22 from your address, 443 and 8443 from the box's public address, nothing else. 8443 is the same listener published for the sandbox's in-container relay, which cannot use 443 inside the container.

## 4. The host, on the Droplet, as root

```
apt-get update && apt-get install -y docker.io jq && systemctl enable --now docker && mkdir -m 700 /etc/cocoon-gateway && docker --version
```

Then the Droplet's files of step 2 into `/etc/cocoon-gateway/`.

## 4b. The request log's database, on DigitalOcean and from your machine

The gateway writes one row per request and one per refusal into the backend database and nothing onto this host (the owner, 2026-10-13: a machine's own record of itself is not a record). The gateway's credential can only insert; the schema is applied by you, once, as the database's owner.

1. A managed PostgreSQL database (the smallest), a database in it for the gateway, and the Droplet added as a **trusted source** so nothing else can connect.
2. From your machine, as the owner, apply [`db/schema.sql`](../db/schema.sql) (`psql "<the owner's connection string>" -f schema.sql`), then the commented role and grant lines at its end with a password of your choice: the role `gateway_writer` holds INSERT on the two tables and nothing else.
3. Two files for the Droplet, into `/etc/cocoon-gateway/` with the others: `database.url`, one line, the connection string of `gateway_writer` (host, port, the database; any `sslmode` in it is ignored, see below); `database.crt`, the database's CA certificate as the panel offers it for download.

The gateway verifies the server against `database.crt` on every connection, whatever the URL says: pg lets a URL's `sslmode=require` drop a CA pinned beside it, so the gateway strips the parameter and pins the file (`src/database.js`, measured in `test/database.test.js`). Without the two files, or with the database unreachable at start, the gateway refuses to start and the deploy keeps the previous image: no record, no service.

## 5. The env file and the ownership, on the Droplet, as root

The paths are the host's: the container sees `/etc/cocoon-gateway` at the same path, mounted read-only.

```
printf '%s\n' 'GATEWAY_DOMAIN=DOMAIN' 'GITHUB_APP_ID=APP_ID' 'GITHUB_APP_INSTALLATION_ID=INSTALLATION_ID' 'GITHUB_APP_PRIVATE_KEY_FILE=/etc/cocoon-gateway/app.pem' 'GATEWAY_TLS_KEY_FILE=/etc/cocoon-gateway/server.key' 'GATEWAY_TLS_CERT_FILE=/etc/cocoon-gateway/server.crt' 'GATEWAY_CLIENT_CA_FILE=/etc/cocoon-gateway/root.crt' 'GATEWAY_TOKEN_CLAUDE_FILE=/etc/cocoon-gateway/claude.token' 'GATEWAY_TOKEN_GEMINI_FILE=/etc/cocoon-gateway/gemini.token' 'GATEWAY_DATABASE_URL_FILE=/etc/cocoon-gateway/database.url' 'GATEWAY_DATABASE_CA_FILE=/etc/cocoon-gateway/database.crt' > /etc/cocoon-gateway/env && chown -R 1000:1000 /etc/cocoon-gateway && chmod 600 /etc/cocoon-gateway/* && wc -l /etc/cocoon-gateway/app.pem && openssl rsa -check -noout -in /etc/cocoon-gateway/app.pem && ls -la /etc/cocoon-gateway
```

Expected: `27 /etc/cocoon-gateway/app.pem`, `RSA key ok`, nine files owned `1000 1000` at `-rw-------` (env, app.pem, server.key, server.crt, root.crt, claude.token, gemini.token, database.url, database.crt). A key that fails the check is a bad copy: copy it again as a file, never through a paste.

## 6. The deploy, on the Droplet, as root

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-droplet.sh -o deploy-droplet.sh && bash deploy-droplet.sh
```

The script checks its tools and the nine files, downloads this repository's main as one tarball, checks the archive against the commit, builds the image, starts the container and waits for its health check. It prints the commit deployed, then `deploy: cocoon-gateway Up ... (healthy) 0.0.0.0:443->8443/tcp, 0.0.0.0:8443->8443/tcp` and the container's last log lines, ending with `{"listening":8443,"domain":"DOMAIN"}` and `{"health":8080}`.

## 7. The check, from your machine

Mutual TLS, the role's token, the policy and the App credential, end to end, with the client files of step 1:

```
curl -sS --cacert ~/.config/cocoon/gateway/root.crt --cert ~/.config/cocoon/gateway/claude.crt --key ~/.config/cocoon/gateway/claude.key -H "Proxy-Authorization: Bearer $(cat ~/.config/cocoon/gateway/claude.token)" --resolve github.DOMAIN:8443:IP https://github.DOMAIN:8443/api/v3/zen
```

Expected: one line of GitHub's zen. A 503 with `credential` in the body is the App key (step 5's check, then `docker restart cocoon-gateway`, since the key is read once at start); a handshake error is the certificates.

## 8. The sandbox, on the box

The sandbox configuration (`~/.config/cocoon/sandbox.json`) gets the two gateway sections of the sandbox's `examples/cocoon-ai-gateway.json` with your `domain` and `address` in place of the documentation values. Then `cocoon --dry`, then `cocoon claude`. Once that start works, the App's private key can leave the box: nothing there reads it any more.

## Redeploying

After a merge to main, on the Droplet, as root. A role added to `config/policy.json` needs its token file in `/etc/cocoon-gateway/` and its `GATEWAY_TOKEN_<ROLE>_FILE` line in `env` first: the server refuses to start without every role's token, and the deploy's file check names the missing file (gemini joined claude on 2026-10-14).

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-droplet.sh -o deploy-droplet.sh && bash deploy-droplet.sh
```

The script downloads main again and builds it. From PR 6 on, the new container is created beside the old one, swapped in under the name once created, waited for until healthy, and the previous image is removed only then; a start that is not healthy within 60 s keeps the previous image and says so. A changed secret (a new key, a new token) is read at the container's start: `docker restart cocoon-gateway` after the file changes, or a redeploy.

## Reading the gateway

The record is the database, read with your own credential from your machine, never from the Droplet:

```
psql "<the owner's connection string>" -c "SELECT ts, role, upstream, method, path, status, ms FROM requests WHERE ts > now() - interval '1 hour' ORDER BY ts" -c "SELECT ts, kind, host, role, method, path, status, detail, peer FROM refusals WHERE ts > now() - interval '1 day' ORDER BY ts"
```

One row per request the policy allowed (`requests`: time, request id, role, upstream, method, path, status, milliseconds, bytes down, the rule, the peer) and one per refusal (`refusals`: misdirected, unauthenticated, policy, credential, log, tls). The request id is the one the sandbox's relay logs on its side, so a request can be followed across both. `docker logs --since 1h cocoon-gateway` on the Droplet shows the same lines for the container's lifetime only, plus the sink's own: an `insert failed` line names a database the gateway cannot reach, and `/healthz` on the container's loopback reports the sink's queue, inserts, drops and failures. While the queue is full the gateway answers every request 503 `log`: no log, no request.
