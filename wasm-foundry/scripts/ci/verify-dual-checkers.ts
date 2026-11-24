// 第 3 层B 门禁：双独立数学检验器交叉审计（对齐官方 leanprover/comparator 标准）。
// 第一重：官方未改动的原版 C++ 内核重放（leanchecker --fresh + leanchecker --from-export）
// 第二重：异构纯 Rust 独立内核（leanexport NDJSON 导出 + ammkrn/nanoda_lib nanoda_bin）
// 同时支持可选的自定义 --external-checker <cmd> 扩展钩子。
//
// 用法:
//   node scripts/ci/verify-dual-checkers.ts \
//     --olean-dir <dir> --module CertProofs --boot-lib <lib/lean> \
//     [--leanchecker <bin/leanchecker>] [--leanexport <bin/leanexport>] \
//     [--nanoda <bin/nanoda_bin>] [--reject-module CertRejectSorry]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import {
  CliError,
  optionalString,
  parseArgs,
  requireNumber,
  requireString,
  runCli,
  type FlagSpec,
} from '../lib/cli.ts';
import { isMainModule } from '../lib/entry.ts';
import { requireDir, requireFile } from '../lib/fs-guards.ts';

export const CERT_THEOREM_NAMES = [
  'cert_simp_chain',
  'cert_whnf_proj',
  'cert_gmp_pow',
  'cert_univ_poly',
  'cert_quot_sound',
  'cert_classical_em',
] as const;

export const REJECT_THEOREM_NAMES = ['cert_bad_sorry'] as const;

export const DEFAULT_PERMITTED_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'] as const;

/** 仅依赖 Init 的双检验器证明语料（不含 sorry、不含 native_decide）。 */
export const buildCertificateProofCorpus = (): string =>
  [
    'import Init',
    '',
    'private def certLin : Nat → Nat',
    '  | 0 => 0',
    '  | n + 1 => certLin n',
    '',
    '-- 1. simpLoopStep 深链重写证明项',
    'theorem cert_simp_chain : certLin 200 = 0 := by simp [certLin]',
    '',
    '-- 2. whnfCore / let / structure proj 证明项（纯定义归约 rfl）',
    'private structure CertBox where',
    '  fst : Nat',
    '  snd : Nat',
    'private def mkCertBox (n : Nat) : CertBox := ⟨n + 1, n + 2⟩',
    'theorem cert_whnf_proj : (let b := mkCertBox 41; b.fst + b.snd) = 85 := rfl',
    '',
    '-- 3. GMP 大整数内核归约一致性',
    'theorem cert_gmp_pow : (2 : Nat) ^ 100 = 1267650600228229401496703205376 := rfl',
    '',
    '-- 4. 宇宙多态（instantiateLevelParams / replace_fn 敏感路径）',
    'theorem cert_univ_poly.{u} {α : Type u} (x : α) : id x = x := rfl',
    '',
    '-- 5. 商类型 Quot.sound 归约与公理',
    'private def qRel (a b : Nat) : Prop := a % 2 = b % 2',
    'private def qSetoid : Setoid Nat where',
    '  r := qRel',
    '  iseqv := ⟨fun _ => rfl, fun h => h.symm, fun h1 h2 => h1.trans h2⟩',
    'private def qMod2 : Quotient qSetoid → Nat :=',
    '  Quotient.lift (fun n => n % 2) (fun _ _ h => h)',
    'theorem cert_quot_sound : qMod2 (Quotient.mk qSetoid 2) = qMod2 (Quotient.mk qSetoid 4) := by',
    '  have h : qRel 2 4 := rfl',
    '  exact congrArg qMod2 (Quotient.sound h)',
    '',
    '-- 6. Classical.choice + propext',
    'theorem cert_classical_em (p : Prop) : p ∨ ¬p := Classical.em p',
    '',
  ].join('\n');

/** 反例 sanity check：含 sorryAx 的证明必须被独立检验器（nanoda_bin）拒绝。 */
export const buildTamperedAxiomCorpus = (): string =>
  ['import Init', '', 'theorem cert_bad_sorry : False := by', '  sorry', ''].join('\n');

export interface NanodaConfigOptions {
  readonly permittedAxioms?: readonly string[];
  readonly numThreads?: number;
  readonly stackSizeBytes?: number;
}

/** 构造 ammkrn/nanoda_lib nanoda_bin 所需的 JSON 配置文件。 */
export const buildNanodaConfig = (
  exportFilePath: string,
  options: NanodaConfigOptions = {},
): Record<string, unknown> => ({
  export_file_path: exportFilePath,
  use_stdin: false,
  num_threads: options.numThreads ?? 2,
  stack_size_bytes: options.stackSizeBytes ?? 67_108_864,
  permitted_axioms: [...(options.permittedAxioms ?? DEFAULT_PERMITTED_AXIOMS)],
  unpermitted_axiom_hard_error: false,
  nat_extension: true,
  string_extension: true,
  print_success_message: true,
});

export interface CommandOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DualCheckerOptions {
  readonly oleanDir: string;
  readonly moduleName: string;
  readonly bootLib: string;
  readonly theorems: readonly string[];
  readonly leanchecker?: string;
  readonly leanexport?: string;
  readonly nanoda?: string;
  readonly rejectModuleName?: string;
  readonly rejectTheorems?: readonly string[];
  readonly externalCheckerCmd?: string;
  readonly timeoutMs: number;
}

export interface DualCheckerReport {
  readonly moduleName: string;
  readonly leancheckerFreshPassed: boolean;
  readonly leancheckerFromExportPassed: boolean;
  readonly nanodaPassed: boolean;
  readonly negativeAxiomRejected: boolean;
  readonly externalCheckerPassed: boolean;
}

export type ExecCommandFn = (
  cmd: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
) => CommandOutput;

const defaultExecCommand: ExecCommandFn = (cmd, args, options) => {
  const res = spawnSync(cmd, [...args], {
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
};

const DUAL_SPEC: Record<string, FlagSpec> = {
  'olean-dir': { kind: 'string', required: true, valueName: 'dir' },
  module: { kind: 'string', required: true, valueName: 'ModuleName' },
  'boot-lib': { kind: 'string', required: true, valueName: 'lib/lean' },
  theorems: { kind: 'string', valueName: 't1,t2,...' },
  leanchecker: { kind: 'string', valueName: 'bin/leanchecker' },
  leanexport: { kind: 'string', valueName: 'bin/leanexport' },
  nanoda: { kind: 'string', valueName: 'bin/nanoda_bin' },
  'reject-module': { kind: 'string', valueName: 'ModuleName' },
  'reject-theorems': { kind: 'string', valueName: 't1,...' },
  'external-checker': { kind: 'string', valueName: 'cmd' },
  timeout: { kind: 'number', valueName: 'ms' },
};

export const parseDualCheckerOptions = (argv: readonly string[]): DualCheckerOptions => {
  const parsed = parseArgs(argv, DUAL_SPEC);
  const timeoutMs = parsed.flags.timeout === undefined ? 180_000 : requireNumber(parsed, 'timeout');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`--timeout 必须是正整数，收到 ${timeoutMs}`);
  }
  const leanchecker = optionalString(parsed, 'leanchecker');
  const leanexport = optionalString(parsed, 'leanexport');
  const nanoda = optionalString(parsed, 'nanoda');
  const rejectModuleName = optionalString(parsed, 'reject-module');
  const externalCheckerCmd = optionalString(parsed, 'external-checker');
  const theoremsRaw = optionalString(parsed, 'theorems');
  const rejectRaw = optionalString(parsed, 'reject-theorems');

  if (!leanchecker && !nanoda && !externalCheckerCmd) {
    throw new CliError('至少需要指定 --leanchecker、--nanoda 或 --external-checker 之一');
  }
  if (nanoda && !leanexport) {
    throw new CliError('启用 --nanoda 时必须同时提供 --leanexport 用于生成 NDJSON 导出文件');
  }

  return {
    oleanDir: requireDir(requireString(parsed, 'olean-dir'), 'olean-dir'),
    moduleName: requireString(parsed, 'module'),
    bootLib: requireDir(requireString(parsed, 'boot-lib'), 'boot-lib'),
    theorems: theoremsRaw
      ? theoremsRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : CERT_THEOREM_NAMES,
    ...(leanchecker === undefined ? {} : { leanchecker: requireFile(leanchecker, 'leanchecker') }),
    ...(leanexport === undefined ? {} : { leanexport: requireFile(leanexport, 'leanexport') }),
    ...(nanoda === undefined ? {} : { nanoda: requireFile(nanoda, 'nanoda') }),
    ...(rejectModuleName === undefined ? {} : { rejectModuleName }),
    ...(rejectRaw === undefined
      ? {}
      : {
          rejectTheorems: rejectRaw
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        }),
    ...(externalCheckerCmd === undefined ? {} : { externalCheckerCmd }),
    timeoutMs,
  };
};

const runChecked = (
  exec: ExecCommandFn,
  label: string,
  cmd: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
): CommandOutput => {
  const out = exec(cmd, args, options);
  if (out.status !== 0) {
    throw new Error(`[${label}] 校验失败 (status=${out.status}):\n${out.stderr}\n${out.stdout}`);
  }
  return out;
};

/** 执行双独立数学检验器交叉审计（C++ leanchecker + NDJSON leanexport + Rust nanoda_bin）。 */
export const runDualCheckerSuite = (
  options: DualCheckerOptions,
  exec: ExecCommandFn = defaultExecCommand,
): DualCheckerReport => {
  const workDir = mkdtempSync(join(tmpdir(), 'dual-checker-'));
  const toolPath = options.leanchecker ?? options.leanexport;
  const bootBinDir = toolPath ? dirname(toolPath) : undefined;
  const bootSysroot =
    bootBinDir && basename(bootBinDir) === 'bin' ? dirname(bootBinDir) : undefined;
  const leanPathEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LEAN_PATH: `${options.oleanDir}${delimiter}${options.bootLib}`,
    ...(bootSysroot === undefined ? {} : { LEAN_SYSROOT: bootSysroot }),
    ...(bootBinDir === undefined
      ? {}
      : { PATH: `${bootBinDir}${delimiter}${process.env.PATH ?? ''}` }),
  };

  let leancheckerFreshPassed = false;
  let leancheckerFromExportPassed = false;
  let nanodaPassed = false;
  let negativeAxiomRejected = false;
  let externalCheckerPassed = false;

  try {
    // 第一重 A：官方原版 C++ 内核重放（fresh environment）
    if (options.leanchecker) {
      runChecked(
        exec,
        'leanchecker --fresh',
        options.leanchecker,
        ['--fresh', options.moduleName],
        {
          env: leanPathEnv,
          timeoutMs: options.timeoutMs,
        },
      );
      leancheckerFreshPassed = true;
      console.log(`[checker-cpp] leanchecker --fresh ${options.moduleName} ok`);
    }

    // 导出标准 NDJSON 证明项（供 leanchecker --from-export 与纯 Rust nanoda_bin 共用）
    let ndjsonPath: string | undefined;
    if (options.leanexport) {
      const exportOut = runChecked(
        exec,
        'leanexport',
        options.leanexport,
        [options.moduleName, '--', ...options.theorems],
        { env: leanPathEnv, timeoutMs: options.timeoutMs },
      );
      if (!exportOut.stdout.trim()) {
        throw new Error(`[leanexport] 导出的 ${options.moduleName} NDJSON 为空`);
      }
      ndjsonPath = join(workDir, `${options.moduleName}.ndjson`);
      writeFileSync(ndjsonPath, exportOut.stdout, 'utf8');
      console.log(
        `[exporter] leanexport ${options.moduleName} ok (${Buffer.byteLength(exportOut.stdout)} bytes)`,
      );

      // 第一重 B：官方 C++ 内核检验纯文本导出（验证导出与重放闭环无歧义）
      if (options.leanchecker) {
        runChecked(
          exec,
          'leanchecker --from-export',
          options.leanchecker,
          ['--from-export', ndjsonPath],
          { env: leanPathEnv, timeoutMs: options.timeoutMs },
        );
        leancheckerFromExportPassed = true;
        console.log(`[checker-cpp] leanchecker --from-export ${options.moduleName} ok`);
      }
    }

    // 第二重：异构纯 Rust 独立 Lean 4 内核 nanoda_bin（零 C++/Lean 代码复用）
    if (options.nanoda && ndjsonPath) {
      const cfgPath = join(workDir, 'nanoda-config.json');
      writeFileSync(cfgPath, `${JSON.stringify(buildNanodaConfig(ndjsonPath), null, 2)}\n`, 'utf8');
      runChecked(exec, 'nanoda_bin', options.nanoda, [cfgPath], {
        timeoutMs: options.timeoutMs,
      });
      nanodaPassed = true;
      console.log(`[checker-rust] nanoda_bin verified ${options.moduleName} ok`);

      // 反例 sanity check：确保 nanoda_bin 真正拦截含 sorryAx 的非完整证明，而非空跑放行
      if (options.rejectModuleName && options.leanexport) {
        const rejTargets = options.rejectTheorems ?? REJECT_THEOREM_NAMES;
        const rejExport = runChecked(
          exec,
          'leanexport (reject case)',
          options.leanexport,
          [options.rejectModuleName, '--', ...rejTargets],
          { env: leanPathEnv, timeoutMs: options.timeoutMs },
        );
        const rejNdjson = join(workDir, `${options.rejectModuleName}.ndjson`);
        writeFileSync(rejNdjson, rejExport.stdout, 'utf8');
        const rejCfg = join(workDir, 'nanoda-reject-config.json');
        writeFileSync(rejCfg, `${JSON.stringify(buildNanodaConfig(rejNdjson), null, 2)}\n`, 'utf8');
        const rejResult = exec(options.nanoda, [rejCfg], { timeoutMs: options.timeoutMs });
        if (rejResult.status === 0) {
          throw new Error(
            `[checker-rust] sanity check 违背：nanoda_bin 竟然放行了含 sorryAx 的 ${options.rejectModuleName}`,
          );
        }
        negativeAxiomRejected = true;
        console.log(
          `[checker-rust] nanoda_bin rejected tampered ${options.rejectModuleName} (status=${rejResult.status}) ok`,
        );
      }
    }

    if (options.externalCheckerCmd) {
      const oleanCandidate = join(
        options.oleanDir,
        `${options.moduleName.replace(/\./g, '/')}.olean`,
      );
      const targetArg = ndjsonPath && !existsSync(oleanCandidate) ? ndjsonPath : oleanCandidate;
      runChecked(exec, 'external-checker', options.externalCheckerCmd, [targetArg], {
        env: leanPathEnv,
        timeoutMs: options.timeoutMs,
      });
      externalCheckerPassed = true;
      console.log(`[checker-ext] ${options.externalCheckerCmd} verified ${options.moduleName} ok`);
    }

    return {
      moduleName: options.moduleName,
      leancheckerFreshPassed,
      leancheckerFromExportPassed,
      nanodaPassed,
      negativeAxiomRejected,
      externalCheckerPassed,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

const main = (): void => {
  const options = parseDualCheckerOptions(process.argv.slice(2));
  runDualCheckerSuite(options);
};

if (isMainModule(import.meta.url, process.argv[1])) runCli(main);
