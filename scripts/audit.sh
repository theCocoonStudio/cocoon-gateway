#!/bin/bash
# The scheduled dependency check (the CD rule, 2026-10-11): the lockfile against GitHub's advisory
# database through npm audit, which reports each finding with its severity and CVSS. Exit 1 at or
# above the threshold so a cron or a CI job turns red. Other databases (OSV, NVD, Snyk, Black Duck)
# are options for later; GitHub's lags the curated ones.
set -uo pipefail
THRESHOLD=${1:-moderate}   # low | moderate | high | critical
cd "$(dirname "$0")/.." || exit 1
npm audit --audit-level="$THRESHOLD" --json > audit.json; status=$?
# shellcheck disable=SC2016  # a JavaScript program in single quotes; nothing to expand
node -e '
const a = JSON.parse(require("fs").readFileSync("audit.json", "utf8"));
const v = a.metadata && a.metadata.vulnerabilities || {};
console.log("audit:", JSON.stringify(v));
for (const [name, d] of Object.entries(a.vulnerabilities || {})) console.log(" -", name, d.severity, (d.via || []).map((x) => (typeof x === "object" ? `${x.title} (${x.cvss && x.cvss.score})` : x)).join("; "));
'
rm -f audit.json
exit $status
