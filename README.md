# cocoon-gateway

The owner's API gateway for the agent sandbox. One host in the sandbox's wall instead of a list; one policy table that refuses what the rules forbid; every credential read from the platform's secrets by this process and none inside the container; a log line per request that is a witness the agent does not write.

Settled with the owner on 2026-10-11; the sandbox it serves is [cocoon-agent-sandbox](https://github.com/theCocoonStudio/cocoon-agent-sandbox).

## How a request travels

1. The container reaches one address, this gateway, over TLS 1.3 with a **client certificate** signed by the owner's private root; the certificate's common name is the role. A **bearer token** per role is checked as well, carried in `Proxy-Authorization` (the header a proxy consumes; never forwarded): the certificate gets in, the token gets access. `Authorization` stays the client's own, for the passthrough upstreams below.
2. The gateway routes by the **Host** header: one subdomain per upstream (`github.`, `git.`, `anthropic.`, `arxiv.`, ...). A Host it does not serve is answered 421 and never proxied; it is not an open proxy.
3. The **policy table** (`config/policy.json`) decides: rules of role, upstream, method and path pattern, first match wins, a final deny. Nothing lists a DELETE, so none passes. Roles today: `claude` and `gemini`, with the same rule set (the owner, 2026-10-14); a revocation for one is a rule removed from its copy.
4. The request is **proxied as a stream**: the body piped up and the response piped back byte for byte, so git's packs and the model's event streams survive. The client's own credentials never go up and the upstream's credential is injected here, except on a `passthrough` upstream (the model API: the owner's Claude Code runs on the subscription login, so the container's own token goes through and the gateway holds no model credential); Host is rewritten to the upstream's name; a request id is stamped and returned; Location headers in responses are rewritten back to the gateway's subdomains so a redirect stays inside the wall.
5. One **log line** per request: time, id, role, upstream, method, path, status, duration, bytes, the rule that allowed it, the peer. Every line is a row in the **backend database** (`src/sink.js`, below); stdout keeps a copy for the container's lifetime only.

## The request log

The log lives in the backend database and nowhere on the Droplet or the sandbox host (the owner, 2026-10-13): a machine's own record of itself is not a record, since whatever reaches the host reaches its log, and the agent that wrote this deploy holds the best map of the Droplet. In the database the gateway's credential inserts and never deletes (`db/schema.sql`: INSERT on `requests` and `refusals`, nothing else), the owner reads from their own machine, the agent does neither. What the author of the gateway would need to get at the record is the owner's credential, which exists on no machine the author can reach.

The sink (`src/sink.js`) is a bounded write-behind queue: lines are inserted in batches, at a hundred lines or after a second; a failed insert keeps its lines in order and retries with a doubling delay capped at thirty seconds; a full queue stops accepting and the gateway answers every request 503 `log` until it drains: no log, no request (the owner may strike this for drop-and-count). The database is required at start: the probe fails, the gateway does not serve, the deploy keeps the previous image. The connection is pinned to the database's CA (`src/database.js`): pg lets a URL's `sslmode=require` replace the ssl option beside it, so the parameter is stripped and the CA file is the one setting. The loopback `/healthz` reports the sink's state; `docker stop` flushes the queue before the process ends.

## Upstreams and credentials

`config/upstreams.json` maps each subdomain to its upstream host, the credential kind to inject (`github_app`, `github_app_basic`, `passthrough`, or none), and any path rewrite. The subdomains today: `github`, `git`, `anthropic` (passthrough), `npm` (the registry, GET only, for the sandbox's `npm ci`), `arxiv`, `export-arxiv`. GitHub's REST API is served enterprise-style so `gh` works unchanged with `GH_HOST` set to the subdomain: `/api/v3/...` and `/api/graphql` are rewritten to `api.github.com`. Git's smart HTTP goes to the `git` subdomain with the App's token as the basic credential; the push is passed through unparsed, GitHub's rulesets holding `main` and force pushes; a ref-level push policy is a later slice.

Credentials are read once at start from the process environment, or from files the environment names (`<NAME>_FILE`, `src/env.js`), so a host can mount them read-only and keep the environment free of secrets: the GitHub App's id, installation id and private key (the installation token is minted here and cached until five minutes before it expires, as the sandbox's `run.sh` once did on the box), the TLS key, certificate and the client root, and one `GATEWAY_TOKEN_<ROLE>` per role. A model key (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) is needed only if an upstream uses the `anthropic` kind; the default table uses passthrough.

## Running

```
npm ci --ignore-scripts
npm run check  # ShellCheck over scripts/, the tests, the dependency audit
npm start      # PORT (8443), HEALTH_PORT (8080, loopback), GATEWAY_DOMAIN, GATEWAY_TLS_KEY, GATEWAY_TLS_CERT, GATEWAY_CLIENT_CA, GITHUB_APP_*, GATEWAY_TOKEN_*, GATEWAY_DATABASE_URL, GATEWAY_DATABASE_CA from the environment or the files it names
npm run audit  # the scheduled dependency check: npm audit at or above "moderate" fails
```

## Deploying: a Droplet behind a Cloud Firewall

The commands, in order and one line each, are in [docs/deploy.md](docs/deploy.md): a new Droplet from nothing, the check from the box, the redeploy, and how to read the log.

The shape that keeps the client certificate: the gateway terminates TLS itself, so DigitalOcean's edge is not in the way (App Platform terminates TLS at its edge and no client certificate reaches the container; it also has no inbound address filter). In order:

1. **Certificates, on the owner's machine:** `scripts/certs.sh root <dir>`, then `scripts/certs.sh server <dir> <domain> github git anthropic npm arxiv export-arxiv` (the keys of `config/upstreams.json`), then `scripts/certs.sh client <dir> <role>` for each role (`claude`, `gemini`). The root's key stays there, and so does `root.srl`, which appears beside it at the first signing: openssl's serial counter (`-CAcreateserial`), one number per certificate the root signs, not a secret and not copied anywhere. The gateway host gets `server.key`, `server.crt`, `root.crt` and each role's `.token`; each sandbox host gets `root.crt` and its role's `.key`, `.crt` and `.token`.
2. **The Droplet:** the smallest Debian 12 or 13 with Docker (nothing on the host depends on the version: the script needs bash, curl, tar, jq and Docker, and the gateway runs in its own container); a Cloud Firewall admitting 443 and 8443 from the sandbox host's public address only and 22 from the owner's (8443 is the same listener published for the sandbox's relay, which cannot use 443 inside the container); the secrets under `/etc/cocoon-gateway` as the header of `scripts/deploy-droplet.sh` says, with the App's private key as `app.pem` and the env file naming the files at that same path: the container sees the directory where the host does, mounted read-only, so there is one path to know.
3. **The deploy:** `scripts/deploy-droplet.sh` as root on the Droplet: one reviewed tarball of this repository at the pinned ref, the image built from it, the new container created beside the old one (a wrong option fails there while the old one still serves), swapped in under the name and waited for until its health check passes (read-only root filesystem, every capability dropped, the secrets mounted read-only, the health check on the loopback listener), then the previous image removed. A failed start keeps the previous image and says so. A redeploy is the same command.
4. **DNS, optional:** `A` records for the subdomains (`github.<domain>`, `git.<domain>`, ...) at the registrar (the owner's domains are at GoDaddy) pointing at the Droplet; the sandbox can also reach the address by name through its own configuration, so public records are a convenience.
5. **The address filter's change** when the sandbox host's public address moves: the Cloud Firewall rule, nothing in any repository.

## What checks what

- **`check`** (`.github/workflows/check.yml`), on every pull request and on `main`: ShellCheck over `scripts/` (0.9.0, the runner's and the sandbox image's), the tests and the dependency audit. Made a required status in the main ruleset, it binds. The lint is `tests/lint.sh`: ShellCheck over every script plus our own classes as greps, each with the date it was learned (a recursive delete on a variable path without `${var:?}`; a file command whose first operand is a variable path without `--` before it; a script without `pipefail`), the same shape as the sandbox's; `npm run lint` runs it alone.
- **`reviewer-policy`** (`.github/workflows/reviewer-policy.yml`): who may approve whose PR, as a status rather than a habit; the owner's PRs need the agent's approval, the agent's need the owner's. Code-owned, so a PR cannot rewrite the policy that judges it.
- **`dependency-check`** (`.github/workflows/dependency-check.yml`), on every pull request: what a lockfile change brings in, judged before it merges: GitHub's dependency review, registry signatures and provenance, and the repo's own reader `scripts/lockfile-check.mjs` (install scripts, releases under seven days old, publisher changes, tarballs off the registry, and an integrity that changed under the same version or is not the registry's for that version refuse; exceptions are reviewed lines in `.github/dependency-allow.json`, each naming the one rule it excuses, integrity has none; the registry's answer is validated before it is judged). Green in seconds when no dependency file changed, so it can be required.
- **`audit`** (`.github/workflows/audit.yml`), daily and on demand: the lockfile against the advisory database, red at or above moderate; the owner's rule for every deployed repository. `npm run audit` is the same check by hand.

## Layout

- `src/policy.js`: compile and decide.
- `src/credentials.js`: the App JWT, the installation token source, the headers per credential kind.
- `src/proxy.js`: the streaming pass-through, the path and Location rewrites.
- `src/app.js`: the Express app and the role from the certificate and token.
- `src/sink.js`: the request log's sink, the bounded write-behind queue into the database.
- `src/database.js`: the database connection from the two secrets, the CA pinned.
- `src/server.js`: the mutual-TLS server, the sink wired to the log, the start probe.
- `config/`: upstreams and the policy table, the two files that are the whole configuration.
- `db/schema.sql`: the two tables and the insert-only grant, applied once by the owner.
- `test/`: policy decisions, the proxy against a fake upstream, the credentials, the sink against a fake database, the connection's CA pin against pg itself.
- `scripts/audit.sh`: the dependency check for a cron.
- `scripts/certs.sh`: the private root, the server certificate, a client certificate and token per role.
- `scripts/deploy-droplet.sh`: the deploy on a Droplet, run there as root.
- `Dockerfile`: the image, the same in every shape.

## Not in the first slice

A ref-level policy on git pushes; the per-upstream rate limits; more roles (the backend instance of the agent, the site's own); the records endpoint; the daily digest read from the log's tables into the records repository. Each is a rule, a subdomain or a reader, not a redesign.
