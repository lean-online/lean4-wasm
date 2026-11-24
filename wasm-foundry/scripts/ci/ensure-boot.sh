#!/usr/bin/env bash
# 确保与 scripts/pin-lean.ts 对齐的官方 Lean 引导包存在于 <foundryRoot>/work/lean-<version>-linux，
# 并在 stdout 输出其目录路径（日志写到 stderr）。
set -euo pipefail

ROOT="${1:?usage: ensure-boot.sh <foundryRoot>}"
PIN_JSON="$(FOUNDRY_ROOT="$ROOT" node --input-type=module -e 'import { resolve } from "node:path"; import { pathToFileURL } from "node:url"; const m = await import(pathToFileURL(resolve(process.env.FOUNDRY_ROOT, "scripts/pin-lean.ts")).href); process.stdout.write(JSON.stringify(m.resolveLeanPin()));')"
read -r VERSION COMMIT URL SHA <<<"$(node -e 'const p = JSON.parse(process.argv[1]); process.stdout.write([p.version, p.commit, p.bootstrapUrl, p.bootstrapSha256].join(" "))' "$PIN_JSON")"

WORK="$ROOT/work"
BOOT="$WORK/lean-$VERSION-linux"
mkdir -p "$WORK"

if [ ! -x "$BOOT/bin/lean" ]; then
  TARBALL="$WORK/$(basename "$URL")"
  if [ ! -f "$TARBALL" ]; then
    echo "下载官方 Lean 引导包: $URL" >&2
    curl -fL --retry 3 -o "$TARBALL.part" "$URL"
    mv "$TARBALL.part" "$TARBALL"
  fi
  echo "$SHA  $TARBALL" | sha256sum -c --quiet -
  zstd -dc "$TARBALL" | tar -x -C "$WORK"
  rm -f "$TARBALL"
fi

"$BOOT/bin/lean" --version | grep -q "version $VERSION," || {
  echo "引导包版本与 pin-lean.ts 不符: $BOOT" >&2
  exit 1
}
"$BOOT/bin/lean" --githash | grep -qx "$COMMIT" || {
  echo "引导包 githash 与 pin-lean.ts 不符: $BOOT" >&2
  exit 1
}

printf '%s\n' "$BOOT"
