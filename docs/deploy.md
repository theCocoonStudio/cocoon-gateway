# Deploying the gateway: a new Droplet, and a redeploy

The commands, in order, each one line to paste. Cocoon's values are filled in (the App id, the installation id, the box's paths); another installation changes them. Everything on the Droplet runs as root; everything on the box runs as the owner.

## 1. Once per installation: the certificates, on the box

Skip when `~/.config/cocoon/gateway/` already holds them (they are issued to the names, not to an address, so a new Droplet does not need new ones).

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/certs.sh -o certs.sh && bash certs.sh root ~/.config/cocoon/gateway && bash certs.sh server ~/.config/cocoon/gateway gw.thecocoon.studio github git anthropic npm arxiv export-arxiv && bash certs.sh client ~/.config/cocoon/gateway claude
```

Writes `root.key` (stays on the box), `root.crt`, `root.srl`, `server.key`, `server.crt`, `claude.key`, `claude.crt`, `claude.token`; keys at mode 600; refuses to overwrite.

## 2. The Droplet and its firewall, on DigitalOcean

Create the Droplet: Debian 12 or 13, the smallest size, your ssh key. Note its public IP. A Cloud Firewall applied to it: inbound 22 from your address, 443 and 8443 from the sandbox host's public address, nothing else. 8443 is the same listener published for the sandbox's in-container relay, which cannot use 443 inside the container.

## 3. The host, on the Droplet

```
apt-get update && apt-get install -y docker.io jq && systemctl enable --now docker && mkdir -m 700 /etc/cocoon-gateway && docker --version
```

## 4. The files, from the box

Replace `IP` with the Droplet's address. The App's private key becomes `app.pem`.

```
scp ~/.config/cocoon/gateway/server.key ~/.config/cocoon/gateway/server.crt ~/.config/cocoon/gateway/root.crt ~/.config/cocoon/gateway/claude.token root@IP:/etc/cocoon-gateway/ && scp ~/cocoon-claude.2026-09-03.private-key.pem root@IP:/etc/cocoon-gateway/app.pem
```

## 5. The env file and the ownership, on the Droplet

The paths are the host's: the container sees `/etc/cocoon-gateway` at the same path, mounted read-only. The installation id is the number in the App's installation page URL.

```
printf '%s\n' 'GITHUB_APP_ID=4819921' 'GITHUB_APP_INSTALLATION_ID=158823990' 'GITHUB_APP_PRIVATE_KEY_FILE=/etc/cocoon-gateway/app.pem' 'GATEWAY_TLS_KEY_FILE=/etc/cocoon-gateway/server.key' 'GATEWAY_TLS_CERT_FILE=/etc/cocoon-gateway/server.crt' 'GATEWAY_CLIENT_CA_FILE=/etc/cocoon-gateway/root.crt' 'GATEWAY_TOKEN_CLAUDE_FILE=/etc/cocoon-gateway/claude.token' > /etc/cocoon-gateway/env && chown -R 1000:1000 /etc/cocoon-gateway && chmod 600 /etc/cocoon-gateway/* && wc -l /etc/cocoon-gateway/app.pem && openssl rsa -check -noout -in /etc/cocoon-gateway/app.pem && ls -la /etc/cocoon-gateway
```

Expected: `27 /etc/cocoon-gateway/app.pem`, `RSA key ok`, six files owned `1000 1000` at `-rw-------` (env, app.pem, server.key, server.crt, root.crt, claude.token). A key that fails the check is a bad copy: copy it again with `scp`, never through a paste.

## 6. The deploy, on the Droplet

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-droplet.sh -o deploy-droplet.sh && bash deploy-droplet.sh
```

The script checks its tools and the six files, downloads this repository's main as one tarball, checks the archive against the commit, builds the image, starts the container and waits for its health check. It prints the commit deployed, then `deploy: cocoon-gateway Up ... (healthy) 0.0.0.0:443->8443/tcp, 0.0.0.0:8443->8443/tcp` and the container's last log lines, which should end with `{"listening":8443,"domain":"gw.thecocoon.studio"}` and `{"health":8080}`.

## 7. The check from the box

Mutual TLS, the role's token, the policy and the App credential, end to end; replace `IP`:

```
curl -sS --cacert ~/.config/cocoon/gateway/root.crt --cert ~/.config/cocoon/gateway/claude.crt --key ~/.config/cocoon/gateway/claude.key -H "Proxy-Authorization: Bearer $(cat ~/.config/cocoon/gateway/claude.token)" --resolve github.gw.thecocoon.studio:8443:IP https://github.gw.thecocoon.studio:8443/api/v3/zen
```

Expected: one line of GitHub's zen. A 503 with `credential` in the body is the App key (step 5's check, then `docker restart cocoon-gateway`, since the key is read once at start); a handshake error is the certificates.

## 8. The address, in the sandbox

The sandbox's gateway example (`examples/cocoon-ai-gateway.json` in cocoon-agent-sandbox) and the host file on the box (`~/.config/cocoon/sandbox.json`, `gateway.address`) carry the Droplet's address; a new Droplet is a one-value PR there and the same edit in the host file. Then `cocoon --dry`, then `cocoon claude`.

## Redeploying

After a merge to main, on the Droplet:

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-droplet.sh -o deploy-droplet.sh && bash deploy-droplet.sh
```

The script downloads main again and builds it. From PR 6 on, the new container is created beside the old one, swapped in under the name once created, waited for until healthy, and the previous image is removed only then; a start that is not healthy within 60 s keeps the previous image and says so. A changed secret (a new key, a new token) is read at the container's start: `docker restart cocoon-gateway` after the file changes, or a redeploy.

## Reading the gateway

```
docker logs --since 1h cocoon-gateway
```

One JSON line per request: time, role, host, method, path, status, milliseconds, request id; the same id the sandbox's relay logs on its side, so a request can be followed across both.
