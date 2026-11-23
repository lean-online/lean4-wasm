#!/usr/bin/env bash
# 解析或按官方 Lean v4.36.0 同源 commit 构建异构纯 Rust 独立内核 nanoda_bin，
# 并在 stdout 输出可执行文件路径（日志写到 stderr）。
set -euo pipefail

ROOT="${1:?usage: ensure-nanoda.sh <foundryRoot> [bootDir]}"
BOOT="${2:-}"
NANODA_REV="4c544ed4099c8227f07d5de77ad1e69fb0740a27"

if [ -n "$BOOT" ] && [ -x "$BOOT/bin/nanoda_bin" ]; then
  printf '%s\n' "$BOOT/bin/nanoda_bin"
  exit 0
fi

CACHE_DIR="$ROOT/work/nanoda-bin"
OUT="$CACHE_DIR/nanoda_bin"
if [ -x "$OUT" ]; then
  printf '%s\n' "$OUT"
  exit 0
fi

if [ ! -x "$(command -v cargo || true)" ] && [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

command -v cargo > /dev/null 2>&1 || {
  echo "缺少 cargo，无法构建 ammkrn/nanoda_lib ($NANODA_REV)" >&2
  exit 1
}

TMP_SRC="$ROOT/work/nanoda-src"
rm -rf "$TMP_SRC"
mkdir -p "$CACHE_DIR"
git clone --depth 1 https://github.com/ammkrn/nanoda_lib.git "$TMP_SRC" >&2
git -C "$TMP_SRC" fetch --depth 1 origin "$NANODA_REV" >&2
git -C "$TMP_SRC" checkout -q "$NANODA_REV" >&2
cargo build --manifest-path "$TMP_SRC/Cargo.toml" --release --locked >&2
cp "$TMP_SRC/target/release/nanoda_bin" "$OUT"
chmod +x "$OUT"
rm -rf "$TMP_SRC"

printf '%s\n' "$OUT"
