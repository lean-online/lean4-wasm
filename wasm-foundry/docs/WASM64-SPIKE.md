**何时读我**：修改实验性 `wasm64` 构建链、升级 Lean 软 Fork 基线、调整三处显式工作栈改造或排查差分门禁失败时阅读。
**单一事实来源**：版本 pin（引导包 & `LEAN_GITHASH_OVERRIDE`）见 [pin-lean.ts](../scripts/pin-lean.ts)，现行架构边界见 [DECISIONS.md](DECISIONS.md#adr-02)。
**维护边界**：只记录当前生效的 `wasm64` 构建与验证规范；历史实验探针与早期调试日志已归档到 [WASM64-SPIKE-EXPERIMENTS.md](archive/WASM64-SPIKE-EXPERIMENTS.md)。

# wasm64 运行时规范与升级 SOP

实验性 `wasm64`（Emscripten `MEMORY64=1` + `USE_GMP=ON`）打破 4 GiB 地址空间限制以承载 Mathlib 教学子集，运行在独立构建链与 [spike-wasm64.yml](../../.github/workflows/spike-wasm64.yml) 上，主站默认生产入口仍为 `wasm32`。

## 软 Fork 版本 Pin 与升级流程

本仓基于上游 `leanprover/lean4` 软 Fork 维护（当前基线 **`v4.36.0`**，`611c117bfaf7b7ae1cfcf246ce6fba31e8f509e9`）；引导包与 `LEAN_GITHASH_OVERRIDE` 唯一定义在 [scripts/pin-lean.ts](../scripts/pin-lean.ts) 的 `LEAN_PIN`（当前默认 **4.36.0**）：

- **临时验证**：同时传入 `LEAN_PIN_VERSION` / `LEAN_PIN_COMMIT` / `LEAN_PIN_BOOTSTRAP_URL` / `LEAN_PIN_BOOTSTRAP_SHA256`（缺一报错）。
- **正式升级**：在软 Fork 分支上 `git rebase v4.37.0` 原生 Commit 栈，并同步修改 `LEAN_PIN` 让 CI 缓存键 `hashFiles(...)` 自动失效，否则 `stage_cgen` / `stage_objects` / Mathlib 缓存会混出不匹配的混合二进制。

升级顺序（不可颠倒）：

1. `git rebase` 仓根 `src/` 上的 5 个原生 Commit 到目标官方 tag。
2. 更新 [scripts/pin-lean.ts](../scripts/pin-lean.ts) 中的 `LEAN_PIN`（版本、官方 commit、Linux 引导包 URL 与 SHA-256）。
3. **同一份源码构建 `.olean`**（见 [DECISIONS.md](DECISIONS.md) ADR-02）：当 `.lean` 改动改变了公开或内部签名时，绝不能与上游未改动官方 `.olean` 混用；构建通过 `-DLEAN_GITHASH_OVERRIDE="$LEAN_COMMIT"` 锁定官方 `githash`。
4. 在 Actions 运行完整构建与差分门禁通过后，再将产出的清单同步更新至主仓 `lean-online/lean-init-ide`。

## 三处现行堆栈改造（已转正为仓根原生 Commit）

Chrome Dedicated Worker 原生调用栈上限约 1 MB，下列原生提交将热点递归转化为堆上显式工作栈：

| 位置 | 作用与缓存键归属 |
| --- | --- |
| `../src/kernel/replace_fn.cpp` | `Expr.replace` 后序迭代化（`wants_cache`）；计入 `runtime` 缓存键 |
| `../src/Lean/Meta/WHNF.lean` | `whnfCoreStep` 显式工作栈；计入 `cgen`/`objects` |
| `../src/Lean/Meta/Tactic/Simp/Main.lean` | `simpLoopStep` 三处非尾调用改为显式续延栈；计入 `cgen`/`objects` |

## 差分与静态门禁

本地仅运行零构建静态检查与门禁单测（在 `wasm-foundry/` 下）：

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test:coverage
```

Actions 中的行为硬基准为 [scripts/wasm64-patch-equivalence.ts](../scripts/wasm64-patch-equivalence.ts) 与 [native-consistency-gate.yml](../../.github/workflows/native-consistency-gate.yml) 组成的 **5 层一致性门禁 + 双独立检验器**（官方 `tests/elab` + `tests/elab_fail` 全量回归、固定种子 `Expr`/WHNF Fuzzing、反向报错拒绝集、`leanchecker` + `leanexport` / Rust `nanoda_bin` 双核交叉审计、C 导出符号表 ABI Diff 与 [DIVERGENCES.md](DIVERGENCES.md) 显式登记簿；详见 [DECISIONS.md](DECISIONS.md#adr-03)）。

- **容忍边界**：仅允许「退出期已知 trap」（stderr 命中 `emscripten_builtin_free` / `lean_dec_ref_cold` 且 stdout/产物逐字节一致，重跑复现才降级告警）、`IO.Process.exit` 退出码差异（worker `DataCloneError` 已知限制）以及 [DIVERGENCES.md](DIVERGENCES.md) 中显式登记并验证边界的有意差异（如 `DIV-001`）。
- **红线**：任意未登记行为差异、反向用例误放行（`status=0`）、C 公开/跨模块符号 ABI 破坏、双独立检验器拒绝或栈溢出（`Maximum call stack size exceeded`）必须直接失败。

## 现行浏览器侧关键机制与待收口项

- **诊断与协议隔离**：stdout 专供 JSON-RPC `Content-Length` 帧，`../src/util/shell.cpp` 异常按 `[LEAN_WASM_ERR]` 输出到 stderr（支持 `Module.ENV.LEAN_WASM_TRACE=1`）。
- **IPC 环形缓冲**：主应用仓库 [lean-wasm64-supervisor.ts](https://github.com/lean-online/lean-init-ide/blob/main/src/lean-wasm64-supervisor.ts) 管理独立 Worker 进程与 SharedArrayBuffer stdin 环形缓冲（memory64 下 `struct iovec` 为 16 字节 stride，`_fd_read` 短等 1ms 并泵 `__emscripten_check_mailbox()`）。
- **当前待收口项**：`.olean` 自洽构建与按需扩展包接入尚未完成全量浏览器联调，详见 [DECISIONS.md](DECISIONS.md)。
