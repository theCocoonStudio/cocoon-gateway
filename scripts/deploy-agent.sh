#!/bin/bash
# Deploys the scene agent beside the gateway on the Droplet, run there as root after scripts/deploy-droplet.sh
# (docs/deploy.md step 9; docs/scene-agent.spec.md meta.runtime, sec.2, sec.3, sec.5). The agent is a second
# container from the image the gateway runs, with a different command, so both halves are one commit: this
# script downloads nothing and refuses to run without a healthy gateway. Secrets never enter the image or the
# container's environment: they are files in SECRETS on the host, mounted read-only, and the env file names
# them (src/env.js reads <NAME>_FILE). The gateway's directory is not mounted here: the agent never sees the App
# keys or the model key (sec.2). Nothing here is read from the environment; a change is a PR to this block.
#
# The agent reaches the gateway and nothing else (sec.3), by four lines, each explained where it is:
#   the network: a bridge of its own, $NET (its interface $BRIDGE), with a fixed subnet, that the gateway joins
#     at $GATEWAY_IP (scripts/deploy-droplet.sh connects every new gateway container there) while the agent's
#     containers take their addresses from $AGENT_RANGE, the rest of the subnet, so a source address tells the
#     two apart; the agent dials the gateway by its container name on port 8443, the container's own listener
#     (AGENT_GATEWAY_ADDRESS in env);
#   the forward rule: one iptables line in DOCKER-USER, the chain Docker leaves to the host, refusing every NEW
#     connection from $AGENT_RANGE to anything but the gateway's address (REJECT, so a stray dial fails at
#     once with a refusal instead of hanging on a DROP); Docker's embedded DNS forwards a container's outside
#     lookups from the container's own namespace, so a lookup of an outside name is such a connection and is
#     refused with the rest; the site's backend reaches the agent on 8444 through Docker's port publishing,
#     whose replies are ESTABLISHED and pass;
#   the input rule: the same refusal in INPUT for a new connection arriving on $BRIDGE from $AGENT_RANGE,
#     since a dial to the host itself (whatever listens on the Droplet, sshd among it) is delivered locally
#     and never crosses FORWARD, where the first rule sits; a reply to a connection the host opened (your own
#     curl to 127.0.0.1:8444 through docker-proxy) is ESTABLISHED and passes;
#   the unit: a oneshot systemd unit ordered before docker.service that makes the DOCKER-USER chain if Docker
#     has not yet (Docker keeps a chain that exists and never flushes this one) and puts both rules in place at
#     every boot, since iptables rules live in the kernel and a reboot forgets them while the containers come
#     back on their own (--restart unless-stopped) as the daemon starts: before it, so there is no moment with
#     the containers up and no rule; the deploy writes the unit, enables it and runs it, the same lines.
#
# Before the first run, as root on the host:
#   mkdir -m 700 /etc/cocoon-agent           # every file below lives HERE on this host; the container sees the same
#                                            # directory at the same path, mounted read-only
#   # from the owner's machine (scripts/certs.sh): root.crt; site.key, site.crt and site.token (the site role's client
#   # set, the token the same bytes as the gateway's /etc/cocoon-gateway/site.token); agent.key and agent.crt
#   # (certs.sh service ... agent, the certificate the site's backend verifies against root.crt); backend.token
#   # (openssl rand -hex 32, the bearer the backend presents, the same bytes in the site platform's secret); then:
#   cat > /etc/cocoon-agent/env <<'ENV'
#   GATEWAY_DOMAIN=<the gateway's domain, the same as the gateway's env>
#   AGENT_GATEWAY_ADDRESS=cocoon-gateway:8443
#   AGENT_GATEWAY_CERT_FILE=/etc/cocoon-agent/site.crt
#   AGENT_GATEWAY_KEY_FILE=/etc/cocoon-agent/site.key
#   AGENT_GATEWAY_TOKEN_FILE=/etc/cocoon-agent/site.token
#   GATEWAY_CLIENT_CA_PUBLIC_FILE=/etc/cocoon-agent/root.crt
#   AGENT_TLS_KEY_FILE=/etc/cocoon-agent/agent.key
#   AGENT_TLS_CERT_FILE=/etc/cocoon-agent/agent.crt
#   AGENT_SITE_TOKEN_FILE=/etc/cocoon-agent/backend.token
#   AGENT_PRICE_INPUT_PER_MILLION_USD=<the pinned model's input price, USD per million tokens, from its price page>
#   AGENT_PRICE_OUTPUT_PER_MILLION_USD=<its output price>
#   ENV
#   chown -R 1000:1000 /etc/cocoon-agent && chmod 600 /etc/cocoon-agent/*
# The container runs as the image's `node` user, uid 1000, hence the ownership. The Cloud Firewall in front
# admits 8444 from the site platform's addresses only (sec.5); the token is the second lock, not the only one.
set -euo pipefail

# --- Everything this script knows, in one place ---------------------------------------------
IMAGE=cocoon-gateway             # the gateway's image; the tag deployed is read off the running gateway container
GATEWAY=cocoon-gateway           # the gateway container's name, the host name the agent dials on $NET
NAME=cocoon-agent
SECRETS=/etc/cocoon-agent        # the env file and the mounted files, owned by uid 1000, mode 600; mounted into the
                                 # container at this same path, so the env file names the files where the host sees them
PORT=8444                        # the host port the site's backend calls; the container listens on 8444 too
NET=cocoon-agent                 # the network the two containers share
SUBNET=172.30.0.0/29             # eight addresses: .1 the bridge, .2 the gateway, .4 to .6 the agent and its probe
GATEWAY_IP=172.30.0.2            # the gateway's address on $NET (scripts/deploy-droplet.sh repeats both values, by name)
AGENT_RANGE=172.30.0.4/30        # where Docker hands the agent's containers their addresses: never the gateway's
BRIDGE=br-cocoon-agent           # the network's interface on the host, named so the input rule can name it
UNIT=/etc/systemd/system/cocoon-agent-egress.service
TOOLS=(
  docker    # the run
  iptables  # the egress rule (Docker's own dependency: its rules go through the same binary)
  systemctl # the unit that restores the rule at boot
)
for tool in "${TOOLS[@]}"; do
  command -v "$tool" >/dev/null || { echo "deploy-agent: '$tool' is required" >&2; exit 1; }
done
[ "$(id -u)" = 0 ] || { echo "deploy-agent: run as root (docker, iptables and $SECRETS)" >&2; exit 1; }
for f in env root.crt site.key site.crt site.token agent.key agent.crt backend.token; do
  [ -r "$SECRETS/$f" ] || { echo "deploy-agent: $SECRETS/$f is missing" >&2; exit 1; }
  [ "$(stat -c %u "$SECRETS/$f")" = 1000 ] || { echo "deploy-agent: $SECRETS/$f must be owned by uid 1000 (the container's user)" >&2; exit 1; }
done
for key in GATEWAY_DOMAIN AGENT_GATEWAY_ADDRESS AGENT_GATEWAY_CERT_FILE AGENT_GATEWAY_KEY_FILE AGENT_GATEWAY_TOKEN_FILE GATEWAY_CLIENT_CA_PUBLIC_FILE AGENT_TLS_KEY_FILE AGENT_TLS_CERT_FILE AGENT_SITE_TOKEN_FILE AGENT_PRICE_INPUT_PER_MILLION_USD AGENT_PRICE_OUTPUT_PER_MILLION_USD; do
  grep -q "^$key=" "$SECRETS/env" || { echo "deploy-agent: $SECRETS/env has no $key line (the header of this script lists every line)" >&2; exit 1; }
done

# The image is the one the gateway runs: the agent never runs a commit the gateway does not.
[ "$(docker inspect -f '{{.State.Health.Status}}' "$GATEWAY" 2>/dev/null || echo none)" = healthy ] || { echo "deploy-agent: $GATEWAY is not healthy; run scripts/deploy-droplet.sh first" >&2; exit 1; }
tag=$(docker inspect -f '{{.Config.Image}}' "$GATEWAY")
case "$tag" in "$IMAGE:"*) ;; *) echo "deploy-agent: $GATEWAY runs '$tag', not an $IMAGE image" >&2; exit 1 ;; esac
echo "deploy-agent: the gateway runs $tag"

# The network, once; the gateway joins it at its fixed address, once (every later gateway container joins at its
# own deploy). A gateway already on it keeps its place.
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$SUBNET" --ip-range "$AGENT_RANGE" --opt "com.docker.network.bridge.name=$BRIDGE" "$NET" >/dev/null
  echo "deploy-agent: network $NET created on $SUBNET ($BRIDGE), the agent's addresses from $AGENT_RANGE"
fi
if ! docker inspect -f '{{json .NetworkSettings.Networks}}' "$GATEWAY" | grep -q "\"$NET\""; then
  docker network connect --ip "$GATEWAY_IP" "$NET" "$GATEWAY"
  echo "deploy-agent: $GATEWAY joined $NET at $GATEWAY_IP"
fi

# The two egress rules and their unit (the header's four lines). `iptables -C` answers whether the exact rule is
# present, so each insert runs once however many times this runs; the unit runs the same commands at boot, before
# Docker, making the chain itself if it is not there yet.
FORWARD_RULE=(DOCKER-USER -s "$AGENT_RANGE" ! -d "$GATEWAY_IP" -m conntrack --ctstate NEW -j REJECT)
INPUT_RULE=(INPUT -i "$BRIDGE" -s "$AGENT_RANGE" -m conntrack --ctstate NEW -j REJECT)
iptables -N DOCKER-USER 2>/dev/null || true
iptables -C "${FORWARD_RULE[@]}" 2>/dev/null || iptables -I "${FORWARD_RULE[@]}"
iptables -C "${INPUT_RULE[@]}" 2>/dev/null || iptables -I "${INPUT_RULE[@]}"
cat > "$UNIT" <<UNIT
[Unit]
Description=cocoon-agent: the agent's containers reach the gateway and nothing else (two iptables rules; scripts/deploy-agent.sh)
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -N DOCKER-USER 2>/dev/null; iptables -C ${FORWARD_RULE[*]} 2>/dev/null || iptables -I ${FORWARD_RULE[*]}; iptables -C ${INPUT_RULE[*]} 2>/dev/null || iptables -I ${INPUT_RULE[*]}'

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cocoon-agent-egress.service >/dev/null 2>&1 || { echo "deploy-agent: the egress unit did not enable (systemctl status cocoon-agent-egress.service); the rules are in place for this boot only" >&2; exit 1; }
echo "deploy-agent: the two egress rules are in place (iptables -S DOCKER-USER; iptables -S INPUT | grep $BRIDGE); $UNIT restores them at boot"

# The swap, the gateway's three moves (scripts/deploy-droplet.sh): the probe beside the old agent with no port, healthy
# within 60 s or nothing is touched; then the old one stopped and kept, the new one named and started and waited for;
# healthy, the old one goes; not healthy, the new one goes and the old one serves again. The store is in memory
# (spec store.4): a swap starts every visitor at the template, as a restart would.
COMMON=(--restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
  --network "$NET" -v "$SECRETS:$SECRETS:ro" --env-file "$SECRETS/env"
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
if docker inspect "$NAME-previous" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none)" = healthy ]; then
    docker rm -f "$NAME-previous" >/dev/null 2>&1 || true
  else
    echo "deploy-agent: a previous run died mid-swap; restoring $NAME-previous as $NAME before this run" >&2
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker rename "$NAME-previous" "$NAME"
    docker start "$NAME" >/dev/null
    state=$(wait_healthy "$NAME")
    [ "$state" = healthy ] || { echo "deploy-agent: the restored container is '$state' after 60 s; stopping here, nothing else touched" >&2; exit 1; }
    echo "deploy-agent: restored; continuing"
  fi
fi
docker rm -f "$NAME-probe" "$NAME-next" >/dev/null 2>&1 || true
docker create --name "$NAME-probe" "${COMMON[@]}" "$tag" node src/agent-server.js >/dev/null
docker start "$NAME-probe" >/dev/null
state=$(wait_healthy "$NAME-probe")
if [ "$state" != healthy ]; then
  echo "deploy-agent: the probe start of $tag is '$state' after 60 s; the running agent, if any, was not touched. Its first lines:" >&2
  docker logs "$NAME-probe" 2>&1 | head -8 >&2
  docker rm -f "$NAME-probe" >/dev/null 2>&1 || true
  exit 1
fi
docker rm -f "$NAME-probe" >/dev/null
echo "deploy-agent: probe start healthy; swapping"

docker create --name "$NAME-next" "${COMMON[@]}" -p "$PORT:8444" "$tag" node src/agent-server.js >/dev/null
had_old=0
if docker inspect "$NAME" >/dev/null 2>&1; then
  had_old=1
  docker stop "$NAME" >/dev/null
  docker rename "$NAME" "$NAME-previous"
fi
docker rename "$NAME-next" "$NAME"
docker start "$NAME" >/dev/null
state=$(wait_healthy "$NAME")
docker ps --filter "name=^$NAME$" --format 'deploy-agent: {{.Names}} {{.Status}} {{.Ports}}'
docker logs "$NAME" 2>&1 | tail -3
if [ "$state" != healthy ]; then
  echo "deploy-agent: $NAME is '$state' after 60 s; rolling back" >&2
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "$had_old" = 1 ]; then
    docker rename "$NAME-previous" "$NAME"
    docker start "$NAME" >/dev/null
    echo "deploy-agent: the previous container is serving again" >&2
  fi
  exit 1
fi
if [ "$had_old" = 1 ]; then docker rm -f "$NAME-previous" >/dev/null 2>&1 || true; fi
