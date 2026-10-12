#!/bin/bash
# Deploys the gateway on a Droplet (or any Linux host with Docker), run there as root, once per release.
# The host keeps no clone and no git: ONE reviewed tarball of this repository at the ref below is
# downloaded over HTTPS from GitHub, its archive name checked against the commit, the image built from it,
# and the container replaced. Secrets never enter the image or the container's environment: they are
# files in SECRETS on the host, mounted read-only, and the env file names them (src/env.js reads
# <NAME>_FILE). Nothing here is read from the environment; a change is a PR to this block.
#
# Before the first run, as root on the host:
#   mkdir -m 700 /etc/cocoon-gateway        # every file below lives HERE on this host; the container sees
#                                           # the same directory at the same path, mounted read-only
#   # from the owner's machine (scripts/certs.sh): server.key, server.crt, root.crt; the App's private key
#   # as app.pem; one <role>.token per role; then:
#   cat > /etc/cocoon-gateway/env <<'ENV'
#   GITHUB_APP_ID=<the App's id>
#   GITHUB_APP_INSTALLATION_ID=<its installation id on the account: the number in the App's installation page URL>
#   GITHUB_APP_PRIVATE_KEY_FILE=/etc/cocoon-gateway/app.pem
#   GATEWAY_TLS_KEY_FILE=/etc/cocoon-gateway/server.key
#   GATEWAY_TLS_CERT_FILE=/etc/cocoon-gateway/server.crt
#   GATEWAY_CLIENT_CA_FILE=/etc/cocoon-gateway/root.crt
#   GATEWAY_TOKEN_CLAUDE_FILE=/etc/cocoon-gateway/claude.token
#   ENV
#   chown -R 1000:1000 /etc/cocoon-gateway && chmod 600 /etc/cocoon-gateway/*
# The container runs as the image's `node` user, uid 1000, which is why the files are owned by that uid on
# the host (an unused uid there). The Cloud Firewall in front admits 443 and 8443 from the sandbox host's address only.
set -euo pipefail

# --- Everything this script knows, in one place ---------------------------------------------
REPO=theCocoonStudio/cocoon-gateway
REF=main                         # the ref deployed; a tag once releases are cut (a PR changes it)
IMAGE=cocoon-gateway
NAME=cocoon-gateway
SECRETS=/etc/cocoon-gateway      # the env file and the mounted files, owned by uid 1000, mode 600; mounted into the
                                 # container at this same path, so the env file names the files where the host sees them
PORT=443                         # the host port for clients that present the client certificate themselves; the container listens on 8443
RELAY_PORT=8443                  # the same listener published a second time, for the sandbox's in-container relay: inside the container
                                 # port 443 to the gateway's address is redirected to the relay, so the relay dials a port that is not (8443)
API=https://api.github.com/repos
TOOLS=(
  curl    # the commit lookup and the tarball
  tar     # unpacking it
  jq      # the commit sha out of JSON
  docker  # the build and the run
)
for tool in "${TOOLS[@]}"; do
  command -v "$tool" >/dev/null || { echo "deploy: '$tool' is required" >&2; exit 1; }
done
[ "$(id -u)" = 0 ] || { echo "deploy: run as root (docker and $SECRETS)" >&2; exit 1; }
# The env file is in the loop with the secrets: the same owner check, since the header prescribes the
# same chown for every file in SECRETS (the owner, 2026-10-11).
for f in env app.pem server.key server.crt root.crt claude.token; do
  [ -r "$SECRETS/$f" ] || { echo "deploy: $SECRETS/$f is missing" >&2; exit 1; }
  [ "$(stat -c %u "$SECRETS/$f")" = 1000 ] || { echo "deploy: $SECRETS/$f must be owned by uid 1000 (the container's user)" >&2; exit 1; }
done

# The env file names the files at the host path (the mount keeps it); an entry under /run/cocoon-gateway is the
# shape before 2026-10-12 and would point the container at nothing: refused, with the one-line fix.
if grep -q -- /run/cocoon-gateway "$SECRETS/env"; then
  echo "deploy: $SECRETS/env names /run/cocoon-gateway; the files are mounted at $SECRETS now: sed -i 's|/run/cocoon-gateway|$SECRETS|' $SECRETS/env" >&2; exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "${tmp:?}"' EXIT
# A 200 is not trusted to carry a commit: the sha is taken only if it is a 40-digit hex string, and
# checked again after the pipe (an empty answer would make the tarball URL the default branch's).
sha=$(curl -fsSL -H "Accept: application/vnd.github+json" "$API/$REPO/commits/$REF" \
      | jq -r 'if (.sha | type == "string" and test("^[0-9a-f]{40}$")) then .sha else error("no commit sha in the response") end')
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy: $REPO@$REF: the commit lookup did not return a commit sha" >&2; exit 1; }
curl -fsSL "$API/$REPO/tarball/$sha" -o "$tmp/src.tgz"
top=$(tar -tzf "$tmp/src.tgz" | awk -F/ 'NR == 1 { print $1 }')
case "$sha" in "${top##*-}"*) ;; *) echo "deploy: archive $top does not match commit $sha" >&2; exit 1 ;; esac
tar -xzf "$tmp/src.tgz" -C "$tmp"
echo "deploy: $REPO@$REF is $sha"

docker build -t "$IMAGE:$sha" -t "$IMAGE:latest" "$tmp/$top"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -p "$PORT:8443" -p "$RELAY_PORT:8443" \
  -v "$SECRETS:$SECRETS:ro" \
  --env-file "$SECRETS/env" \
  --health-cmd 'node -e "fetch(\"http://127.0.0.1:8080/healthz\").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"' \
  --health-interval 30s --health-timeout 5s --health-retries 3 \
  "$IMAGE:$sha"
sleep 3
docker ps --filter "name=$NAME" --format 'deploy: {{.Names}} {{.Status}} {{.Ports}}'
docker logs "$NAME" 2>&1 | tail -3
