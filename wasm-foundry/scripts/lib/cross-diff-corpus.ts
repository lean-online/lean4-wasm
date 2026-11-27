/**
 * 官方原生 `lean` vs Chrome `wasm64` 跨端差分一致性语料与规范化比较器（Issue #83 第二项）：
 *
 * 覆盖 25 组代表性样本：
 * - `core-proof`（5）：GMP 大整数、64 位平台字长、归纳证明、omega/decide、宇宙多态 Fin；
 * - `recursion-stack`（5）：5 万层尾调用（-mtail-call）、simp 显式续延栈、WHNF let 链、DAG 共享 replace、超限拒绝；
 * - `memory-alloc`（4）：20 万元素数组、Std.HashMap、512KB 倍增字符串、3.2 万节点二叉树；
 * - `multi-file`（3）：多文件辅助模块编译 import、Std+Lean JSON 解析、缺失模块拒绝；
 * - `error-diagnostic`（5）：类型不匹配、rfl 失败、未知标识符、未闭合目标、宇宙层级冲突；
 * - `mathlib-tactic`（3）：Mathlib.Order.Basic、Nat.Prime、Tactic.Ring。
 */

export type CrossDiffSuite = 'init' | 'mathlib';

export type CrossDiffCategory =
  | 'core-proof'
  | 'recursion-stack'
  | 'memory-alloc'
  | 'multi-file'
  | 'error-diagnostic'
  | 'mathlib-tactic';

export type DiagnosticCategory =
  | 'type-mismatch'
  | 'unknown-identifier'
  | 'unsolved-goals'
  | 'unknown-module'
  | 'recursion-depth'
  | 'other-error'
  | 'warning'
  | 'info';

export interface CrossDiffCase {
  readonly id: string;
  readonly suite: CrossDiffSuite;
  readonly category: CrossDiffCategory;
  readonly description: string;
  readonly fileName: string;
  readonly code: string;
  readonly helperModules?: Readonly<Record<string, string>>;
  readonly expectOk: boolean;
  readonly expectErrorCategory?: DiagnosticCategory;
  readonly expectOutputs?: readonly string[];
}

export interface NormalizedDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly category: DiagnosticCategory;
  readonly message: string;
  readonly line?: number;
}

export interface CrossSideResult {
  readonly exitCode: number;
  readonly diagnostics: readonly NormalizedDiagnostic[];
  readonly stdout: string;
  readonly elapsedMs: number;
  readonly peakMemoryBytes?: number;
  readonly workerError?: string;
}

export interface CaseComparison {
  readonly id: string;
  readonly category: CrossDiffCategory;
  readonly suite: CrossDiffSuite;
  readonly ok: boolean;
  readonly mismatches: readonly string[];
  readonly native: CrossSideResult;
  readonly chrome: CrossSideResult;
}

export interface CrossDiffReport {
  readonly suite: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly CaseComparison[];
}

export const CROSS_DIFF_CORPUS: readonly CrossDiffCase[] = [
  // === core-proof (5) ===
  {
    id: 'init_gmp_pow2_100',
    suite: 'init',
    category: 'core-proof',
    description: 'GMP 任意精度大整数计算与内核 rfl 等价',
    fileName: 'CdGmpPow.lean',
    code: [
      'import Init',
      '',
      '#eval (2 ^ 100 : Nat)',
      'example : (2 ^ 100 : Nat) = 1267650600228229401496703205376 := rfl',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['1267650600228229401496703205376'],
  },
  {
    id: 'init_platform_64bit',
    suite: 'init',
    category: 'core-proof',
    description: '64 位平台字长一致为 64',
    fileName: 'CdPlatformBits.lean',
    code: [
      'import Init',
      '',
      '#eval System.Platform.numBits',
      'example : System.Platform.numBits = 64 := rfl',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['64'],
  },
  {
    id: 'init_inductive_nat_comm',
    suite: 'init',
    category: 'core-proof',
    description: '自然数归纳证明结合律与交换律',
    fileName: 'CdNatInd.lean',
    code: [
      'import Init',
      '',
      'theorem cd_add_comm (a b : Nat) : a + b = b + a := Nat.add_comm a b',
      'theorem cd_mul_distrib (a b c : Nat) : (a + b) * c = a * c + b * c := Nat.add_mul a b c',
      '#eval (List.range 10).foldl (· + ·) 0',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['45'],
  },
  {
    id: 'init_omega_decide',
    suite: 'init',
    category: 'core-proof',
    description: 'omega 与 decide 判定过程',
    fileName: 'CdOmegaDecide.lean',
    code: [
      'import Init',
      '',
      'example (x y : Nat) (h1 : 2 * x + y = 10) (h2 : x ≥ 3) : y ≤ 4 := by omega',
      'example : (∀ n ∈ [2, 4, 6, 8], n % 2 = 0) := by decide',
      '#eval IO.println "omega_ok"',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['omega_ok'],
  },
  {
    id: 'init_universe_poly_fin',
    suite: 'init',
    category: 'core-proof',
    description: '宇宙多态与依赖类型 Fin 求和证明',
    fileName: 'CdPolyFin.lean',
    code: [
      'import Init',
      '',
      'universe u',
      'def wrapId {α : Type u} (x : α) : List α := [x]',
      'example : (wrapId (42 : Nat)).length = 1 := rfl',
      'example (i : Fin 5) : i.val < 5 := i.isLt',
      '#eval (wrapId 7).head!',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['7'],
  },

  // === recursion-stack (5) ===
  {
    id: 'rec_tailcall_50k',
    suite: 'init',
    category: 'recursion-stack',
    description: '50,000 层尾递归求值（验证 -mtail-call / Worker 栈）',
    fileName: 'CdTail50k.lean',
    code: [
      'import Init',
      '',
      'def sumAcc (n acc : Nat) : Nat :=',
      '  match n with',
      '  | 0 => acc',
      '  | k + 1 => sumAcc k (acc + k + 1)',
      '',
      '#eval sumAcc 50000 0',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['1250025000'],
  },
  {
    id: 'rec_simp_depth_600',
    suite: 'init',
    category: 'recursion-stack',
    description: '深层 simpLoopStep 显式续延栈归约（N=600）',
    fileName: 'CdSimp600.lean',
    code: [
      'import Init',
      '',
      'def stepDown : Nat → Nat',
      '  | 0 => 0',
      '  | n + 1 => stepDown n',
      '',
      'set_option maxRecDepth 4000 in',
      'example : stepDown 600 = 0 := by simp [stepDown]',
      '#eval stepDown 600',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['0'],
  },
  {
    id: 'rec_whnf_let_chain',
    suite: 'init',
    category: 'recursion-stack',
    description: '嵌套 let/zeta WHNF 归约一致性',
    fileName: 'CdWhnfLet.lean',
    code: [
      'import Init',
      '',
      'def nestedLet : Nat :=',
      '  let a := 1; let b := a + 2; let c := b + 3; let d := c + 4',
      '  let e := d + 5; let f := e + 6; let g := f + 7; let h := g + 8',
      '  h',
      '',
      'example : nestedLet = 36 := rfl',
      '#eval nestedLet',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['36'],
  },
  {
    id: 'rec_replace_shared_dag',
    suite: 'init',
    category: 'recursion-stack',
    description: 'Expr.replace 共享 DAG 子树与层级实例化（验证 replace_fn.cpp）',
    fileName: 'CdReplaceDag.lean',
    code: [
      'import Lean',
      '',
      'open Lean in',
      '#eval show IO Unit from do',
      '  let zero := Expr.const ``Nat.zero []',
      '  let succZero := Expr.app (.const ``Nat.succ []) zero',
      '  let shared := Expr.app succZero succZero',
      '  let noop := shared.replace fun _ => none',
      '  let inst := (Expr.sort (.succ (.param `u))).instantiateLevelParams [`u] [.one]',
      '  IO.println s!"dag_ok={shared == noop && inst.isSort}"',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['dag_ok=true'],
  },
  {
    id: 'rec_max_rec_depth_reject',
    suite: 'init',
    category: 'recursion-stack',
    description: '超过 maxRecDepth 上限必须一致拒绝（不能崩溃放行）',
    fileName: 'CdRecDepthFail.lean',
    code: [
      'import Init',
      '',
      'def stepRec : Nat → Nat',
      '  | 0 => 0',
      '  | n + 1 => stepRec n',
      '',
      'set_option maxRecDepth 16 in',
      'example : stepRec 100 = 0 := by simp [stepRec]',
      '',
    ].join('\n'),
    expectOk: false,
    expectErrorCategory: 'recursion-depth',
  },

  // === memory-alloc (4) ===
  {
    id: 'mem_array_fold_200k',
    suite: 'init',
    category: 'memory-alloc',
    description: '200,000 元素 Array 分配与折叠求和',
    fileName: 'CdArray200k.lean',
    code: ['import Init', '', '#eval (Array.range 200000).foldl (· + ·) 0', ''].join('\n'),
    expectOk: true,
    expectOutputs: ['19999900000'],
  },
  {
    id: 'mem_hashmap_10k',
    suite: 'init',
    category: 'memory-alloc',
    description: 'Std.HashMap 10,000 键值插入与回查校验',
    fileName: 'CdHashMap10k.lean',
    code: [
      'import Std.Data.HashMap',
      '',
      '#eval show IO Unit from do',
      '  let mut m : Std.HashMap Nat Nat := {}',
      '  for i in [0:10000] do',
      '    m := m.insert i i',
      '  let mut sum := 0',
      '  for i in [0:10000] do',
      '    sum := sum + (m.getD i 0)',
      '  IO.println s!"hashmap_sum={sum}"',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['hashmap_sum=49995000'],
  },
  {
    id: 'mem_string_512k',
    suite: 'init',
    category: 'memory-alloc',
    description: '倍增构造 512 KiB 字符串与长度验证',
    fileName: 'CdString512k.lean',
    code: [
      'import Init',
      '',
      'def dupStr (s : String) : Nat → String',
      '  | 0 => s',
      '  | n + 1 => dupStr (s ++ s) n',
      '',
      '#eval (dupStr "ab" 18).length',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['524288'],
  },
  {
    id: 'mem_binary_tree_32k',
    suite: 'init',
    category: 'memory-alloc',
    description: '深度 15 满二叉树构造与节点计数（32,767 节点）',
    fileName: 'CdTree32k.lean',
    code: [
      'import Init',
      '',
      'inductive BTree where',
      '  | leaf : BTree',
      '  | node : BTree → BTree → BTree',
      '',
      'def mkTree : Nat → BTree',
      '  | 0 => .leaf',
      '  | n + 1 => let sub := mkTree n; .node sub sub',
      '',
      'def countNodes : BTree → Nat',
      '  | .leaf => 1',
      '  | .node l r => 1 + countNodes l + countNodes r',
      '',
      '#eval countNodes (mkTree 14)',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['32767'],
  },

  // === multi-file (3) ===
  {
    id: 'multifile_import_helper',
    suite: 'init',
    category: 'multi-file',
    description: '跨文件预编译 .olean 导入与定理引用',
    fileName: 'CdMultiImport.lean',
    helperModules: {
      'CrossDiffHelper.lean': [
        'import Init',
        '',
        'namespace CrossDiffHelper',
        'def magic : Nat := 42',
        'theorem magic_eq : magic = 42 := rfl',
        'end CrossDiffHelper',
        '',
      ].join('\n'),
    },
    code: [
      'import CrossDiffHelper',
      '',
      'example : CrossDiffHelper.magic = 42 := CrossDiffHelper.magic_eq',
      '#eval CrossDiffHelper.magic',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['42'],
  },
  {
    id: 'multifile_std_lean_json',
    suite: 'init',
    category: 'multi-file',
    description: '多模块交叉 import（Std.Data.HashMap + Lean.Data.Json）',
    fileName: 'CdStdLeanJson.lean',
    code: [
      'import Std.Data.HashMap',
      'import Lean.Data.Json',
      '',
      '#eval show IO Unit from do',
      '  match Lean.Json.parse "{\\"k\\":7}" with',
      '  | .ok j => IO.println j.compress',
      '  | .error e => IO.println e',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['{"k":7}'],
  },
  {
    id: 'multifile_missing_import_reject',
    suite: 'init',
    category: 'multi-file',
    description: '导入不存在模块必须在两端报缺失模块错误',
    fileName: 'CdMissingImport.lean',
    code: ['import NonExistent.CrossDiff.GhostModule', '', 'example : True := trivial', ''].join(
      '\n',
    ),
    expectOk: false,
    expectErrorCategory: 'unknown-module',
  },

  // === error-diagnostic (5) ===
  {
    id: 'err_type_mismatch',
    suite: 'init',
    category: 'error-diagnostic',
    description: '基础类型不匹配诊断类别一致性',
    fileName: 'CdErrMismatch.lean',
    code: ['import Init', '', 'example : (1 : Nat) = "abc" := rfl', ''].join('\n'),
    expectOk: false,
    expectErrorCategory: 'type-mismatch',
  },
  {
    id: 'err_rfl_false_eq',
    suite: 'init',
    category: 'error-diagnostic',
    description: '1 + 1 = 3 := rfl 非定义相等报错一致性',
    fileName: 'CdErrRflFalse.lean',
    code: ['import Init', '', 'example : 1 + 1 = 3 := rfl', ''].join('\n'),
    expectOk: false,
    expectErrorCategory: 'type-mismatch',
  },
  {
    id: 'err_unknown_identifier',
    suite: 'init',
    category: 'error-diagnostic',
    description: '未声明标识符诊断类别一致性',
    fileName: 'CdErrUnknownId.lean',
    code: ['import Init', '', 'example : Nat := totallyUnknownCrossDiffSymbol', ''].join('\n'),
    expectOk: false,
    expectErrorCategory: 'unknown-identifier',
  },
  {
    id: 'err_unsolved_goals',
    suite: 'init',
    category: 'error-diagnostic',
    description: '未闭合策略目标（unsolved goals）诊断一致性',
    fileName: 'CdErrUnsolvedGoals.lean',
    code: ['import Init', '', 'example (p q : Prop) : p → q := by intro _', ''].join('\n'),
    expectOk: false,
    expectErrorCategory: 'unsolved-goals',
  },
  {
    id: 'err_universe_mismatch',
    suite: 'init',
    category: 'error-diagnostic',
    description: '宇宙多态层级冲突诊断一致性',
    fileName: 'CdErrUniverse.lean',
    code: [
      'import Init',
      '',
      'universe u v',
      'example (α : Type u) (β : Type v) : α = β := rfl',
      '',
    ].join('\n'),
    expectOk: false,
    expectErrorCategory: 'type-mismatch',
  },

  // === mathlib-tactic (3) ===
  {
    id: 'mathlib_order_preorder',
    suite: 'mathlib',
    category: 'mathlib-tactic',
    description: 'Mathlib.Order.Basic Preorder 传递性证明',
    fileName: 'CdMathlibOrder.lean',
    code: [
      'import Mathlib.Order.Basic',
      '',
      'example {α : Type} [Preorder α] {a b c : α} (h1 : a ≤ b) (h2 : b ≤ c) : a ≤ c := le_trans h1 h2',
      '#eval IO.println "mathlib_order_ok"',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['mathlib_order_ok'],
  },
  {
    id: 'mathlib_nat_prime',
    suite: 'mathlib',
    category: 'mathlib-tactic',
    description: 'Mathlib.Data.Nat.Prime.Basic 素数定理调用',
    fileName: 'CdMathlibPrime.lean',
    code: [
      'import Mathlib.Data.Nat.Prime.Basic',
      '',
      'example : Nat.Prime 2 := Nat.prime_two',
      '#eval IO.println "mathlib_prime_ok"',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['mathlib_prime_ok'],
  },
  {
    id: 'mathlib_ring_tactic',
    suite: 'mathlib',
    category: 'mathlib-tactic',
    description: 'Mathlib.Tactic.Ring 代数展开策略证明',
    fileName: 'CdMathlibRing.lean',
    code: [
      'import Mathlib.Tactic.Ring',
      '',
      'example (a b : Nat) : (a + b) * (a + b) = a * a + 2 * a * b + b * b := by ring',
      '#eval IO.println "mathlib_ring_ok"',
      '',
    ].join('\n'),
    expectOk: true,
    expectOutputs: ['mathlib_ring_ok'],
  },
];

export const selectCrossDiffCases = (
  suite: 'init' | 'all',
  filterIds?: readonly string[],
): readonly CrossDiffCase[] => {
  const bySuite =
    suite === 'all'
      ? CROSS_DIFF_CORPUS
      : CROSS_DIFF_CORPUS.filter((entry) => entry.suite === suite);
  if (!filterIds || filterIds.length === 0) return bySuite;
  const want = new Set(filterIds);
  const selected = bySuite.filter((entry) => want.has(entry.id));
  if (selected.length !== want.size) {
    const missing = [...want].filter((id) => !selected.some((item) => item.id === id));
    throw new Error(`未找到指定的跨端差分用例: ${missing.join(', ')}`);
  }
  return selected;
};

export const classifyDiagnostic = (
  severity: 'error' | 'warning' | 'info',
  message: string,
): DiagnosticCategory => {
  if (severity !== 'error') return severity;
  const text = message.toLowerCase();
  if (/recursion depth|maximum recursion|stack overflow/.test(text)) return 'recursion-depth';
  if (/unknown module|unknown package|object file .* does not exist|invalid import/.test(text)) {
    return 'unknown-module';
  }
  if (/unknown identifier|unknown constant/.test(text)) return 'unknown-identifier';
  if (/unsolved goals/.test(text)) return 'unsolved-goals';
  if (
    /type mismatch|failed to synthesize|application type mismatch|tactic 'rfl' failed|is not definitionally equal|level|universe/.test(
      text,
    )
  ) {
    return 'type-mismatch';
  }
  return 'other-error';
};

const LEAN_DIAG_HEADER = /^.+?:(\d+):(\d+): (error|warning|info): (.*)$/;

/** 解析官方原生 `lean` CLI 的 stdout/stderr，分离诊断项与 #eval 输出。 */
export const parseNativeLeanOutput = (
  stdout: string,
  stderr: string,
  exitCode: number,
  elapsedMs: number,
): CrossSideResult => {
  const combined = `${stdout}\n${stderr}`.replace(/\r\n/g, '\n');
  const diagnostics: Array<{
    severity: 'error' | 'warning' | 'info';
    line: number;
    lines: string[];
  }> = [];
  const plainLines: string[] = [];

  for (const rawLine of combined.split('\n')) {
    const line = rawLine.trimEnd();
    const header = LEAN_DIAG_HEADER.exec(line);
    if (header) {
      const lineNo = Number(header[1]);
      const severity = header[3] as 'error' | 'warning' | 'info';
      const headMsg = header[4] ?? '';
      diagnostics.push({ severity, line: lineNo, lines: [headMsg] });
      continue;
    }
    const current = diagnostics.at(-1);
    if (current && line.startsWith('  ')) {
      current.lines.push(line.trim());
    } else if (line !== '') {
      plainLines.push(line);
    }
  }

  const normalized: NormalizedDiagnostic[] = diagnostics.map((item) => {
    const message = item.lines.join('\n').trim();
    return {
      severity: item.severity,
      category: classifyDiagnostic(item.severity, message),
      message,
      line: item.line,
    };
  });
  const infoText = normalized
    .filter((item) => item.severity === 'info')
    .map((item) => item.message);
  const fullStdout = [...plainLines, ...infoText].join('\n').trim();
  return {
    exitCode,
    diagnostics: normalized,
    stdout: fullStdout,
    elapsedMs,
  };
};

export interface RawChromeDiagnostic {
  readonly severity?: number;
  readonly message?: string;
  readonly range?: { readonly start?: { readonly line?: number } };
}

/** 归一化 Chrome wasm64 LSP worker 的 publishDiagnostics 结果。 */
export const normalizeChromeLspResult = (
  diagnostics: readonly RawChromeDiagnostic[],
  elapsedMs: number,
  peakMemoryBytes?: number,
  workerError?: string,
): CrossSideResult => {
  const normalized: NormalizedDiagnostic[] = diagnostics.map((diag) => {
    const severity: 'error' | 'warning' | 'info' =
      diag.severity === 2
        ? 'warning'
        : diag.severity === 3 || diag.severity === 4
          ? 'info'
          : 'error';
    const message = String(diag.message ?? '').trim();
    const zeroBasedLine = diag.range?.start?.line;
    return {
      severity,
      category: classifyDiagnostic(severity, message),
      message,
      ...(typeof zeroBasedLine === 'number' ? { line: zeroBasedLine + 1 } : {}),
    };
  });
  const hasError = normalized.some((item) => item.severity === 'error');
  const exitCode = workerError !== undefined || hasError ? 1 : 0;
  const stdout = normalized
    .filter((item) => item.severity === 'info')
    .map((item) => item.message)
    .join('\n')
    .trim();
  return {
    exitCode,
    diagnostics: normalized,
    stdout,
    elapsedMs,
    ...(peakMemoryBytes === undefined ? {} : { peakMemoryBytes }),
    ...(workerError === undefined ? {} : { workerError }),
  };
};

/** 对比原生 Lean 与 Chrome wasm64 对同一样本的退出语义、核心输出与关键诊断类别。 */
export const compareCrossPlatformResults = (
  testCase: CrossDiffCase,
  native: CrossSideResult,
  chrome: CrossSideResult,
): CaseComparison => {
  const mismatches: string[] = [];
  if (chrome.workerError !== undefined) {
    mismatches.push(`Chrome worker 异常: ${chrome.workerError}`);
  }
  const nativeOk = native.exitCode === 0;
  const chromeOk = chrome.exitCode === 0;
  if (nativeOk !== testCase.expectOk) {
    mismatches.push(
      `原生 Lean 预期 expectOk=${String(testCase.expectOk)}，实际 exitCode=${native.exitCode}`,
    );
  }
  if (nativeOk !== chromeOk) {
    mismatches.push(
      `双端放行/拒绝不一致: native.exitCode=${native.exitCode}, chrome.exitCode=${chrome.exitCode}`,
    );
  }

  if (!testCase.expectOk && testCase.expectErrorCategory) {
    const nativeErrs = new Set(
      native.diagnostics.filter((d) => d.severity === 'error').map((d) => d.category),
    );
    const chromeErrs = new Set(
      chrome.diagnostics.filter((d) => d.severity === 'error').map((d) => d.category),
    );
    if (!nativeErrs.has(testCase.expectErrorCategory)) {
      mismatches.push(
        `原生错误类别未包含 ${testCase.expectErrorCategory}（实际: ${[...nativeErrs].join(',') || '无'}）`,
      );
    }
    if (!chromeErrs.has(testCase.expectErrorCategory)) {
      mismatches.push(
        `Chrome 错误类别未包含 ${testCase.expectErrorCategory}（实际: ${[...chromeErrs].join(',') || '无'}）`,
      );
    }
  }

  for (const expected of testCase.expectOutputs ?? []) {
    if (!native.stdout.includes(expected)) {
      mismatches.push(`原生输出缺少关键片段: ${expected}`);
    }
    if (!chrome.stdout.includes(expected)) {
      mismatches.push(`Chrome LSP info 缺少关键片段: ${expected}`);
    }
  }

  return {
    id: testCase.id,
    category: testCase.category,
    suite: testCase.suite,
    ok: mismatches.length === 0,
    mismatches,
    native,
    chrome,
  };
};

export const renderDiffSummaryMarkdown = (report: CrossDiffReport): string => {
  const lines: string[] = [];
  lines.push(`### 官方原生 Lean vs Chrome Wasm64 跨端差分（suite=${report.suite}）`);
  lines.push('');
  lines.push(
    `共 **${report.total}** 组，通过 **${report.passed}** 组，失败 **${report.failed}** 组。`,
  );
  lines.push('');
  lines.push('| 用例 | 类别 | 原生 (ms) | Chrome (ms) | 峰值内存 | 状态 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of report.cases) {
    const mem =
      typeof entry.chrome.peakMemoryBytes === 'number'
        ? `${Math.round(entry.chrome.peakMemoryBytes / (1024 * 1024))} MiB`
        : '-';
    const status = entry.ok ? 'PASS' : `FAIL: ${entry.mismatches.join('; ')}`;
    lines.push(
      `| \`${entry.id}\` | ${entry.category} | ${entry.native.elapsedMs} | ${entry.chrome.elapsedMs} | ${mem} | ${status} |`,
    );
  }
  return `${lines.join('\n')}\n`;
};
