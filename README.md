# cocoon-gateway

The owner's API gateway for the agent sandbox. One host in the sandbox's wall instead of a list; one policy table that refuses what the rules forbid; every credential read from the platform's secrets by this process and none inside the container; a log line per request that is a witness the agent does not write.

Settled with the owner on 2026-10-11; the sandbox it serves is [cocoon-agent-sandbox](https://github.com/theCocoonStudio/cocoon-agent-sandbox).

## How a request travels

1. The container reaches one address, this gateway, over TLS 1.3 with a **client certificate** signed by the owner's private root; the certificate's common name is the role. A **bearer token** per role is checked as well: the certificate gets in, the token gets access.
2. The gateway routes by the **Host** header: one subdomain per upstream (`github.`, `git.`, `anthropic.`, `arxiv.`, ...). A Host it does not serve is answered 421 and never proxied; it is not an open proxy.
3. The **policy table** (`config/policy.json`) decides: rules of role, upstream, method and path pattern, first match wins, a final deny. Nothing lists a DELETE, so none passes.
4. The request is **proxied as a stream**: the body piped up and the response piped back byte for byte, so git's packs and the model's event streams survive. The client's own credentials never go up; the upstream's credential is injected here; Host is rewritten to the upstream's name; a request id is stamped and returned; Location headers in responses are rewritten back to the gateway's subdomains so a redirect stays inside the wall.
5. One **log line** per request: time, id, role, upstream, method, path, status, duration, bytes, the rule that allowed it.

## Upstreams and credentials

`config/upstreams.json` maps each subdomain to its upstream host, the credential kind to inject, and any path rewrite. GitHub's REST API is served enterprise-style so `gh` works unchanged with `GH_HOST` set to the subdomain: `/api/v3/...` and `/api/graphql` are rewritten to `api.github.com`. Git's smart HTTP goes to the `git` subdomain with the App's token as the basic credential; the push is passed through unparsed, GitHub's rulesets holding `main` and force pushes; a ref-level push policy is a later slice.

Credentials come from the process environment at start, set as the platform's secrets (DigitalOcean), never written to disk: the GitHub App's id, installation id and private key (the installation token is minted here and cached until five minutes before it expires, as the sandbox's `run.sh` once did on the box), the Anthropic key or auth token, the TLS key, certificate and the client root, and one `GATEWAY_TOKEN_<ROLE>` per role.

## Running

```
npm ci --ignore-scripts
npm test
npm start      # PORT, GATEWAY_TLS_KEY, GATEWAY_TLS_CERT, GATEWAY_CLIENT_CA, GITHUB_APP_*, ANTHROPIC_*, GATEWAY_TOKEN_* from the environment
npm run audit  # the scheduled dependency check: npm audit at or above "moderate" fails
```

Outside this process: the platform's IP filter admits the sandbox's address only; its change is an environment variable there and a rebuild. A client certificate per container, signed by the root, is the identity that does not depend on the address.

## What checks what

- **`check`** (`.github/workflows/check.yml`), on every pull request and on `main`: the tests and the dependency audit. Made a required status in the main ruleset, it binds.
- **`reviewer-policy`** (`.github/workflows/reviewer-policy.yml`): who may approve whose PR, as a status rather than a habit; the owner's PRs need the agent's approval, the agent's need the owner's. Code-owned, so a PR cannot rewrite the policy that judges it.
- **`dependency-check`** (`.github/workflows/dependency-check.yml`), on every pull request: what a lockfile change brings in, judged before it merges: GitHub's dependency review, registry signatures and provenance, and the repo's own reader `scripts/lockfile-check.mjs` (install scripts, releases under seven days old, publisher changes and tarballs off the registry refuse; exceptions are reviewed lines in `.github/dependency-allow.json`). Green in seconds when no dependency file changed, so it can be required.
- **`audit`** (`.github/workflows/audit.yml`), daily and on demand: the lockfile against the advisory database, red at or above moderate; the owner's rule for every deployed repository. `npm run audit` is the same check by hand.

## Layout

- `src/policy.js`: compile and decide.
- `src/credentials.js`: the App JWT, the installation token source, the headers per credential kind.
- `src/proxy.js`: the streaming pass-through, the path and Location rewrites.
- `src/app.js`: the Express app and the role from the certificate and token.
- `src/server.js`: the mutual-TLS server.
- `config/`: upstreams and the policy table, the two files that are the whole configuration.
- `test/`: policy decisions, the proxy against a fake upstream, the credentials.
- `scripts/audit.sh`: the dependency check for a cron.

## Not in the first slice

A ref-level policy on git pushes; the per-upstream rate limits; more roles (the backend instance of the agent, the site's own); the records endpoint. Each is a rule or a subdomain, not a redesign.
