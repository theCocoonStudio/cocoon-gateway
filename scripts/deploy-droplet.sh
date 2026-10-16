#!/bin/bash
# Deploys the gateway on a Droplet (or any Linux host with Docker), run there as root, once per release.
# The host keeps no clone and no git: ONE reviewed tarball of this repository at the ref below is
# downloaded over HTTPS from GitHub, its archive name checked against the commit, the image built from it,
# the new container created beside the old, swapped in and waited for until healthy, the previous image removed. Secrets never enter the image or the container's environment: they are
# files in SECRETS on the host, mounted read-only, and the env file names them (src/env.js reads
# <NAME>_FILE). Nothing here is read from the environment; a change is a PR to this block.
#
# Before the first run, as root on the host:
#   mkdir -m 700 /etc/cocoon-gateway        # every file below lives HERE on this host; the container sees
#                                           # the same directory at the same path, mounted read-only
#   # from the owner's machine (scripts/certs.sh): server.key, server.crt, root.crt; one <role>.token per role;
#   # one <role>-app.pem per role with GitHub rules (each role is its own GitHub App, 2026-10-16); then:
#   cat > /etc/cocoon-gateway/env <<'ENV'
#   GATEWAY_DOMAIN=<the parent of the gateway's subdomains, e.g. gw.example.com>
#   GITHUB_APP_CLAUDE_ID=<the claude App's id>
#   GITHUB_APP_CLAUDE_INSTALLATION_ID=<its installation id on the account: the number in the App's installation page URL>
#   GITHUB_APP_CLAUDE_PRIVATE_KEY_FILE=/etc/cocoon-gateway/claude-app.pem
#   GITHUB_APP_GEMINI_ID=<the gemini App's id>
#   GITHUB_APP_GEMINI_INSTALLATION_ID=<its installation id>
#   GITHUB_APP_GEMINI_PRIVATE_KEY_FILE=/etc/cocoon-gateway/gemini-app.pem
#   GATEWAY_TLS_KEY_FILE=/etc/cocoon-gateway/server.key
#   GATEWAY_TLS_CERT_FILE=/etc/cocoon-gateway/server.crt
#   GATEWAY_CLIENT_CA_FILE=/etc/cocoon-gateway/root.crt
#   GATEWAY_TOKEN_CLAUDE_FILE=/etc/cocoon-gateway/claude.token
#   GATEWAY_TOKEN_GEMINI_FILE=/etc/cocoon-gateway/gemini.token
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
for f in env server.key server.crt root.crt claude.token gemini.token claude-app.pem gemini-app.pem; do   # one <role>.token per role in config/policy.json, one <role>-app.pem per role with GitHub rules; the server refuses to start without each
  [ -r "$SECRETS/$f" ] || { echo "deploy: $SECRETS/$f is missing" >&2; exit 1; }
  [ "$(stat -c %u "$SECRETS/$f")" = 1000 ] || { echo "deploy: $SECRETS/$f must be owned by uid 1000 (the container's user)" >&2; exit 1; }
done

# The env file names the files at the host path (the mount keeps it); an entry under /run/cocoon-gateway is the
# shape before 2026-10-12 and would point the container at nothing: refused, with the one-line fix.
if grep -q -- /run/cocoon-gateway "$SECRETS/env"; then
  echo "deploy: $SECRETS/env names /run/cocoon-gateway; the files are mounted at $SECRETS now: sed -i 's|/run/cocoon-gateway|$SECRETS|' $SECRETS/env" >&2; exit 1
fi
# The App is per role since 2026-10-16 (one App served every role before, so a second role acted as the first's
# bot on GitHub): the unsuffixed names are the old shape and would start nothing; refused, with the fix.
if grep -qE '^GITHUB_APP_(ID|INSTALLATION_ID|PRIVATE_KEY|PRIVATE_KEY_FILE)=' "$SECRETS/env"; then
  echo "deploy: $SECRETS/env carries GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID or GITHUB_APP_PRIVATE_KEY_FILE; the App is per role: GITHUB_APP_CLAUDE_*, GITHUB_APP_GEMINI_* (docs/deploy.md step 5)" >&2; exit 1
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
# The swap, in three moves, so the old gateway serves until the new one has proven it starts, and comes
# back if the new one fails anyway. Until 2026-10-16 the old container was removed before the new one had
# started: a deploy whose env file had lost nine of its twelve lines then left no gateway at all for forty
# minutes (the new one crashed at start, the old one was gone, the image kept was useless without the env).
#   1. The probe: the new image is started once beside the old one with no port published (so nothing
#      collides), the same env file and mounts, and must reach healthy within 60 s; a crash at start, a
#      missing variable, an unreadable file all fail here, with the container's first lines printed, while
#      the old one still serves. The probe is removed either way.
#   2. The real container is created with the ports (a wrong option fails here too, old one still up),
#      the old one is STOPPED and kept under a side name, the new one takes the name and starts, and the
#      deploy waits for its health check.
#   3. Healthy: the stopped old container and the previous image go. Not healthy: the new one is removed,
#      the old one gets its name back and is started again, and the deploy exits 1 saying so.
COMMON=(--restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
  -v "$SECRETS:$SECRETS:ro" --env-file "$SECRETS/env"
  --health-cmd 'node -e "fetch(\"http://127.0.0.1:8080/healthz\").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"'
  --health-interval 30s --health-timeout 5s --health-retries 3 --health-start-period 30s --health-start-interval 3s)
wait_healthy() { # wait_healthy <container>: prints the final state; healthy within 60 s or not
  local state=unknown
  for _ in $(seq 1 20); do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo unknown)
    [ "$state" = healthy ] && break
    sleep 3
  done
  echo "$state"
}
previous=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)

docker rm -f "$NAME-probe" "$NAME-next" "$NAME-previous" >/dev/null 2>&1 || true
docker create --name "$NAME-probe" "${COMMON[@]}" "$IMAGE:$sha" >/dev/null
docker start "$NAME-probe" >/dev/null
state=$(wait_healthy "$NAME-probe")
if [ "$state" != healthy ]; then
  echo "deploy: the probe start of $IMAGE:$sha is '$state' after 60 s; the running gateway was not touched. Its first lines:" >&2
  docker logs "$NAME-probe" 2>&1 | head -8 >&2
  docker rm -f "$NAME-probe" >/dev/null 2>&1 || true
  exit 1
fi
docker rm -f "$NAME-probe" >/dev/null
echo "deploy: probe start healthy; swapping"

docker create --name "$NAME-next" "${COMMON[@]}" -p "$PORT:8443" -p "$RELAY_PORT:8443" "$IMAGE:$sha" >/dev/null
had_old=0
if docker inspect "$NAME" >/dev/null 2>&1; then
  had_old=1
  docker stop "$NAME" >/dev/null
  docker rename "$NAME" "$NAME-previous"
fi
docker rename "$NAME-next" "$NAME"
docker start "$NAME" >/dev/null
state=$(wait_healthy "$NAME")
docker ps --filter "name=^$NAME$" --format 'deploy: {{.Names}} {{.Status}} {{.Ports}}'
docker logs "$NAME" 2>&1 | tail -3
if [ "$state" != healthy ]; then
  echo "deploy: $NAME is '$state' after 60 s; rolling back" >&2
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "$had_old" = 1 ]; then
    docker rename "$NAME-previous" "$NAME"
    docker start "$NAME" >/dev/null
    echo "deploy: the previous container is serving again (${previous:-(unknown image)})" >&2
  fi
  exit 1
fi
if [ "$had_old" = 1 ]; then docker rm -f "$NAME-previous" >/dev/null 2>&1 || true; fi
if [ -n "$previous" ] && [ "$previous" != "$IMAGE:$sha" ]; then
  if docker image rm "$previous" >/dev/null 2>&1; then echo "deploy: previous image $previous removed"; else echo "deploy: previous image $previous kept (in use, or already gone)"; fi
fi
