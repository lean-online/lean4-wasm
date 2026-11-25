# lean4-wasm (`wasm-foundry`)

面向浏览器端 Lean IDE（[lean-online/lean-init-ide](https://github.com/lean-online/lean-init-ide)）的 **`leanprover/lean4` ABI 兼容软 Fork 与 WebAssembly 构建铸造厂**：

- **仓根 `src/`**：基于 `leanprover/lean4` `v4.36.0`（`611c117bfaf7b7ae1cfcf246ce6fba31e8f509e9`）保留 5 个原生 Commit，涵盖 Emscripten 静态兼容、`MEMORY64` + `64MB` 线程栈 + `LEAN_GITHASH_OVERRIDE` + 结构化诊断，以及 `replace_fn` / `whnfCoreStep` / `simpLoopStep` 三处堆上显式工作栈改造。
- **`wasm-foundry/` 目录**：承接与上游 Lean 源码解耦的全部构建、测试与发布工具链。

## 目录与职责

- **wasm32 4.36.0 生产构建与扩展发布**（ADR-06：直接编译仓根软 Fork，`-DLEAN_WASM64` 默认 OFF）：`../.github/workflows/runtime-wasm32.yml`、`scripts/patch-wasm32.sh`、`scripts/package-runtime-assets.mjs`、`scripts/package-runtime-extension.mjs`、`scripts/upload-assets.mjs`、`scripts/upload-modelscope.mjs`、`scripts/assets/runner-worker.js`
- **wasm64 构建链与 5 层一致性门禁**：`../.github/workflows/spike-wasm64.yml`、`../.github/workflows/native-consistency-gate.yml`、`scripts/pin-lean.ts`（默认 `4.36.0`）、`scripts/wasm64-patch-equivalence.ts`、`scripts/ci/check-abi-diff.ts`、`scripts/ci/verify-dual-checkers.ts`、[docs/DIVERGENCES.md](docs/DIVERGENCES.md)、`scripts/package-wasm64-*.ts`、`npm/`
- **C/C++ 门禁与递归深度探针**：`../.github/workflows/cpp-gate.yml`、`scripts/check-cpp.sh`、`../.github/workflows/depth-probe.yml`、`scripts/depth-probe/`
- **主应用仓（`lean-online/lean-init-ide`）**：仅负责前端应用与边缘网关，两仓通过 `config/lean4-runtime.json` 与 `config/lean4-wasm64-runtime.json` 契约交接。

## 本地常用命令（在 `wasm-foundry/` 执行）

需要 Node >= 24 与 pnpm 12：

```bash
pnpm install
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run verify:manifest
pnpm run test:coverage
```

- 升级与构建 SOP 见 [docs/WASM64-SPIKE.md](docs/WASM64-SPIKE.md) 与 [docs/DECISIONS.md](docs/DECISIONS.md)。
- 发布资产所需的 GitHub Actions Secrets：`R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`MODELSCOPE_TOKEN`（可选 `NPM_TOKEN`）。
