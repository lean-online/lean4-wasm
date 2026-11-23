**何时读我**：需要理解「为什么当前运行时构建与分发链这样设计」或准备修改补丁/镜像架构方案前阅读。
**单一事实来源**：架构约束见 [AGENTS.md](../AGENTS.md)，Web IDE 主仓决策见 [lean-init-ide DECISIONS](https://github.com/lean-online/lean-init-ide/blob/main/docs/DECISIONS.md)。
**维护边界**：每条 ADR 只用三句话写清「决定 / 原因 / 禁止回退的替代方案」；新增重大决策追加编号。

# 架构决策记录（ADR）

## ADR-01：魔搭镜像统一采用扁平目录结构 {#adr-01}

- **决定**：ModelScope 数据集镜像（[scripts/upload-modelscope.mjs](../scripts/upload-modelscope.mjs) 与主仓 [asset-sources.mjs](https://github.com/lean-online/lean-init-ide/blob/main/src/asset-sources.mjs)）对基础资产与扩展包统一使用 `<prefix>/<asset.name>` 扁平布局，而非 R2 的子目录树。
- **原因**：魔搭数据集仓库以单一路径拉取为主，前端 `addMirror` 基于 `${prefix}/${asset.name}` 构造直链；混入 `extensions/<id>/` 子目录会导致上传与下载路径错位 404。
- **禁止回退的方案**：禁止上传脚本按 `asset.key` 原样落盘到带多级 `extensions/<id>/` 的魔搭子目录而前端仍拼扁平 URL。

## ADR-02：wasm64 源码修改后必须使用同源源码自洽构建 `.olean` {#adr-02}

- **决定**：只要软 Fork 原生提交对 `.lean` 内核或策略源码做了签名/导出改动（如 `WHNF.lean`、`Simp/Main.lean`），就必须用同一份源码（配合 `-DLEAN_GITHASH_OVERRIDE` 保持官方 `LEAN_GITHASH` 与 `USE_GMP=ON`）自洽编译 `.olean`。
- **原因**：实测已证明如 `simpLoop.visitPreContinue` 等参数签名变更后，混用官方未打补丁 `.olean` 会触发链接符号或运行时结构错位。
- **禁止回退的方案**：禁止为了省去编译步骤而用 `continue-on-error: true` 掩盖 `lake exe cache get` 等失败后把未打补丁 `.olean` 直接塞进扩展包。

## ADR-03：5 层行为一致性门禁 + 双独立数学检验器（官方 C++ 与纯 Rust 异构审计） {#adr-03}

- **决定**：软 Fork 的语义正确性与 ABI 兼容性由「5 层行为一致性门禁 + 双独立内核复验」共同担保，并拆分为两条互补 CI 流水线（[native-consistency-gate.yml](../../.github/workflows/native-consistency-gate.yml) 与 [spike-wasm64.yml](../../.github/workflows/spike-wasm64.yml)）：
  1. 第 1 层（全量原生回归）：在 Linux x86_64 Stage 1 原生构建上运行官方 `tests/elab` 与 `tests/elab_fail` 全套 CTest（数千用例）。
  2. 第 2 层（确定性差分 Fuzzing）：由 [differential-fuzz.ts](../scripts/lib/differential-fuzz.ts) 生成固定种子 `Expr` DAG + `WHNF.Config` 组合（原生 300 组 / wasm64 48 组）与官方未改动 `bootLean` 逐字节对比。
  3. 第 3 层（反向拒绝与双独立数学检验器）：[wasm64-patch-equivalence.ts](../scripts/wasm64-patch-equivalence.ts) 运行自研反例 + `tests/elab_fail` 抽样确保严禁错误放行；[verify-dual-checkers.ts](../scripts/ci/verify-dual-checkers.ts) 将候选端编出的证明 `.olean` 依次送交第一重 **官方原版 C++ 内核 `leanchecker`（`--fresh` 与 `--from-export`）** 及第二重 **异构纯 Rust 独立内核 `leanexport` + `ammkrn/nanoda_lib` `nanoda_bin`** 交叉审计，并以 `sorryAx` 反例校验检验器活性。
  4. 第 4 层（ABI 静态防线）：[check-abi-diff.ts](../scripts/ci/check-abi-diff.ts) 对比基准 `v4.36.0` 与当前 Fork 改动 `.lean` 模块的 `LEAN_EXPORT` 符号与全 `$CGEN` 跨模块引用（锁定 `whnfCore_go` 等被上游内联的符号）。
  5. 第 5 层（有意差异显式登记）：[divergences.ts](../scripts/lib/divergences.ts) 与 [DIVERGENCES.md](DIVERGENCES.md) 双向同步，仅允许显式登记且配有专属边界用例的 `DIV-001` 偏离官方，其余任何静默差异一律红灯拦截。
- **原因**：在 wasm64 单核环境无法覆盖数千测试与全量反例，且单靠自改 C++ 内核无法排除共模漏洞；用原生 Linux 承担全量测试与 C 符号审计，再以 Rust 重写的第三方内核对关键证明做异构复验，可实现零信任边界下的数学可靠性闭环。
- **禁止回退的方案**：禁止撤除反向拒绝集、删除未登记差异拦截、或在未通过 `leanchecker` + `nanoda_bin` 双检前宣告分支对齐。
