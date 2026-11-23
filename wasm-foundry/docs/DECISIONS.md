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
