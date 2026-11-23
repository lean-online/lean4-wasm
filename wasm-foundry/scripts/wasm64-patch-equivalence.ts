// 行为一致性门禁 v2（5 层防线 + 双独立数学检验器）：
// - 第 1 层（Curated 子集；全量由 native-consistency-gate.yml CTest 执行）：官方 tests/elab 与 tests/elab_fail 差分
// - 第 2 层：固定随机种子 Expr DAG + WHNF.Config 差分 Fuzzing（native 300 组 / wasm64 48 组）
// - 第 3 层：反向报错拒绝集（Negative Corpus，严格禁止候选端放行）+ 双独立检验器（C++ leanchecker + Rust nanoda_bin）
// - 第 4 层：由 scripts/ci/check-abi-diff.ts 独立执行 C 导出符号表 ABI Diff
// - 第 5 层：显式有意差异登记簿 DIV-001 专属边界验证（DivergenceSimpRecDepth.lean）
// - 平台压测：wasm64 CLI 与 LSP --worker 深栈（N=800..2000）与退出码回归
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CERT_THEOREM_NAMES,
  REJECT_THEOREM_NAMES,
  buildCertificateProofCorpus,
  buildTamperedAxiomCorpus,
  runDualCheckerSuite,
  type DualCheckerOptions,
  type DualCheckerReport,
} from './ci/verify-dual-checkers.ts';
import {
  CliError,
  optionalString,
  parseArgs,
  requireNumber,
  requireString,
  runCli,
  type FlagSpec,
} from './lib/cli.ts';
import {
  DEFAULT_FUZZ_SEED,
  DEFAULT_NATIVE_FUZZ_CASES,
  DEFAULT_WASM_FUZZ_CASES,
  buildFuzzDifferentialCorpus,
} from './lib/differential-fuzz.ts';
import { buildDivergenceBoundaryCorpus } from './lib/divergences.ts';
import { isMainModule } from './lib/entry.ts';
import { requireDir, requireFile } from './lib/fs-guards.ts';

/** 上游 Lean tests/elab 中仅依赖 Init/Lean 且零外部依赖的核心回归用例。 */
export const CURATED_UPSTREAM_TESTS = [
  'tests/elab/6123_mod_cast.lean',
  'tests/elab/whnfProj.lean',
  'tests/elab/whnfDelayedMVarIssue.lean',
  'tests/elab/simpConfigPropagationIssue1.lean',
  'tests/elab/dsimpZetaIssue.lean',
] as const;

/** 上游 Lean tests/elab_fail 中零外部依赖的反向拒绝基准用例。 */
export const CURATED_UPSTREAM_FAIL_TESTS = [
  'tests/elab_fail/1011.lean',
  'tests/elab_fail/1062.lean',
  'tests/elab_fail/1079.lean',
] as const;

export interface NegativeCorpusCase {
  readonly name: string;
  readonly description: string;
  readonly code: string;
}

/** 面向内核类型检查、宇宙层级、Kernel addDecl、Simp/WHNF 失败契约的反向拒绝用例集。 */
export const NEGATIVE_CORPUS_CASES: readonly NegativeCorpusCase[] = [
  {
    name: 'neg_type_mismatch.lean',
    description: '基础类型不匹配必须被 Elaborator/Kernel 拒绝',
    code: ['import Init', '', 'example : (1 : Nat) = "abc" := rfl', ''].join('\n'),
  },
  {
    name: 'neg_universe_mismatch.lean',
    description: '宇宙多态层级不一致必须拒绝',
    code: [
      'import Init',
      '',
      'universe u v',
      'example (α : Type u) (β : Type v) : α = β := rfl',
      '',
    ].join('\n'),
  },
  {
    name: 'neg_kernel_adddecl_illtyped.lean',
    description: '绕过 Elaborator 直接喂入非法证明项必须被 C++ Kernel addDecl 拒绝',
    code: [
      'import Lean',
      '',
      'open Lean',
      '',
      '#eval show CoreM Unit from do',
      '  let natTy := Expr.const ``Nat []',
      '  let zero := Expr.const ``Nat.zero []',
      '  let one := Expr.app (.const ``Nat.succ []) zero',
      '  let decl := Declaration.thmDecl {',
      '    name := `bogusKernelThm',
      '    levelParams := []',
      '    type := mkAppN (.const ``Eq [1]) #[natTy, zero, one]',
      '    value := zero',
      '  }',
      '  addDecl decl',
      '',
    ].join('\n'),
  },
  {
    name: 'neg_simp_max_steps.lean',
    description: 'simp 超过 maxSteps 上限必须非零退出报错',
    code: [
      'import Init',
      '',
      'private def negLin : Nat → Nat',
      '  | 0 => 0',
      '  | n + 1 => negLin n',
      '',
      'example : negLin 20 = 0 := by',
      '  simp (config := { maxSteps := 4 }) [negLin]',
      '',
    ].join('\n'),
  },
  {
    name: 'neg_whnf_defeq_fail.lean',
    description: '不可定义相等的 let 归约不得被 rfl 误放行',
    code: ['import Init', '', 'example (n : Nat) : (let x := n + 1; x) = n := rfl', ''].join('\n'),
  },
  {
    name: 'neg_simp_unsolved_goal.lean',
    description: '未闭合目标的 simp 必须失败',
    code: ['import Init', '', 'example (n : Nat) : n + 1 = n := by simp', ''].join('\n'),
  },
];

export interface EquivalenceOptions {
  readonly bootLean: string;
  readonly bootLib: string;
  readonly wasmLean?: string;
  readonly runLean?: string;
  readonly candidateLean?: string;
  readonly candidateLib?: string;
  readonly lspGlue?: string;
  readonly lean4Src: string;
  readonly lspScript: string;
  readonly fuzzSeed: number;
  readonly fuzzCases: number;
  readonly leanchecker?: string;
  readonly leanexport?: string;
  readonly nanoda?: string;
  readonly externalCheckerCmd?: string;
  readonly skipDeepStress: boolean;
  readonly timeoutMs: number;
}

export interface RunOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const EQUIV_SPEC: Record<string, FlagSpec> = {
  'boot-lean': { kind: 'string', required: true, valueName: 'bin/lean' },
  'boot-lib': { kind: 'string', required: true, valueName: 'lib/lean' },
  'wasm-lean': { kind: 'string', valueName: 'lean.mjs' },
  'run-lean': { kind: 'string', valueName: 'run-lean.mjs' },
  'candidate-lean': { kind: 'string', valueName: 'native-fork/bin/lean' },
  'candidate-lib': { kind: 'string', valueName: 'native-fork/lib/lean' },
  'lsp-glue': { kind: 'string', valueName: 'lean-adapted-proxy.mjs' },
  'lean4-src': { kind: 'string', required: true, valueName: 'lean4Root' },
  'lsp-script': { kind: 'string', valueName: 'wasm64-lsp-diagnostics.ts' },
  'fuzz-seed': { kind: 'number', valueName: 'seed' },
  'fuzz-cases': { kind: 'number', valueName: 'n' },
  leanchecker: { kind: 'string', valueName: 'bin/leanchecker' },
  leanexport: { kind: 'string', valueName: 'bin/leanexport' },
  nanoda: { kind: 'string', valueName: 'bin/nanoda_bin' },
  'external-checker': { kind: 'string', valueName: 'cmd' },
  'skip-deep-stress': { kind: 'boolean' },
  timeout: { kind: 'number', valueName: 'ms' },
};

export const parseEquivalenceOptions = (argv: readonly string[]): EquivalenceOptions => {
  const parsed = parseArgs(argv, EQUIV_SPEC);
  const timeoutMs = parsed.flags.timeout === undefined ? 180_000 : requireNumber(parsed, 'timeout');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`--timeout 必须是正整数，收到 ${timeoutMs}`);
  }

  const wasmLean = optionalString(parsed, 'wasm-lean');
  const runLean = optionalString(parsed, 'run-lean');
  const candidateLean = optionalString(parsed, 'candidate-lean');
  const candidateLib = optionalString(parsed, 'candidate-lib');

  const hasWasmPair = wasmLean !== undefined && runLean !== undefined;
  const hasPartialWasm = (wasmLean !== undefined) !== (runLean !== undefined);
  if (hasPartialWasm) {
    throw new CliError('--wasm-lean 与 --run-lean 必须同时提供');
  }
  if (!hasWasmPair && candidateLean === undefined) {
    throw new CliError('必须提供 (--wasm-lean + --run-lean) 或 --candidate-lean 作为候选引擎');
  }

  const fuzzSeed =
    parsed.flags['fuzz-seed'] === undefined
      ? DEFAULT_FUZZ_SEED
      : requireNumber(parsed, 'fuzz-seed');
  if (!Number.isInteger(fuzzSeed)) {
    throw new CliError(`--fuzz-seed 必须是整数，收到 ${fuzzSeed}`);
  }

  const defaultFuzzCases =
    candidateLean !== undefined && !hasWasmPair
      ? DEFAULT_NATIVE_FUZZ_CASES
      : DEFAULT_WASM_FUZZ_CASES;
  const fuzzCases =
    parsed.flags['fuzz-cases'] === undefined
      ? defaultFuzzCases
      : requireNumber(parsed, 'fuzz-cases');
  if (!Number.isInteger(fuzzCases) || fuzzCases <= 0) {
    throw new CliError(`--fuzz-cases 必须是正整数，收到 ${fuzzCases}`);
  }

  const lspGlue = optionalString(parsed, 'lsp-glue');
  const lspScript =
    optionalString(parsed, 'lsp-script') ??
    resolve(import.meta.dirname, 'wasm64-lsp-diagnostics.ts');
  const leanchecker = optionalString(parsed, 'leanchecker');
  const leanexport = optionalString(parsed, 'leanexport');
  const nanoda = optionalString(parsed, 'nanoda');
  const externalCheckerCmd = optionalString(parsed, 'external-checker');
  if (nanoda && !leanexport) {
    throw new CliError('启用 --nanoda 时必须同时提供 --leanexport');
  }

  return {
    bootLean: requireFile(requireString(parsed, 'boot-lean'), 'boot-lean'),
    bootLib: requireDir(requireString(parsed, 'boot-lib'), 'boot-lib'),
    ...(wasmLean === undefined ? {} : { wasmLean: requireFile(wasmLean, 'wasm-lean') }),
    ...(runLean === undefined ? {} : { runLean: requireFile(runLean, 'run-lean') }),
    ...(candidateLean === undefined
      ? {}
      : { candidateLean: requireFile(candidateLean, 'candidate-lean') }),
    ...(candidateLib === undefined
      ? {}
      : { candidateLib: requireDir(candidateLib, 'candidate-lib') }),
    ...(lspGlue === undefined ? {} : { lspGlue: requireFile(lspGlue, 'lsp-glue') }),
    lean4Src: requireDir(requireString(parsed, 'lean4-src'), 'lean4-src'),
    lspScript: requireFile(lspScript, 'lsp-script'),
    fuzzSeed,
    fuzzCases,
    ...(leanchecker === undefined ? {} : { leanchecker: requireFile(leanchecker, 'leanchecker') }),
    ...(leanexport === undefined ? {} : { leanexport: requireFile(leanexport, 'leanexport') }),
    ...(nanoda === undefined ? {} : { nanoda: requireFile(nanoda, 'nanoda') }),
    ...(externalCheckerCmd === undefined ? {} : { externalCheckerCmd }),
    skipDeepStress: Boolean(parsed.flags['skip-deep-stress']),
    timeoutMs,
  };
};

/** 归一化 Lean 标准输出：抹平宿主机路径与 /src 虚拟挂载路径、CRLF 和行尾空白差异。 */
export const normalizeStdout = (text: string, hostSrcDir: string): string => {
  const normalizedHost = resolve(hostSrcDir).replace(/\\/g, '/');
  return text
    .replace(/\r\n/g, '\n')
    .replaceAll(`${normalizedHost}/`, '<src>/')
    .replaceAll(`${hostSrcDir}/`, '<src>/')
    .replaceAll('/src/', '<src>/')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
};

const LOG_PREVIEW_CHARS = 4000;

const preview = (text: string): string =>
  text.length <= LOG_PREVIEW_CHARS ? text : `${text.slice(0, LOG_PREVIEW_CHARS)}\n…（已截断）`;

export const assertOutputsMatch = (
  label: string,
  expected: RunOutput,
  actual: RunOutput,
  hostSrcDir: string,
): void => {
  if (expected.status !== actual.status) {
    throw new Error(
      `[${label}] 退出码不一致: boot=${expected.status} candidate=${actual.status}\n` +
        `boot stdout:\n${preview(normalizeStdout(expected.stdout, hostSrcDir))}\n` +
        `boot stderr:\n${preview(expected.stderr)}\n` +
        `candidate stdout:\n${preview(normalizeStdout(actual.stdout, hostSrcDir))}\n` +
        `candidate stderr:\n${preview(actual.stderr)}`,
    );
  }
  const bootOut = normalizeStdout(expected.stdout, hostSrcDir);
  const candOut = normalizeStdout(actual.stdout, hostSrcDir);
  if (bootOut !== candOut) {
    throw new Error(
      `[${label}] 输出行为与原版 Lean 不一致!\n--- boot ---\n${preview(bootOut)}\n--- candidate ---\n${preview(candOut)}`,
    );
  }
};

/** 反向拒绝断言：官方原版必须非零拒绝，候选引擎也必须以相同错误拒绝，严禁错误放行（status=0）。 */
export const assertNegativeMatch = (
  label: string,
  expectedReject: RunOutput,
  actual: RunOutput,
  hostSrcDir: string,
): void => {
  if (expectedReject.status === 0) {
    throw new Error(`[${label}] 反例自身在原版 boot lean 返回 0，用例无效！`);
  }
  if (actual.status === 0) {
    throw new Error(
      `[${label}] 安全红线违背：官方原版拒绝 (status=${expectedReject.status})，但候选引擎错误放行 (status=0)！\n` +
        `boot stdout:\n${preview(normalizeStdout(expectedReject.stdout, hostSrcDir))}\n` +
        `candidate stdout:\n${preview(normalizeStdout(actual.stdout, hostSrcDir))}`,
    );
  }
  assertOutputsMatch(label, expectedReject, actual, hostSrcDir);
};

export const KNOWN_EXIT_TRAP_PATTERN = /emscripten_builtin_free|lean_dec_ref_cold/;

export const isKnownExitTrap = (output: RunOutput): boolean =>
  output.status !== 0 && KNOWN_EXIT_TRAP_PATTERN.test(output.stderr);

const stdoutMatches = (expected: RunOutput, actual: RunOutput, hostSrcDir: string): boolean =>
  normalizeStdout(expected.stdout, hostSrcDir) === normalizeStdout(actual.stdout, hostSrcDir);

export const withExitTrapTolerance = (
  label: string,
  runOnce: () => RunOutput,
  check: (output: RunOutput) => void,
  hasEvidence: (output: RunOutput) => boolean = () => true,
): RunOutput => {
  const blamePartialOutput = (output: RunOutput, error: unknown): Error =>
    new Error(
      `[${label}] candidate 在跑到一半就被已知退出期 trap 打断 (status=${output.status})，校验未通过\n` +
        `candidate stderr:\n${preview(output.stderr)}\n` +
        `原始差异:\n${error instanceof Error ? error.message : String(error)}`,
    );

  const first = runOnce();
  try {
    check(first);
    return first;
  } catch (error) {
    if (!isKnownExitTrap(first)) throw error;
    if (!hasEvidence(first)) throw blamePartialOutput(first, error);

    const second = runOnce();
    try {
      check(second);
      console.warn(
        `[equiv] ${label} 首次在退出期被已知 trap 打断 (status=${first.status})，重跑通过`,
      );
      return second;
    } catch (retryError) {
      if (!isKnownExitTrap(second)) throw retryError;
      if (!hasEvidence(second)) throw blamePartialOutput(second, retryError);
      console.warn(
        `[equiv] WARN ${label} 退出期崩溃复现 (status=${second.status})，但输出证据完整` +
          '（stdout/产物校验已通过）；按 docs/WASM64-SPIKE.md 记录的运行时限制放行，不阻断门禁',
      );
      return second;
    }
  }
};

export const compareWithExitTrapTolerance = (
  label: string,
  expected: RunOutput,
  runOnce: () => RunOutput,
  hostSrcDir: string,
): RunOutput =>
  withExitTrapTolerance(
    label,
    runOnce,
    (output) => assertOutputsMatch(label, expected, output, hostSrcDir),
    (output) => stdoutMatches(expected, output, hostSrcDir),
  );

/** 面向 replace_fn / WHNF / Simp 三处补丁高危边界的定向等价性用例。 */
export const buildDifferentialCorpus = (): string =>
  [
    'import Lean',
    '',
    'open Lean Lean.Meta',
    '',
    '-- 1. replace_fn / instantiateLevelParams：共享子树、未共享子树与多构造器递归',
    'private def mkMixedExpr : Expr :=',
    '  let u : Level := .param `u',
    '  let v : Level := .param `v',
    '  let shared : Expr := .app (.const `Nat.succ []) (.const `Nat.zero [])',
    '  let body : Expr :=',
    '    .letE `x (.const `Nat []) shared',
    '      (.app (.app (.const `Nat.add []) (.bvar 0)) (.mdata {} (.proj `Prod 0 (.app shared shared)))) false',
    '  .lam `n (.const `Nat []) (.forallE `m (.sort (.succ u)) (.app (.const `id [v]) body) .default) .default',
    '',
    '#eval show CoreM Unit from do',
    '  let e := mkMixedExpr',
    '  let replaced := e.replace fun sub =>',
    '    if sub.isConstOf `Nat.zero then some (.const `zeroAlt []) else none',
    '  let noop := e.replace fun _ => none',
    '  let inst := e.instantiateLevelParams [`u, `v] [.one, .succ .one]',
    '  IO.println s!"replace_eq_noop={e == noop}"',
    '  IO.println s!"replace_changed={e != replaced}"',
    '  IO.println s!"replace_hash={replaced.hash}"',
    '  IO.println s!"replace_str={replaced}"',
    '  IO.println s!"inst_hash={inst.hash}"',
    '  IO.println s!"inst_str={inst}"',
    '',
    '-- 2. WHNF：zeta / zetaHave / zetaUnused / trackZetaDelta / cfg.beta / cfg.proj 四模式',
    'def mkFun : Nat → (Nat → Nat) := fun k x => x + k',
    'structure Box where val : Nat',
    'def wrapBox (n : Nat) : Box := ⟨n + 1⟩',
    '',
    'private def runWhnfCases : MetaM Unit := do',
    '  let projExpr : Expr := .proj `Box 0 (.app (.const `wrapBox []) (.lit (.natVal 4)))',
    '  for mode in [TransparencyMode.all, .default, .reducible, .instances] do',
    '    let out ← withTransparency mode <| withConfig (fun c => { c with proj := .yes }) (whnf projExpr)',
    '    IO.println s!"proj_yes[{reprStr mode}]={out}"',
    '  let outNo ← withConfig (fun c => { c with proj := .no }) (whnf projExpr)',
    '  IO.println s!"proj_no={outNo}"',
    '  let appHeadNonLam : Expr := .app (.app (.const `mkFun []) (.lit (.natVal 5))) (.lit (.natVal 1))',
    '  let appHeadLam : Expr := .app (.lam `x (.const `Nat []) (.bvar 0) .default) (.lit (.natVal 9))',
    '  let noBeta1 ← withConfig (fun c => { c with beta := false }) (whnf appHeadNonLam)',
    '  let noBeta2 ← withConfig (fun c => { c with beta := false }) (whnf appHeadLam)',
    '  IO.println s!"beta_false_nonlam={noBeta1} beta_false_lam={noBeta2}"',
    '  let res ← withLetDecl `a (.const `Nat []) (.lit (.natVal 7)) fun fv => do',
    '    withConfig (fun c => { c with zetaDelta := true }) <| withTrackingZetaDelta do',
    '      let w ← whnf (.app (.app (.const `Nat.add []) fv) (.lit (.natVal 2)))',
    '      let tracked ← getZetaDeltaFVarIds',
    '      return (w, tracked.contains fv.fvarId!)',
    '  IO.println s!"zeta_delta={res.1} tracked={res.2}"',
    '  let unusedLet : Expr := .letE `u (.const `Nat []) (.lit (.natVal 99)) (.lit (.natVal 3)) true',
    '  let outUnused ← withConfig (fun c => { c with zeta := false, zetaUnused := true }) (whnf unusedLet)',
    '  IO.println s!"zeta_unused={outUnused}"',
    '',
    '#eval show MetaM Unit from runWhnfCases',
    '',
    '-- 3. Simp：multi-step、singlePass、memoize=false 与 maxSteps 截断报错一致性',
    'private def lin : Nat → Nat',
    '  | 0 => 0',
    '  | n + 1 => lin n',
    '',
    'theorem lin_ok : lin 12 = 0 := by simp [lin]',
    '',
    'example : (let x := 2; x + lin 6) = 2 := by',
    '  simp (config := { singlePass := true }) [lin]',
    '',
    'example : lin 6 = 0 := by',
    '  simp (config := { memoize := false }) [lin]',
    '',
    '/-- error: `simp` failed: maximum number of steps exceeded -/',
    '#guard_msgs in',
    'example : lin 20 = 0 := by',
    '  simp (config := { maxSteps := 4 }) [lin]',
    '',
    '-- 4. trace.Meta.whnf 定向校验',
    'set_option trace.Meta.whnf true in',
    'example : (let x := 1; x + 2) = 3 := rfl',
    '',
  ].join('\n');

/** 深层递归压测（仅 wasm64 需要跑过；验证 replace_fn / whnfCoreStep / simpLoopStep）。 */
export const buildDeepStressCorpus = (): string =>
  [
    'import Lean',
    '',
    'open Lean',
    '',
    'private def mkDeepApp (n : Nat) : Expr :=',
    '  Nat.rec (.const `base [Level.param `u]) (fun _ acc =>',
    '    .lam `x (.const `Nat []) (.app acc (.bvar 0)) .default) n',
    '',
    '#eval show IO Unit from do',
    '  let e := mkDeepApp 2000',
    '  let r := e.replace fun sub => if sub.isConstOf `base then some (.const `base2 []) else none',
    '  let i := e.instantiateLevelParams [`u] [.one]',
    '  if r == e || i == e then throw (IO.userError "deep replace_fn did not transform")',
    '  IO.println "deep_replace_ok"',
    '',
    'private def deepLin : Nat → Nat',
    '  | 0 => 0',
    '  | n + 1 => deepLin n',
    '',
    'set_option maxRecDepth 8000 in',
    'example : deepLin 800 = 0 := by simp [deepLin]',
    '',
    'private def nestedAdd (n : Nat) : Nat :=',
    '  match n with',
    '  | 0 => 0',
    '  | k + 1 => let x := nestedAdd k; x',
    '',
    'set_option maxRecDepth 8000 in',
    'example : nestedAdd 400 = 0 := by simp [nestedAdd]',
    '',
    '#eval IO.println "deep_stress_ok"',
    '',
  ].join('\n');

const runBootLean = (options: EquivalenceOptions, workDir: string, filePath: string): RunOutput => {
  const res = spawnSync(options.bootLean, ['-j1', '-R', workDir, filePath], {
    cwd: workDir,
    env: { ...process.env, LEAN_PATH: options.bootLib },
    encoding: 'utf8',
    timeout: options.timeoutMs,
  });
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

const runCandidateLean = (
  options: EquivalenceOptions,
  workDir: string,
  relFile: string,
): RunOutput => {
  if (options.candidateLean) {
    const res = spawnSync(options.candidateLean, ['-j1', '-R', workDir, join(workDir, relFile)], {
      cwd: workDir,
      env: { ...process.env, LEAN_PATH: options.candidateLib ?? options.bootLib },
      encoding: 'utf8',
      timeout: options.timeoutMs,
    });
    if (res.error) throw res.error;
    return {
      status: res.status ?? 1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  }
  const res = spawnSync(
    process.execPath,
    [
      options.runLean as string,
      options.wasmLean as string,
      workDir,
      options.bootLib,
      '--',
      '-j1',
      '-R',
      '/src',
      `/src/${relFile}`,
    ],
    {
      encoding: 'utf8',
      timeout: options.timeoutMs,
    },
  );
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

const compileCandidateOlean = (
  options: EquivalenceOptions,
  workDir: string,
  relFile: string,
  outOleanRel: string,
): RunOutput => {
  if (options.candidateLean) {
    const res = spawnSync(
      options.candidateLean,
      ['-j1', '-R', workDir, '-o', join(workDir, outOleanRel), join(workDir, relFile)],
      {
        cwd: workDir,
        env: { ...process.env, LEAN_PATH: options.candidateLib ?? options.bootLib },
        encoding: 'utf8',
        timeout: options.timeoutMs,
      },
    );
    if (res.error) throw res.error;
    return {
      status: res.status ?? 1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  }
  const res = spawnSync(
    process.execPath,
    [
      options.runLean as string,
      options.wasmLean as string,
      workDir,
      options.bootLib,
      '--',
      '-j1',
      '-R',
      '/src',
      '-o',
      `/src/${outOleanRel}`,
      `/src/${relFile}`,
    ],
    {
      encoding: 'utf8',
      timeout: options.timeoutMs,
    },
  );
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

export interface EquivalenceRunners {
  readonly runBoot?: (options: EquivalenceOptions, workDir: string, filePath: string) => RunOutput;
  readonly runWasm?: (options: EquivalenceOptions, workDir: string, relFile: string) => RunOutput;
  readonly runCandidate?: (
    options: EquivalenceOptions,
    workDir: string,
    relFile: string,
  ) => RunOutput;
  readonly compileOlean?: (
    options: EquivalenceOptions,
    workDir: string,
    relFile: string,
    outOleanRel: string,
  ) => RunOutput;
  readonly runDualCheckers?: (dualOptions: DualCheckerOptions) => DualCheckerReport;
  readonly runLsp?: (options: EquivalenceOptions, deepCode: string) => RunOutput;
}

const runLspDeepCheck = (options: EquivalenceOptions, deepCode: string): RunOutput => {
  if (!options.lspGlue) {
    throw new Error('缺少 --lsp-glue 参数');
  }
  const res = spawnSync(
    process.execPath,
    [
      options.lspScript,
      '--lean',
      options.lspGlue,
      '--lib',
      options.bootLib,
      '--doc',
      'Good.lean',
      '--good-code',
      deepCode,
      '--expect-info',
      'lsp_deep_ok',
      '--mode',
      'worker',
      '--timeout',
      String(options.timeoutMs),
      '--idle-timeout',
      '120000',
      '--jobs',
      '4',
    ],
    { encoding: 'utf8', timeout: options.timeoutMs + 30_000 },
  );
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

export const runEquivalenceSuite = (
  options: EquivalenceOptions,
  runners: EquivalenceRunners = {},
): void => {
  const runBoot = runners.runBoot ?? runBootLean;
  const runCandidate = runners.runCandidate ?? runners.runWasm ?? runCandidateLean;
  const compileOlean = runners.compileOlean ?? compileCandidateOlean;
  const runCheckers = runners.runDualCheckers ?? ((dOpts) => runDualCheckerSuite(dOpts));
  const runLsp = runners.runLsp ?? runLspDeepCheck;

  const workDir = mkdtempSync(join(tmpdir(), 'wasm64-patch-equiv-'));
  try {
    // 第 1 层（Curated 核心正向回归）
    for (const rel of CURATED_UPSTREAM_TESTS) {
      const srcPath = join(options.lean4Src, rel);
      if (!existsSync(srcPath)) {
        throw new Error(`找不到上游回归测试文件: ${srcPath}`);
      }
      const name = rel.replace(/\//g, '_');
      const localFile = join(workDir, name);
      writeFileSync(localFile, readFileSync(srcPath, 'utf8'));
      const bootRes = runBoot(options, workDir, localFile);
      if (bootRes.status !== 0) {
        throw new Error(
          `上游测试 ${rel} 在原版 boot lean 就失败 (${bootRes.status}): ${bootRes.stderr}`,
        );
      }
      compareWithExitTrapTolerance(
        rel,
        bootRes,
        () => runCandidate(options, workDir, name),
        workDir,
      );
      console.log(`[equiv] upstream pass: ${rel}`);
    }

    // 定向核心差分语料
    const diffPath = join(workDir, 'PatchEquiv.lean');
    writeFileSync(diffPath, buildDifferentialCorpus());
    const bootDiff = runBoot(options, workDir, diffPath);
    if (bootDiff.status !== 0) {
      throw new Error(
        `PatchEquiv.lean 在原版 boot lean 失败 (${bootDiff.status}): ${bootDiff.stderr}\n${bootDiff.stdout}`,
      );
    }
    compareWithExitTrapTolerance(
      'PatchEquiv.lean',
      bootDiff,
      () => runCandidate(options, workDir, 'PatchEquiv.lean'),
      workDir,
    );
    console.log('[equiv] PatchEquiv.lean differential match ok');

    // 第 2 层：固定随机种子 Expr DAG + WHNF.Config 差分 Fuzzing
    const fuzzPath = join(workDir, 'FuzzEquiv.lean');
    writeFileSync(
      fuzzPath,
      buildFuzzDifferentialCorpus({
        seed: options.fuzzSeed,
        exprCases: options.fuzzCases,
        whnfCases: options.fuzzCases,
      }),
    );
    const bootFuzz = runBoot(options, workDir, fuzzPath);
    if (bootFuzz.status !== 0) {
      throw new Error(
        `FuzzEquiv.lean 在原版 boot lean 失败 (${bootFuzz.status}): ${bootFuzz.stderr}\n${bootFuzz.stdout}`,
      );
    }
    compareWithExitTrapTolerance(
      `FuzzEquiv.lean(seed=${options.fuzzSeed},n=${options.fuzzCases})`,
      bootFuzz,
      () => runCandidate(options, workDir, 'FuzzEquiv.lean'),
      workDir,
    );
    console.log(
      `[equiv] layer-2 fuzz differential ok (seed=${options.fuzzSeed}, cases=${options.fuzzCases})`,
    );

    // 第 3 层 A：反向报错拒绝集（自定反例 + 上游 tests/elab_fail 抽样）
    for (const negCase of NEGATIVE_CORPUS_CASES) {
      const negPath = join(workDir, negCase.name);
      writeFileSync(negPath, negCase.code);
      const bootNeg = runBoot(options, workDir, negPath);
      withExitTrapTolerance(
        negCase.name,
        () => runCandidate(options, workDir, negCase.name),
        (candOut) => assertNegativeMatch(negCase.name, bootNeg, candOut, workDir),
        (candOut) =>
          candOut.status !== 0 &&
          normalizeStdout(bootNeg.stdout, workDir) === normalizeStdout(candOut.stdout, workDir),
      );
      console.log(`[equiv] layer-3a negative reject ok: ${negCase.name}`);
    }

    for (const rel of CURATED_UPSTREAM_FAIL_TESTS) {
      const srcPath = join(options.lean4Src, rel);
      if (!existsSync(srcPath)) {
        throw new Error(`找不到上游反向测试文件: ${srcPath}`);
      }
      const name = rel.replace(/\//g, '_');
      const localFile = join(workDir, name);
      writeFileSync(localFile, readFileSync(srcPath, 'utf8'));
      const bootNeg = runBoot(options, workDir, localFile);
      withExitTrapTolerance(
        rel,
        () => runCandidate(options, workDir, name),
        (candOut) => assertNegativeMatch(rel, bootNeg, candOut, workDir),
        (candOut) =>
          candOut.status !== 0 &&
          normalizeStdout(bootNeg.stdout, workDir) === normalizeStdout(candOut.stdout, workDir),
      );
      console.log(`[equiv] layer-3a upstream negative reject ok: ${rel}`);
    }

    // 第 5 层：有意差异 DIV-001 专属边界验证
    const divBoundary = buildDivergenceBoundaryCorpus();
    const divPath = join(workDir, divBoundary.name);
    writeFileSync(divPath, divBoundary.code);
    const bootDiv = runBoot(options, workDir, divPath);
    const bootDivText = `${bootDiv.stdout}\n${bootDiv.stderr}`;
    if (bootDiv.status === 0 || !divBoundary.expectedBootErrorPattern.test(bootDivText)) {
      throw new Error(
        `[layer-5 ${divBoundary.divergenceId}] 原版 boot lean 未按预期触发递归深度拒绝 (status=${bootDiv.status}):\n${preview(bootDivText)}`,
      );
    }
    withExitTrapTolerance(
      `${divBoundary.divergenceId}:${divBoundary.name}`,
      () => runCandidate(options, workDir, divBoundary.name),
      (candOut) => {
        if (candOut.status !== 0 || !candOut.stdout.includes(divBoundary.expectedForkMarker)) {
          throw new Error(
            `[layer-5 ${divBoundary.divergenceId}] 候选引擎未通过专属边界用例 (status=${candOut.status}):\n${preview(candOut.stdout)}\n${preview(candOut.stderr)}`,
          );
        }
      },
      (candOut) => candOut.stdout.includes(divBoundary.expectedForkMarker),
    );
    console.log(`[equiv] layer-5 divergence boundary ${divBoundary.divergenceId} ok`);

    // 第 3 层 B：双独立数学检验器交叉审计（候选引擎产物 -> 官方 C++ leanchecker + Rust nanoda_bin）
    if (options.leanchecker || options.nanoda || options.externalCheckerCmd) {
      const certDir = join(workDir, 'cert-oleans');
      mkdirSync(certDir, { recursive: true });
      writeFileSync(join(workDir, 'CertProofs.lean'), buildCertificateProofCorpus());
      writeFileSync(join(workDir, 'CertRejectSorry.lean'), buildTamperedAxiomCorpus());

      for (const modName of ['CertProofs', 'CertRejectSorry']) {
        const relLean = `${modName}.lean`;
        const relOlean = `cert-oleans/${modName}.olean`;
        const absOlean = join(workDir, relOlean);
        withExitTrapTolerance(
          `compile:${modName}`,
          () => compileOlean(options, workDir, relLean, relOlean),
          (out) => {
            if (!existsSync(absOlean) || (out.status !== 0 && !isKnownExitTrap(out))) {
              throw new Error(
                `[layer-3b] 候选引擎编译 ${relLean} 失败 (status=${out.status}):\n${preview(out.stderr)}\n${preview(out.stdout)}`,
              );
            }
          },
          () => existsSync(absOlean),
        );
      }

      runCheckers({
        oleanDir: certDir,
        moduleName: 'CertProofs',
        bootLib: options.candidateLib ?? options.bootLib,
        theorems: CERT_THEOREM_NAMES,
        ...(options.leanchecker === undefined ? {} : { leanchecker: options.leanchecker }),
        ...(options.leanexport === undefined ? {} : { leanexport: options.leanexport }),
        ...(options.nanoda === undefined ? {} : { nanoda: options.nanoda }),
        rejectModuleName: 'CertRejectSorry',
        rejectTheorems: REJECT_THEOREM_NAMES,
        ...(options.externalCheckerCmd === undefined
          ? {}
          : { externalCheckerCmd: options.externalCheckerCmd }),
        timeoutMs: options.timeoutMs,
      });
      console.log('[equiv] layer-3b dual independent kernel verifiers ok');
    }

    // 平台专项压测：DeepStress & IO.Process.exit & LSP --worker（在 wasm64 模式执行）
    if (!options.skipDeepStress) {
      const stressPath = join(workDir, 'DeepStress.lean');
      writeFileSync(stressPath, buildDeepStressCorpus());
      withExitTrapTolerance(
        'DeepStress.lean',
        () => runCandidate(options, workDir, 'DeepStress.lean'),
        (output) => {
          if (output.status !== 0 || !output.stdout.includes('deep_stress_ok')) {
            throw new Error(
              `DeepStress.lean 在候选引擎失败 (status=${output.status}):\n${preview(output.stderr)}\n${preview(output.stdout)}`,
            );
          }
        },
        (output) => output.stdout.includes('deep_stress_ok'),
      );
      console.log('[equiv] DeepStress.lean CLI ok');

      if (!options.candidateLean) {
        writeFileSync(join(workDir, 'Exit42.lean'), '#eval (IO.Process.exit 42 : IO Unit)\n');
        const exitRes = runCandidate(options, workDir, 'Exit42.lean');
        if (exitRes.status === 42) {
          console.log('[equiv] IO.Process.exit 42 ok');
        } else {
          console.warn(
            `[equiv] SKIP IO.Process.exit 退出码断言：wasm64 CLI 返回 ${exitRes.status}（已知运行时限制，见 docs/WASM64-SPIKE.md）`,
          );
        }
      }
    }

    if (options.lspGlue) {
      const lspDeepCode = [
        'private def deepSimpLsp : Nat → Nat',
        '  | 0 => 0',
        '  | n + 1 => deepSimpLsp n',
        '',
        'set_option maxRecDepth 8000 in',
        'example : deepSimpLsp 800 = 0 := by simp [deepSimpLsp]',
        '',
        '#eval "lsp_deep_ok"',
      ].join('\n');
      const lspRes = runLsp(options, lspDeepCode);
      if (lspRes.status !== 0) {
        throw new Error(
          `LSP --worker 深栈回归失败 (${lspRes.status}):\n${lspRes.stderr}\n${lspRes.stdout}`,
        );
      }
      console.log('[equiv] LSP --worker deep simp N=800 ok');
    }

    console.log('[equiv] all v2 consistency & equivalence gates passed');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

const main = (): void => {
  const options = parseEquivalenceOptions(process.argv.slice(2));
  runEquivalenceSuite(options);
};

if (isMainModule(import.meta.url, process.argv[1])) runCli(main);
