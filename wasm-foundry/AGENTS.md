# AGENTS.md · lean4-wasm（wasm-foundry）协作指南

本仓库是 `leanprover/lean4`（当前基线 `v4.36.0`）面向 WebAssembly 的 ABI 兼容软 Fork：
- 仓根 `src/` 保存转正后的 Emscripten / MEMORY64 / 显式工作栈原生 Commit；
- 本目录 `wasm-foundry/` 承接全部 WASM 运行时构建、差分等价门禁、深栈探针与 R2 / 魔搭镜像发布工具链，对接主应用仓 [lean-online/lean-init-ide](https://github.com/lean-online/lean-init-ide)。

## 1. 目录职责

| 路径 | 职责 | 关键规范 |
| --- | --- | --- |
| 仓根 `src/`（相对本目录 `../src/`） | Emscripten 静态构建、`MEMORY64`（`-DLEAN_WASM64=ON` 才启用）、`-DLEAN_GITHASH_OVERRIDE`、`replace_fn` / `whnfCoreStep` / `simpLoopStep` | 保持最少干净原生 Commit，禁止改动上游根文档，确保后续可干净 `git rebase`；wasm32 与 wasm64 必须共用这一棵树 |
| `scripts/*.ts` / `scripts/ci/` / `scripts/lib/` | wasm64 构建、LSP 胶水适配、差分等价门禁、Mathlib 裁切与打包 | Node 24 原生类型擦除（`erasableSyntaxOnly`）；CLI 解析用 `scripts/lib/cli.ts`，路径校验用 `scripts/lib/fs-guards.ts` |
| `scripts/*.mjs` | wasm32 打包（zstd level 19）、扩展打包、R2 / 魔搭上传与清单校验 | 源解析用 `scripts/lib/manifest-sources.mjs`；S3 参数解析用 `scripts/lib/upload-config.mjs` |
| `scripts/patches/` | 4.35.0 时代的增量 emscripten 补丁（历史） | 仅供重建 `runtime-v4.35.0` 历史资产；wasm32 / wasm64 现已直接编译仓根软 Fork 源码（ADR-06），补丁不再参与日常构建 |
| `scripts/depth-probe/` | Emscripten 递归深度与 WHNF 尾调用探针 | 手写 C/C++ 受 `.clang-format` / `.clang-tidy` / `scripts/check-cpp.sh` 约束 |
| `config/` | `lean4-runtime.json` 与 `lean4-wasm64-runtime.json` | 产物发版后同步更新主应用仓 `lean-online/lean-init-ide` 的对应清单（wasm32 同步需在主仓重跑 `pnpm run patch:lsp`） |

## 2. 红线

1. **包管理唯一用 `pnpm`**（Node >= 24，在 `wasm-foundry/` 内运行）；禁止 `npm` / `npx` / `yarn`；`scripts/assets/**` 保持 `.gitattributes` `-text`。
2. **禁止 `continue-on-error: true` 与假通过**：任何资产校验、Release 上传、原生锚点断言失败必须非零退出。
3. **ABI 兼容与自洽 `.olean`**（见 [docs/DECISIONS.md](docs/DECISIONS.md)）：对 `.lean` 做签名改动时必须同源编译 `.olean`；CMake 构建通过 `-DLEAN_GITHASH_OVERRIDE` 锁定官方对应版本的 `githash`。
4. **分支与 PR**：默认开发分支为 `wasm64-v4.36.0`，所有工作流均位于仓根 `.github/workflows/`。

## 3. 提交前验证（在 `wasm-foundry/` 执行）

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run verify:manifest
pnpm run test:coverage
```
