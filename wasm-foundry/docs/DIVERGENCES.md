**何时读我**：向软 Fork 提交任何会影响语义或外显行为的补丁、或发现等价门禁 / 原生 `tests/elab` 报告行为差异前阅读。
**单一事实来源**：机器可校验条目与专属边界用例定义在 [scripts/lib/divergences.ts](../scripts/lib/divergences.ts) 的 `INTENTIONAL_DIVERGENCES`，文档与代码通过单测强制双向同步。
**维护边界**：只有经过充分论证确属预期目标的有意差异才允许登记在此；禁止把未查明 Bug 或运行时限制写进有意差异清单。

# 有意行为差异登记簿（Intentional Divergences）

本仓遵循**「零静默偏离」**原则：凡未在此文件显式登记的行为差异，在 5 层行为一致性门禁中一律视为严重 Bug 并阻断 CI。

## DIV-001: simpLoop 线性重写链不逐层递增 maxRecDepth

- **改动范围**：`src/Lean/Meta/Tactic/Simp/Main.lean`（Native Commit `531ae10b51`）
- **改造机制**：将原 `simpLoop` 中非尾调用的 `.visit`、`visitPreContinue` 与 `visitPostContinue` 改为基于 `List SimpLoopCont` 的堆上续延状态机 `simpLoopStep`（`.eval` / `.finish`），仅在入口 `simpLoop` 执行一次 `withIncRecDepth`。
- **官方原版行为**：线性重写链每推进一步均递归调用 `simpLoop` 并递增 Lean 内部 `recDepth`；当重写步数超过 `maxRecDepth` 时即便未达 `cfg.maxSteps`，也会先报错 `maximum recursion depth has been reached`。
- **软 Fork 行为**：单条线性重写链共享入口深度计数，可在浏览器 1 MB 原生栈与较小的 `maxRecDepth` 下完成更长的线性重写，同时继续严格受 `cfg.maxSteps` 与其他递归路径 `withIncRecDepth` 截断。
- **专属边界验证**：[scripts/wasm64-patch-equivalence.ts](../scripts/wasm64-patch-equivalence.ts) 运行 `DivergenceSimpRecDepth.lean` 校验：官方 `bootLean` 必须在 `maxRecDepth 80` 处报递归深度错拒绝，而软 Fork 在 `maxSteps := 500` 下通过且 `maxSteps := 10` 仍触发 `` `simp` failed: maximum number of steps exceeded ``。
- **对上游全量回归的已知影响**：原生 `ctest` 中个别依赖 `simp` 递增 `recDepth` 来拦截故意构造循环重写定理的测试（当前列表见 `expectedUpstreamTestDivergences`：`elab/simpLoopProtection.lean`、`elab/simpDiag.lean`）可能产生预期差异。

---

## 已知运行时局限（非有意语义差异，禁止列入上方清单）

下列现象属于当前 Wasm64 运行时或浏览器宿主模型的未解决工程局限，详见 [WASM64-SPIKE.md](WASM64-SPIKE.md)：

1. **退出期偶发堆破坏 Trap**：`wasm64` CLI 进程完成全部计算后，退出期偶发出现 `emscripten_builtin_free` / `lean_dec_ref_cold`（仅允许在 `stdout` 与官方逐字节完全一致时重试/告警，绝不掩盖计算阶段差异）。
2. **`IO.Process.exit` 退出码**：`wasm64` Worker 内通过不可克隆异常退出导致宿主返回 `1`（由运行时进程模型决定，不影响类型检查与语义）。
