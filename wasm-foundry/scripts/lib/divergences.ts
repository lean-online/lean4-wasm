// 第 5 层门禁：显式有意差异登记簿（Intentional Divergence Registry）。
// 凡是软 Fork 有意偏离官方 Lean v4.36.0 语义的行为，必须在此逐条登记并绑定专属边界用例；
// 未登记的任意行为差异在门禁中一律按严重回归拦截。

export interface IntentionalDivergence {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly commitScope: string;
  readonly summary: string;
  readonly rationale: string;
  readonly upstreamBehavior: string;
  readonly forkBehavior: string;
  readonly boundaryCaseName: string;
  /** 原生 CTest 运行全量 tests/elab 时，已知受此有意差异影响的上游用例相对路径（由 CI 精确核对）。 */
  readonly expectedUpstreamTestDivergences: readonly string[];
}

export const INTENTIONAL_DIVERGENCES: readonly IntentionalDivergence[] = [
  {
    id: 'DIV-001',
    slug: 'simp-loop-rec-depth',
    title: 'simpLoop 线性重写链不逐层递增 maxRecDepth',
    commitScope: 'src/Lean/Meta/Tactic/Simp/Main.lean',
    summary:
      '将 simpLoop 的非尾调用重写链改为堆上显式续延栈 simpLoopStep 后，单条线性重写链只在入口执行一次 withIncRecDepth，不再随步数递增 Lean recDepth。',
    rationale:
      '浏览器 Dedicated Worker 原生栈仅约 1 MB，原版 simpLoop 每步递归会在原生栈留两帧导致大定理 simp 爆栈；改为尾调用驱动的堆续延栈以支撑深链化简。',
    upstreamBehavior:
      '每执行一步 pre.visit / postContinue 均递归进入 simpLoop 并累加 recDepth，在 maxRecDepth 较小时于达到 maxSteps 前先触发 maximum recursion depth has been reached；死循环由 recDepth 与 maxSteps 共同拦截。',
    forkBehavior:
      '单条线性重写链在 simpLoopStep 内共享入口 recDepth，不受小 maxRecDepth 对链长的限制，仍严格受 cfg.maxSteps（及子项递归中的 simp / whnf 等正常 withIncRecDepth）截断保护。',
    boundaryCaseName: 'DivergenceSimpRecDepth.lean',
    // 上游若实测仅部分命中或全部命中，CI 会按前缀对照检查并可在首轮实测后收紧此清单。
    expectedUpstreamTestDivergences: ['elab/simpLoopProtection.lean', 'elab/simpDiag.lean'],
  },
];

export interface DivergenceBoundaryCorpus {
  readonly divergenceId: string;
  readonly name: string;
  readonly code: string;
  readonly expectedBootErrorPattern: RegExp;
  readonly expectedForkMarker: string;
}

/** 构造 DIV-001 专属边界用例：官方因 maxRecDepth=80 报错拒绝，软 Fork 在 maxSteps=500 内成功且 maxSteps=10 仍被正确截断。 */
export const buildDivergenceBoundaryCorpus = (): DivergenceBoundaryCorpus => ({
  divergenceId: 'DIV-001',
  name: 'DivergenceSimpRecDepth.lean',
  code: [
    'import Lean',
    '',
    'private def linDiv : Nat → Nat',
    '  | 0 => 0',
    '  | n + 1 => linDiv n',
    '',
    '-- DIV-001 有意差异边界：链长 120 > maxRecDepth 80，官方报递归深度错，软 Fork 在 maxSteps=500 下通过。',
    'set_option maxRecDepth 80 in',
    'theorem div_simp_chain : linDiv 120 = 0 := by',
    '  simp (config := { maxSteps := 500 }) [linDiv]',
    '',
    '-- 安全护栏未丢失：即便放开递归栈，超步数上限仍必须按官方契约报错拒绝。',
    '/-- error: `simp` failed: maximum number of steps exceeded -/',
    '#guard_msgs in',
    'example : linDiv 20 = 0 := by',
    '  simp (config := { maxSteps := 10 }) [linDiv]',
    '',
    '#eval IO.println "div_001_boundary_ok"',
    '',
  ].join('\n'),
  expectedBootErrorPattern: /maximum recursion depth has been reached/,
  expectedForkMarker: 'div_001_boundary_ok',
});

/** 从 DIVERGENCES.md 提取形如 `## DIV-001: ...` 的已记录差异编号。 */
export const extractDocumentedDivergenceIds = (markdown: string): string[] => {
  const ids: string[] = [];
  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^##\s+(DIV-\d+)\b/.exec(rawLine.trim());
    if (match?.[1]) {
      ids.push(match[1]);
    }
  }
  return ids;
};

/** 校验代码登记簿 INTENTIONAL_DIVERGENCES 与文档 DIVERGENCES.md 双向完全同步。 */
export const assertDivergenceRegistrySynced = (markdown: string): void => {
  const codeIds = INTENTIONAL_DIVERGENCES.map((entry) => entry.id);
  const codeSet = new Set(codeIds);
  if (codeSet.size !== codeIds.length) {
    throw new Error('INTENTIONAL_DIVERGENCES 存在重复 ID');
  }

  const docIds = extractDocumentedDivergenceIds(markdown);
  const docSet = new Set(docIds);
  if (docSet.size !== docIds.length) {
    throw new Error('docs/DIVERGENCES.md 存在重复差异编号');
  }

  const missingInDoc = codeIds.filter((id) => !docSet.has(id));
  if (missingInDoc.length > 0) {
    throw new Error(`docs/DIVERGENCES.md 缺少差异登记条目: ${missingInDoc.join(', ')}`);
  }

  const extraInDoc = docIds.filter((id) => !codeSet.has(id));
  if (extraInDoc.length > 0) {
    throw new Error(`docs/DIVERGENCES.md 存在代码未登记条目: ${extraInDoc.join(', ')}`);
  }
};
