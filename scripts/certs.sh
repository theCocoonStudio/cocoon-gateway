#!/bin/bash
# The gateway's certificates, made by the owner on their own machine with openssl; nothing here touches a
# repository and every private key is written mode 600. The private root is the trust anchor on both sides:
# the gateway presents a server certificate signed by it, every container presents a client certificate
# signed by it, and each side verifies the other against the root's public half alone. The root's KEY stays
# where this script made it (the owner's machine); the gateway host gets server.key, server.crt and root.crt;
# a sandbox host gets root.crt, <role>.key, <role>.crt and <role>.token. Refuses to overwrite anything.
# Beside them appears root.srl: openssl's serial-number file, made by -CAcreateserial at the first signing
# and incremented at each, so every certificate the root signs carries a distinct serial (two certificates
# with one serial from one root are refused by some clients). Not a secret, not needed by any host, kept
# with the root's key. The .csr requests are written and removed within the same step.
#
#   certs.sh root   <dir>                        root.key, root.crt      (10 years)
#   certs.sh server <dir> <domain> <name>...     server.key, server.crt  for <name>.<domain> of every upstream
#                                                 (the keys of config/upstreams.json), 825 days
#   certs.sh client <dir> <role>                 <role>.key, <role>.crt with CN=<role> (clientAuth), 825 days,
#                                                 and <role>.token: 32 random bytes as hex, the role's bearer token
#
# Keys are EC P-256 (fast, small, accepted by Node's TLS and by OpenSSL and LibreSSL alike). Extensions go
# through a config file rather than -addext, which macOS's LibreSSL lacks; bash 3.2 suffices.
set -euo pipefail

TOOLS=(
  openssl   # keys, requests, signing
)
for tool in "${TOOLS[@]}"; do
  command -v "$tool" >/dev/null || { echo "certs: '$tool' is required" >&2; exit 1; }
done

usage() { sed -n '2,20p' "$0" >&2; exit 1; }
[ $# -ge 2 ] || usage
cmd=$1; dir=$2; shift 2
mkdir -p -- "$dir"
chmod 700 -- "$dir"

fresh() { # refuse to overwrite: a certificate replaced by accident is a trust change nobody reviewed
  for f in "$@"; do [ -e "$dir/$f" ] && { echo "certs: $dir/$f exists; remove it yourself first" >&2; exit 1; }; done
  return 0
}
newkey() { # EC P-256 private key, mode 600 from the first byte
  (umask 077 && openssl ecparam -name prime256v1 -genkey -noout -out "$1")
}

case "$cmd" in
  root)
    fresh root.key root.crt
    newkey "$dir/root.key"
    ext=$(mktemp); trap 'rm -f "${ext:?}"' EXIT
    printf '[req]\ndistinguished_name=dn\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > "$ext"
    openssl req -x509 -new -key "$dir/root.key" -sha256 -days 3650 -subj "/CN=cocoon gateway root" \
      -config "$ext" -extensions v3_ca -out "$dir/root.crt"
    echo "certs: root written: $dir/root.key (600, keep it here) and $dir/root.crt (public, goes everywhere); root.srl, the serial counter, appears at the first signing and stays here too"
    ;;
  server)
    [ $# -ge 2 ] || usage
    domain=$1; shift
    fresh server.key server.crt
    { [ -r "$dir/root.key" ] && [ -r "$dir/root.crt" ]; } || { echo "certs: no root in $dir; run 'certs.sh root $dir' first" >&2; exit 1; }
    san=""
    for name in "$@"; do san="${san:+$san,}DNS:$name.$domain"; done
    newkey "$dir/server.key"
    ext=$(mktemp); trap 'rm -f "${ext:?}"' EXIT
    printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$san" > "$ext"
    openssl req -new -key "$dir/server.key" -subj "/CN=gateway.$domain" -out "$dir/server.csr"
    openssl x509 -req -in "$dir/server.csr" -CA "$dir/root.crt" -CAkey "$dir/root.key" -CAcreateserial -sha256 -days 825 \
      -extfile "$ext" -out "$dir/server.crt"
    rm -f -- "$dir/server.csr"
    echo "certs: server written for $san: $dir/server.key (600) and $dir/server.crt; copy both with root.crt to the gateway host"
    ;;
  client)
    [ $# -eq 1 ] || usage
    role=$1
    case "$role" in *[!a-z0-9-]*|'') echo "certs: a role is lowercase letters, digits and dashes" >&2; exit 1 ;; esac
    fresh "$role.key" "$role.crt" "$role.token"
    { [ -r "$dir/root.key" ] && [ -r "$dir/root.crt" ]; } || { echo "certs: no root in $dir; run 'certs.sh root $dir' first" >&2; exit 1; }
    newkey "$dir/$role.key"
    ext=$(mktemp); trap 'rm -f "${ext:?}"' EXIT
    printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' > "$ext"
    openssl req -new -key "$dir/$role.key" -subj "/CN=$role" -out "$dir/$role.csr"
    openssl x509 -req -in "$dir/$role.csr" -CA "$dir/root.crt" -CAkey "$dir/root.key" -CAcreateserial -sha256 -days 825 \
      -extfile "$ext" -out "$dir/$role.crt"
    rm -f -- "$dir/$role.csr"
    (umask 077 && openssl rand -hex 32 > "$dir/$role.token")
    echo "certs: client written for role '$role': $dir/$role.key (600), $dir/$role.crt, $dir/$role.token (600); the sandbox host gets these with root.crt, the gateway host gets a copy of the token as GATEWAY_TOKEN_$(printf '%s' "$role" | tr 'a-z-' 'A-Z_')"
    ;;
  *) usage ;;
esac
