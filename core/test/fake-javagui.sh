#!/bin/sh
# Stand-in for the SAP GUI for Java launcher in adapter tests:
#   fake-javagui.sh [other args] -f <bundle.js>
# Prepends the SAP GUI mock (as the global `application`) to the bundle and
# runs it in Rhino, the engine SAP GUI for Java embeds.
# Env: RHINO_JAR (default /root/tools/rhino.jar), FAKE_SAP_OPTIONS (JSON).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bundle=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-f" ]; then shift; bundle="$1"; fi
  shift
done
[ -n "$bundle" ] || { echo "fake-javagui: no -f <script>" >&2; exit 2; }
combined="$bundle.mock.js"
opts="${FAKE_SAP_OPTIONS:-}"
[ -n "$opts" ] || opts='{}'
{
  cat "$here/mock-sap.cjs"
  printf '\nvar application = createMockSap(%s);\n' "$opts"
  cat "$bundle"
} > "$combined"
exec java -jar "${RHINO_JAR:-/root/tools/rhino.jar}" -opt -1 "$combined"
