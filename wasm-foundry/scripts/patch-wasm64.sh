#!/usr/bin/env bash
# 把 wasm-llvm 的 lean-browser 构建脚本改成 wasm64 + GMP + tail call 版本，
# 并支持通过 WASM_LLVM_LEAN_SRC_DIR 直接构建软 Fork 仓根内的原生 Lean 源码。
# 用法: bash scripts/patch-wasm64.sh <foundryRoot>
#
# -mtail-call 打开 WebAssembly 尾调用（return_call）。wasm64 本身已经要求 Memory64，
# 浏览器范围早就被收窄过一次，再叠一个 tail-call 不会额外损失兼容性；
# 换来的是尾递归函数不再占栈（V8 因为 return_call 直接复用当前帧）。
#
# GMP 用 emcc 编成静态库放到 <foundryRoot>/work/gmp-install，
# Lean 的 CMake 通过 GMP_INSTALL_PREFIX 找 include/gmp.h 与 lib/libgmp.a。
#
# LEAN_GITHASH_OVERRIDE="$LEAN_COMMIT"：软 Fork 上带着 5 个原生 Commit，直接读 HEAD
# 会产出自有 sha1 从而破坏与官方 64 位 .olean / Mathlib4 缓存的 ABI 兼容性。
#
# EXIT_RUNTIME=0：EXIT_RUNTIME=1 会在 main 返回后跑静态析构，官方 Init olean（402MB）下
# `~initializer` 里的 free 会抢 pthread 锁，浏览器主线程不允许 Atomics.wait，直接抛异常。
# 进程退出码由 callMain 返回，不依赖析构。
set -euo pipefail
ROOT="${1:?usage: patch-wasm64.sh <foundryRoot>}"
SCRIPT="$ROOT/wasm-llvm/producer/lean-browser/scripts/build.sh"
GMP="$ROOT/work/gmp-install"

if grep -q 'GMP_INSTALL_PREFIX' "$SCRIPT" && grep -q 'WASM_LLVM_LEAN_SRC_DIR' "$SCRIPT"; then
  echo "build.sh 已打过补丁，跳过"
  exit 0
fi

PY=python3
command -v python3 > /dev/null 2>&1 || PY=python

"$PY" - "$SCRIPT" "$GMP" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
gmp = sys.argv[2]
text = path.read_text()

def replace_once(src: str, old: str, new: str, label: str) -> str:
    if new in src:
        return src
    if old not in src:
        raise SystemExit(f"patch-wasm64.sh 找不到锚点: {label}")
    return src.replace(old, new, 1)

# 软 Fork 直编开关：设置 WASM_LLVM_LEAN_SRC_DIR 时直接指向仓根源码，跳过 fetch 克隆与补丁检查，
# 仅下载/校验官方引导包。
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

# tail call：clang 对 wasm 默认不做兄弟调用优化，只有在编译步与链接步都带上 -mtail-call 才会生成 return_call。
# 优化等级与 wasm32 主线一致使用 -O3。
text = replace_once(
    text,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_BUILD_TYPE=Release -DLEAN_GITHASH_OVERRIDE=\"$LEAN_COMMIT\" "
    "'-DCMAKE_C_FLAGS=-sMEMORY64=1 -mtail-call' "
    "'-DCMAKE_CXX_FLAGS=-sMEMORY64=1 -mtail-call' "
    "'-DCMAKE_EXE_LINKER_FLAGS=-sMEMORY64=1 -mtail-call'",
    "CMake Release/flags",
)
text = text.replace("emcc -c -O2", "emcc -sMEMORY64=1 -mtail-call -c -O3")
text = text.replace("emcc -O2 -pthread", "emcc -sMEMORY64=1 -mtail-call -O3 -pthread")
text = text.replace("-sMODULARIZE=1", "-sEXCEPTION_STACK_TRACES=1 --profiling-funcs -sMODULARIZE=1")
text = text.replace("-sINITIAL_MEMORY=268435456", "-sINITIAL_MEMORY=2147483648")
text = text.replace("-sDEFAULT_PTHREAD_STACK_SIZE=8388608", "-sDEFAULT_PTHREAD_STACK_SIZE=67108864")
text = text.replace("-sEXIT_RUNTIME=1", "-sEXIT_RUNTIME=0")
text = text.replace("-sPTHREAD_POOL_SIZE=4", "-sPTHREAD_POOL_SIZE=8")
text = text.replace("-DUSE_GMP=OFF", f"-DUSE_GMP=ON -DGMP_INSTALL_PREFIX={gmp}")
text = text.replace('-I"$BUILD/include"', f'-I"$BUILD/include" -I"{gmp}/include"')
text = text.replace('"$BUILD/lib/lean/libleanrt.a"', f'"$BUILD/lib/lean/libleanrt.a" "{gmp}/lib/libgmp.a"')

path.write_text(text)
PY

for marker in '-O3' 'WASM_LLVM_LEAN_SRC_DIR' 'LEAN_GITHASH_OVERRIDE' 'MEMORY64' 'GMP_INSTALL_PREFIX'; do
  grep -q -- "$marker" "$SCRIPT" || {
    echo "build.sh 缺少必需注入标记: $marker" >&2
    exit 1
  }
done
grep -n -- 'MEMORY64\|GMP\|-O3\|WASM_LLVM_LEAN_SRC_DIR\|LEAN_GITHASH_OVERRIDE' "$SCRIPT"
