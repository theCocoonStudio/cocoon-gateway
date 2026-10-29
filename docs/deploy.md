# Deploying the gateway: a new Droplet, and a redeploy

Three machines, each holding only its own. **Your machine**: the root's key and serial file, each role's GitHub App private key, and the start of every copy. **The box** (the sandbox host): the sandbox configuration, the launcher, and the four files its container mounts; it reaches nothing and nothing is copied from it. **The Droplet**: the gateway's six files and the container. Replace `DOMAIN` (the parent of the subdomains, e.g. `gw.example.com`), `IP` (the Droplet's address), `APP_ID`, `INSTALLATION_ID` (the number in the App's installation page URL) and `APP_KEY` (the path of the App's private key on your machine) with your values; none of them belongs in a repository.

## 1. Once per installation: the certificates, on your machine

Skip when they exist on your machine already: they are issued to the names, not to an address, so a new Droplet needs no new ones. If they were ever made on the box, make them again here and let the copies below replace the box's: the root's key belongs on no host it signs for.

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/certs.sh -o certs.sh && bash certs.sh root ~/.config/cocoon/gateway && bash certs.sh server ~/.config/cocoon/gateway DOMAIN github git anthropic npm arxiv export-arxiv && bash certs.sh client ~/.config/cocoon/gateway claude && bash certs.sh client ~/.config/cocoon/gateway gemini
```

Writes, at mode 600 for the keys, refusing to overwrite: `root.key` and `root.srl` (stay here), `root.crt`, `server.key`, `server.crt`, `claude.key`, `claude.crt`, `claude.token`, `gemini.key`, `gemini.crt`, `gemini.token` (one client set per role in `config/policy.json`).

The scene agent (step 9) adds a client set for its role and a server certificate of its own, from the same root: `bash certs.sh client ~/.config/cocoon/gateway site && bash certs.sh service ~/.config/cocoon/gateway DOMAIN agent`, which writes `site.key`, `site.crt`, `site.token`, `agent.key` and `agent.crt`.

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
| each role's GitHub App private key | no (once the gateway shape is on) | yes, as `claude-app.pem`, `gemini-app.pem` |
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
printf '%s\n' 'GATEWAY_DOMAIN=DOMAIN' 'GITHUB_APP_CLAUDE_ID=CLAUDE_APP_ID' 'GITHUB_APP_CLAUDE_INSTALLATION_ID=CLAUDE_INSTALLATION_ID' 'GITHUB_APP_CLAUDE_PRIVATE_KEY_FILE=/etc/cocoon-gateway/claude-app.pem' 'GITHUB_APP_GEMINI_ID=GEMINI_APP_ID' 'GITHUB_APP_GEMINI_INSTALLATION_ID=GEMINI_INSTALLATION_ID' 'GITHUB_APP_GEMINI_PRIVATE_KEY_FILE=/etc/cocoon-gateway/gemini-app.pem' 'GATEWAY_TLS_KEY_FILE=/etc/cocoon-gateway/server.key' 'GATEWAY_TLS_CERT_FILE=/etc/cocoon-gateway/server.crt' 'GATEWAY_CLIENT_CA_FILE=/etc/cocoon-gateway/root.crt' 'GATEWAY_TOKEN_CLAUDE_FILE=/etc/cocoon-gateway/claude.token' 'GATEWAY_TOKEN_GEMINI_FILE=/etc/cocoon-gateway/gemini.token' 'GATEWAY_TOKEN_SITE_FILE=/etc/cocoon-gateway/site.token' 'ANTHROPIC_API_KEY_FILE=/etc/cocoon-gateway/anthropic.key' > /etc/cocoon-gateway/env && chown -R 1000:1000 /etc/cocoon-gateway && chmod 600 /etc/cocoon-gateway/* && wc -l /etc/cocoon-gateway/claude-app.pem /etc/cocoon-gateway/gemini-app.pem && openssl rsa -check -noout -in /etc/cocoon-gateway/claude-app.pem && openssl rsa -check -noout -in /etc/cocoon-gateway/gemini-app.pem && ls -la /etc/cocoon-gateway
```

Expected: `27` lines for each pem, `RSA key ok` twice, ten files owned `1000 1000` at `-rw-------` (env, server.key, server.crt, root.crt, claude.token, gemini.token, site.token, anthropic.key, claude-app.pem, gemini-app.pem; since 2026-10-19 the site role's token from `certs.sh client <dir> site` and the owner's model key written to anthropic.key, the key the gateway injects for that role alone). A key that fails the check is a bad copy: copy it again as a file, never through a paste.

## 6. The deploy, on the Droplet, as root

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-droplet.sh -o deploy-droplet.sh && bash deploy-droplet.sh
```

The script checks its tools and the eight files, downloads this repository's main as one tarball, checks the archive against the commit, builds the image, starts the container and waits for its health check. It prints the commit deployed, then `deploy: cocoon-gateway Up ... (healthy) 0.0.0.0:443->8443/tcp, 0.0.0.0:8443->8443/tcp` and the container's last log lines, ending with `{"listening":8443,"domain":"DOMAIN"}` and `{"health":8080}`.

## 7. The check, from your machine

Mutual TLS, the role's token, the policy and the App credential, end to end, with the client files of step 1:

```
curl -sS --cacert ~/.config/cocoon/gateway/root.crt --cert ~/.config/cocoon/gateway/claude.crt --key ~/.config/cocoon/gateway/claude.key -H "Proxy-Authorization: Bearer $(cat ~/.config/cocoon/gateway/claude.token)" --resolve github.DOMAIN:8443:IP https://github.DOMAIN:8443/api/v3/zen
```

Expected: one line of GitHub's zen. A 503 with `credential` in the body is that role's App key (step 5's check, then `docker restart cocoon-gateway`, since the key is read once at start); a handshake error is the certificates.

## 8. The sandbox, on the box

The sandbox configuration (`~/.config/cocoon/sandbox.json`) gets the two gateway sections of the sandbox's `examples/cocoon-ai-gateway.json` with your `domain` and `address` in place of the documentation values. Then `cocoon --dry`, then `cocoon claude`. Once that start works, the App's private key can leave the box: nothing there reads it any more.

## 9. The scene agent, beside the gateway (2026-10-29)

The home page's agent (`docs/scene-agent.spec.md`): a second container from the image the gateway runs, with a different command, on a network of its own that the gateway joins; it reaches the gateway and nothing else, and the site's backend reaches it on 8444 with a bearer token over TLS. `scripts/deploy-agent.sh` carries every value and every security line with its reason; this step is what to put where.

**On your machine:** step 1's two extra commands (the `site` client set and the `agent` service certificate), then `openssl rand -hex 32 > ~/.config/cocoon/gateway/backend.token && chmod 600 ~/.config/cocoon/gateway/backend.token`, the bearer the site's backend presents.

**The site's platform** gets two secrets: the bytes of `backend.token` (its `Authorization: Bearer` to `https://agent.DOMAIN:8444`, or `IP:8444` with the name pinned, the way step 7 pins the gateway) and the contents of `root.crt`, the one certificate its HTTPS client trusts for that call. Both are yours to wire (spec scope.2); `agent.DOMAIN` is a name in `agent.crt`, not a public DNS record, unless you make one.

**The Droplet's Cloud Firewall** gains inbound 8444 from the site platform's egress addresses, as the platform publishes them (spec sec.5: the firewall and the token are two locks). A platform with no fixed egress addresses leaves the token as the one lock on 8444 open to everyone: your call, said here so it is not made by omission.

**On the Droplet, as root:** the directory, the files, the env file whole, the ownership, then the script.

| file | from |
|---|---|
| `root.crt` | the same as the gateway's |
| `site.key`, `site.crt`, `site.token` | step 1's `client ... site`; the token's bytes are also the gateway's `site.token` (the gateway verifies, the agent presents) |
| `agent.key`, `agent.crt` | step 1's `service ... agent` |
| `backend.token` | above |
| `env` | below |

```
mkdir -m 700 /etc/cocoon-agent && printf '%s\n' 'GATEWAY_DOMAIN=DOMAIN' 'AGENT_GATEWAY_ADDRESS=cocoon-gateway:8443' 'AGENT_GATEWAY_CERT_FILE=/etc/cocoon-agent/site.crt' 'AGENT_GATEWAY_KEY_FILE=/etc/cocoon-agent/site.key' 'AGENT_GATEWAY_TOKEN_FILE=/etc/cocoon-agent/site.token' 'GATEWAY_CLIENT_CA_PUBLIC_FILE=/etc/cocoon-agent/root.crt' 'AGENT_TLS_KEY_FILE=/etc/cocoon-agent/agent.key' 'AGENT_TLS_CERT_FILE=/etc/cocoon-agent/agent.crt' 'AGENT_SITE_TOKEN_FILE=/etc/cocoon-agent/backend.token' 'AGENT_PRICE_INPUT_PER_MILLION_USD=INPUT_PRICE' 'AGENT_PRICE_OUTPUT_PER_MILLION_USD=OUTPUT_PRICE' > /etc/cocoon-agent/env && chown -R 1000:1000 /etc/cocoon-agent && chmod 600 /etc/cocoon-agent/* && ls -la /etc/cocoon-agent
```

`INPUT_PRICE` and `OUTPUT_PRICE` are the pinned model's prices in USD per million tokens, from its price page: `agent/rules.md` keeps them at zero on purpose (the one number the repository does not carry) and the service refuses to start on a missing or non-positive one, since a spend ceiling counted against zero never fires. Expected: eight files owned `1000 1000` at `-rw-------`. The gateway's directory is not mounted into the agent: it never sees the App keys or the model key.

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-agent.sh -o deploy-agent.sh && bash deploy-agent.sh
```

The script refuses to run without a healthy gateway and takes its image tag from it (both halves are one commit); makes the `cocoon-agent` network on `172.30.0.0/29` (the agent's containers get `172.30.0.4` to `.6`) and joins the gateway to it at `172.30.0.2`; puts two iptables rules in place, one in `DOCKER-USER` refusing every new connection from the agent's addresses to anything but the gateway's (an outside name's lookup among them, since Docker forwards those from the container's own namespace) and one in `INPUT` refusing a new connection from those addresses to the Droplet itself, and a oneshot systemd unit ordered before Docker that puts both back at boot, before the containers return; then the gateway's three-move swap for the agent's container. It prints `deploy-agent: cocoon-agent Up ... (healthy) 0.0.0.0:8444->8444/tcp` and the container's last lines, ending with `{"agent":8444,"model":"...","gateway":"cocoon-gateway:8443"}` and `{"health":8080}`.

**The check, from your machine** (the site role's own files, against the gateway, prove the model route; the backend token, against the agent, proves the endpoint):

```
curl -sS -w '\n%{http_code}\n' --cacert ~/.config/cocoon/gateway/root.crt -H "Authorization: Bearer $(cat ~/.config/cocoon/gateway/backend.token)" --resolve agent.DOMAIN:8444:IP https://agent.DOMAIN:8444/v1/scene/nobody-yet
```

Expected: `{"error":"none","detail":"no scene for this client; the page starts at the template","requestId":"..."}` then `404` (a client id of valid shape, 8 to 64 of `A-Za-z0-9_-`, with no scene; the token was accepted, the TLS name matched). A `401` with `{"error":"unauthenticated"}` is the token; a `400` with `"detail":"clientId"` is an id under eight characters; a handshake error is `agent.crt` or `root.crt`. Then one turn from the site's backend; its `say` and `change` events on the stream, and the gateway's log line for the model call under the role `site` with the same request id (`docker logs cocoon-gateway`), close the loop. The three egress checks, from the Droplet, each printing `refused:` and a code: an outside address, `docker exec cocoon-agent node -e 'fetch("https://1.1.1.1").then(()=>console.log("reached"),(e)=>console.log("refused:",e.cause?.code))'` (`ECONNREFUSED`, the forward rule); an outside name, `docker exec cocoon-agent node -e 'require("node:dns").promises.lookup("example.com").then(console.log,(e)=>console.log("refused:",e.code))'` (`EAI_AGAIN` or `ENOTFOUND`: the lookup's forward refused); the Droplet itself, `docker exec cocoon-agent node -e 'fetch("http://172.30.0.1:22").then(()=>console.log("reached"),(e)=>console.log("refused:",e.cause?.code))'` (`ECONNREFUSED`, the input rule). `iptables -S DOCKER-USER` and `iptables -S INPUT | grep br-cocoon-agent` show one line each.

**What a swap loses:** the store is in memory (spec store.4): every visitor starts at the template after a redeploy or a restart. **What the rules file is:** `agent/rules.md`'s body is the placeholder until the persona's own pull request (records issue #87, deliverable 8); the agent runs with it until then.

## Redeploying

After a merge to main, on the Droplet, as root. A role added to `config/policy.json` needs its token file in `/etc/cocoon-gateway/` and its `GATEWAY_TOKEN_<ROLE>_FILE` line in `env` first: the server refuses to start without every role's token, and the deploy's file check names the missing file (gemini joined claude on 2026-10-14). **Since 2026-10-16 each role is its own GitHub App** (one App served every role before, so a gemini container acted as the claude App's bot on GitHub): on the Droplet, `mv /etc/cocoon-gateway/app.pem /etc/cocoon-gateway/claude-app.pem`, add `gemini-app.pem` (the gemini App's private key, copied from your machine), write `env` whole again with step 5's `printf` (every line, the six per-role ones among them; never an in-place edit of that file: on 2026-10-16 a pasted `sed -i` chain left it with three lines of twelve and the gateway down), `chown`/`chmod` as in step 5, then redeploy; the deploy refuses the old names and a missing pem by name.

```
curl -fsSL https://raw.githubusercontent.com/theCocoonStudio/cocoon-gateway/main/scripts/deploy-droplet.sh -o deploy-droplet.sh && bash deploy-droplet.sh
```

The script downloads main again and builds it. **The site role (2026-10-19, the scene agent's first build):** on your machine `certs.sh client <dir> site`; on the Droplet copy `site.token` into `/etc/cocoon-gateway/`, write the owner's model key to `/etc/cocoon-gateway/anthropic.key` (mode 600, owner 1000), write `env` whole again with step 5's `printf` (two more lines), then redeploy: the server refuses to start without the token, and without the key once the role names the `anthropic` kind. The agent's own deploy (its container beside the gateway, its certificate for the Next backend, the two prices) is step 9; after every gateway redeploy, run step 9's script again so the agent runs the same commit (it refuses an image the gateway does not run). The swap is in three moves (2026-10-16): the new image is started once beside the old one with no ports and must come up healthy within 60 s, or the deploy stops with its first lines printed and the old gateway untouched; then the old container is stopped and kept, the new one takes the name and is waited for; healthy, the old container and image go; not healthy, the new one is removed and the old one is started again. Before that day the old container was removed before the new one had started, and a bad env file left no gateway for forty minutes.

## Reading the gateway

```
docker logs --since 1h cocoon-gateway
```

One JSON line per request: time, role, host, method, path, status, milliseconds, request id; the same id the sandbox's relay logs on its side, so a request can be followed across both.
