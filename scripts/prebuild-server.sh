#!/usr/bin/env bash
# Makes the prebuilt server package of one architecture from the plain one: its production dependencies are
# installed the way an in-app upgrade would install them, so that the upgrade can skip that step. Run inside
# the deploy image's `node` stage on a machine of that architecture, which has the image's Node, glibc and
# compilers; prebuilt.json records what the native modules were built for, and the upgrader checks it.
#   prebuild-server.sh <cc-desk-tunnel-server-X.Y.Z.tar.gz> <cc-desk-tunnel-server-X.Y.Z-linux-ARCH.tar.gz>
set -euo pipefail
input="$1"
output="$2"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
tar -xzf "$input" -C "$work" --no-same-owner
cd "$work"
# Building node-pty downloads Node's headers, which now and then breaks off; it is tried a second time.
install() { npm ci --omit=dev --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol; }
install || { sleep 20 && install; }
# node-pty ships prebuilt binaries for Windows and macOS only; on Linux it loads the one built above.
rm -rf node_modules/node-pty/prebuilds
native='["node-pty"]'
(cd apps/server && NATIVE="$native" node -e 'for (const name of JSON.parse(process.env.NATIVE)) require(name)')
NATIVE="$native" node -e '
  const { platform, arch, version: node, versions } = process;
  const meta = { platform, arch, modules: versions.modules, node, native: JSON.parse(process.env.NATIVE) };
  require("node:fs").writeFileSync("prebuilt.json", JSON.stringify(meta, null, 2) + "\n");
  console.log(JSON.stringify(meta));
'
case "$(node -p process.arch)" in
  x64 | arm64) [[ "$output" == *"-linux-$(node -p process.arch).tar.gz" ]] || { echo "$output is not for $(node -p process.arch)" >&2; exit 1; } ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac
tar -czf "$output" --sort=name --owner=0 --group=0 --numeric-owner -C "$work" .
ls -l "$output"
