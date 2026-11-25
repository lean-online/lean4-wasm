#!/usr/bin/env bash
# 把 wasm-llvm 的 lean-browser 构建脚本改成「直接编译软 Fork 仓根源码」的 wasm32 版本（ADR-06）。
# 用法: bash scripts/patch-wasm32.sh <foundryRoot>
#
# 与 patch-wasm64.sh 的差异（刻意保留）：不碰 -sMEMORY64=1、不加 -mtail-call、不开 USE_GMP，
# 也不改 INITIAL_MEMORY / PTHREAD_STACK_SIZE / EXIT_RUNTIME —— 这些是 wasm32 生产运行时
# 已经在线上验证过的参数，只把「源码来源」从上游 tag+外部 patch 换成仓根 v4.36.0 软 Fork。
#
# LEAN_GITHASH_OVERRIDE="$LEAN_COMMIT"：软 Fork 自带显式工作栈等原生 Commit，直接读 HEAD 会写出
# 本仓 sha1，和官方 4.36.0 引导包编译出的 .olean / Mathlib4 缓存 ABI 对不上。
set -euo pipefail
ROOT="${1:?usage: patch-wasm32.sh <foundryRoot>}"
SCRIPT="$ROOT/wasm-llvm/producer/lean-browser/scripts/build.sh"

if grep -q 'WASM_LLVM_LEAN_SRC_DIR' "$SCRIPT" && grep -q 'LEAN_GITHASH_OVERRIDE' "$SCRIPT"; then
  echo "build.sh 已打过 wasm32 补丁，跳过"
  exit 0
fi

PY=python3
command -v python3 > /dev/null 2>&1 || PY=python

"$PY" - "$SCRIPT" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()

def replace_once(src: str, old: str, new: str, label: str) -> str:
    if new in src:
        return src
    if old not in src:
        raise SystemExit(f"patch-wasm32.sh 找不到锚点: {label}")
    return src.replace(old, new, 1)

# 软 Fork 直编开关：设置 WASM_LLVM_LEAN_SRC_DIR 时直接指向仓根源码，跳过 fetch 克隆与补丁校验，
# 只下载/校验官方引导包。
text = replace_once(
    text,
    'SRC="$WORK/lean4"',
    'SRC="${WASM_LLVM_LEAN_SRC_DIR:-$WORK/lean4}"',
    "SRC 变量",
)
text = replace_once(
    text,
    'stage_fetch() {\n\techo "$PATCH_SHA  $PATCH" | sha256sum -c --quiet -\n',
    'stage_fetch() {\n\tif [ -z "${WASM_LLVM_LEAN_SRC_DIR:-}" ]; then\n\techo "$PATCH_SHA  $PATCH" | sha256sum -c --quiet -\n',
    "stage_fetch 起始",
)
text = replace_once(
    text,
    '\t[ -z "$(git -C "$SRC" ls-files --others --exclude-standard)" ] || { echo "lean4 checkout has untracked files" >&2; exit 1; }\n',
    '\t[ -z "$(git -C "$SRC" ls-files --others --exclude-standard)" ] || { echo "lean4 checkout has untracked files" >&2; exit 1; }\n\tfi\n',
    "stage_fetch 结束",
)

# 只注入 githash 覆盖；LEAN_WASM64 保持默认 OFF，EMSCRIPTEN_SETTINGS 里就没有 -sMEMORY64=1。
text = replace_once(
    text,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_BUILD_TYPE=Release -DLEAN_GITHASH_OVERRIDE=\"$LEAN_COMMIT\"",
    "CMake Release/githash",
)

path.write_text(text)
PY

# 与 wasm32 生产一致的 -O3 优化；上游 recipe 默认是 -O2。
sed -i \
  -e 's|emcc -c -O2|emcc -c -O3|g' \
  -e 's|emcc -O2 -pthread|emcc -O3 -pthread|g' \
  "$SCRIPT"

for marker in '-O3' 'WASM_LLVM_LEAN_SRC_DIR' 'LEAN_GITHASH_OVERRIDE'; do
  grep -q -- "$marker" "$SCRIPT" || {
    echo "build.sh 缺少必需注入标记: $marker" >&2
    exit 1
  }
done
if grep -q -- 'MEMORY64' "$SCRIPT"; then
  echo "build.sh 仍带 -sMEMORY64=1，wasm32 产物会与 32 位 glue 不兼容" >&2
  exit 1
fi
grep -n -- '-O3\|WASM_LLVM_LEAN_SRC_DIR\|LEAN_GITHASH_OVERRIDE' "$SCRIPT"
