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
| `env` (step 5) | no | yes |

Copy them however your machine reaches each host; the box's directory is the one the sandbox configuration names.

## 3. The Droplet and its firewall, on DigitalOcean

Create the Droplet: Debian 12 or 13, the smallest size, your ssh key. Note its public IP. A Cloud Firewall applied to it: inbound 22 from your address, 443 and 8443 from the box's public address, nothing else. 8443 is the same listener published for the sandbox's in-container relay, which cannot use 443 inside the container.

## 4. The host, on the Droplet, as root

```
apt-get update && apt-get install -y docker.io jq && systemctl enable --now docker && mkdir -m 700 /etc/cocoon-gateway && docker --version
```

Then the Droplet's files of step 2 into `/etc/cocoon-gateway/`.

## 5. The env file and the ownership, on the Droplet, as root

The paths are the host's: the container sees `/etc/cocoon-gateway` at the same path, mounted read-only.

```
printf '%s\n' 'GATEWAY_DOMAIN=DOMAIN' 'GITHUB_APP_ID=APP_ID' 'GITHUB_APP_INSTALLATION_ID=INSTALLATION_ID' 'GITHUB_APP_PRIVATE_KEY_FILE=/etc/cocoon-gateway/app.pem' 'GATEWAY_TLS_KEY_FILE=/etc/cocoon-gateway/server.key' 'GATEWAY_TLS_CERT_FILE=/etc/cocoon-gateway/server.crt' 'GATEWAY_CLIENT_CA_FILE=/etc/cocoon-gateway/root.crt' 'GATEWAY_TOKEN_CLAUDE_FILE=/etc/cocoon-gateway/claude.token' 'GATEWAY_TOKEN_GEMINI_FILE=/etc/cocoon-gateway/gemini.token' > /etc/cocoon-gateway/env && chown -R 1000:1000 /etc/cocoon-gateway && chmod 600 /etc/cocoon-gateway/* && wc -l /etc/cocoon-gateway/app.pem && openssl rsa -check -noout -in /etc/cocoon-gateway/app.pem && ls -la /etc/cocoon-gateway
```

Expected: `27 /etc/cocoon-gateway/app.pem`, `RSA key ok`, seven files owned `1000 1000` at `-rw-------` (env, app.pem, server.key, server.crt, root.crt, claude.token, gemini.token). A key that fails the check is a bad copy: copy it again as a file, never through a paste.

## 6. The deploy, on the Droplet, as root

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-droplet.sh -o deploy-droplet.sh && bash deploy-droplet.sh
```

The script checks its tools and the seven files, downloads this repository's main as one tarball, checks the archive against the commit, builds the image, starts the container and waits for its health check. It prints the commit deployed, then `deploy: cocoon-gateway Up ... (healthy) 0.0.0.0:443->8443/tcp, 0.0.0.0:8443->8443/tcp` and the container's last log lines, ending with `{"listening":8443,"domain":"DOMAIN"}` and `{"health":8080}`.

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

```
docker logs --since 1h cocoon-gateway
```

One JSON line per request: time, role, host, method, path, status, milliseconds, request id; the same id the sandbox's relay logs on its side, so a request can be followed across both.
