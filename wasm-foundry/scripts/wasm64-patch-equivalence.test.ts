import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CERT_THEOREM_NAMES, type DualCheckerOptions } from './ci/verify-dual-checkers.ts';
import { CliError } from './lib/cli.ts';
import {
  CURATED_UPSTREAM_FAIL_TESTS,
  CURATED_UPSTREAM_TESTS,
  NEGATIVE_CORPUS_CASES,
  assertNegativeMatch,
  assertOutputsMatch,
  buildDeepStressCorpus,
  buildDifferentialCorpus,
  compareWithExitTrapTolerance,
  isKnownExitTrap,
  normalizeStdout,
  parseEquivalenceOptions,
  runEquivalenceSuite,
  type EquivalenceOptions,
  type RunOutput,
} from './wasm64-patch-equivalence.ts';

/** 触发已知退出期 trap 的真实 stderr 形状（run 44519972634）。 */
const EXIT_TRAP_STDERR =
  'RuntimeError: memory access out of bounds\n' +
  '    at lean.wasm.emscripten_builtin_free (wasm://wasm/lean.wasm-20d5c736:wasm-function[155]:0xb5cf7)\n' +
  '    at lean.wasm.lean_dec_ref_cold (wasm://wasm/lean.wasm-20d5c736:wasm-function[60]:0xa1acd)\n';

const createTempFixtureRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-equiv-v2-'));
  const bootLean = join(root, 'lean');
  const wasmLean = join(root, 'lean.mjs');
  const runLean = join(root, 'run-lean.mjs');
  const lspGlue = join(root, 'lean-adapted-proxy.mjs');
  const bootLib = join(root, 'lib');
  const lean4Src = join(root, 'lean4');
  writeFileSync(bootLean, '');
  writeFileSync(wasmLean, '');
  writeFileSync(runLean, '');
  writeFileSync(lspGlue, '');
  mkdirSync(bootLib);
  for (const rel of [...CURATED_UPSTREAM_TESTS, ...CURATED_UPSTREAM_FAIL_TESTS]) {
    const abs = join(lean4Src, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `-- ${rel}\n`);
  }
  return { root, bootLean, wasmLean, runLean, lspGlue, bootLib, lean4Src };
};

describe('wasm64-patch-equivalence (v2)', () => {
  it('normalizeStdout 统一宿主路径、/src 与换行符', () => {
    const raw = '/tmp/work-dir/Foo.lean:10:2: ok\r\n/src/Bar.lean:3:0: done  \r\n';
    expect(normalizeStdout(raw, '/tmp/work-dir')).toBe(
      '<src>/Foo.lean:10:2: ok\n<src>/Bar.lean:3:0: done',
    );
  });

  it('assertOutputsMatch 在退出码或输出不同步时显式失败', () => {
    expect(() =>
      assertOutputsMatch(
        'case',
        { status: 0, stdout: '/src/A.lean:1:0: ok\n', stderr: '' },
        { status: 0, stdout: '/tmp/host/A.lean:1:0: ok\r\n', stderr: '' },
        '/tmp/host',
      ),
    ).not.toThrow();

    expect(() =>
      assertOutputsMatch(
        'case',
        { status: 0, stdout: 'a', stderr: '' },
        { status: 1, stdout: 'a', stderr: 'trap' },
        '/tmp/host',
      ),
    ).toThrow(/退出码不一致/);

    expect(() =>
      assertOutputsMatch(
        'case',
        { status: 0, stdout: 'alpha', stderr: '' },
        { status: 0, stdout: 'beta', stderr: '' },
        '/tmp/host',
      ),
    ).toThrow(/输出行为与原版 Lean 不一致/);
  });

  it('assertNegativeMatch 拦截候选端错误放行（status=0）或错误文本不一致', () => {
    expect(() =>
      assertNegativeMatch(
        'neg',
        { status: 1, stdout: '/tmp/host/N.lean:1:0: error: type mismatch', stderr: '' },
        { status: 1, stdout: '/src/N.lean:1:0: error: type mismatch\n', stderr: '' },
        '/tmp/host',
      ),
    ).not.toThrow();

    expect(() =>
      assertNegativeMatch(
        'neg',
        { status: 1, stdout: 'error: bad', stderr: '' },
        { status: 0, stdout: '', stderr: '' },
        '/tmp/host',
      ),
    ).toThrow(/安全红线违背/);

    expect(() =>
      assertNegativeMatch(
        'neg',
        { status: 0, stdout: '', stderr: '' },
        { status: 1, stdout: '', stderr: '' },
        '/tmp/host',
      ),
    ).toThrow(/反例自身在原版 boot lean 返回 0/);
  });

  it('isKnownExitTrap 只认退出期堆损坏的签名', () => {
    expect(isKnownExitTrap({ status: 0, stdout: '', stderr: EXIT_TRAP_STDERR })).toBe(false);
    expect(isKnownExitTrap({ status: 99, stdout: '', stderr: EXIT_TRAP_STDERR })).toBe(true);
    expect(
      isKnownExitTrap({ status: 1, stdout: '', stderr: 'Maximum call stack size exceeded' }),
    ).toBe(false);
  });

  it('compareWithExitTrapTolerance 对 stdout 一致的偶发 trap 重跑一次并在复现时告警放行', () => {
    const expected: RunOutput = { status: 0, stdout: 'a\nb\n', stderr: '' };
    const replies: RunOutput[] = [
      { status: 99, stdout: 'a\nb\n', stderr: EXIT_TRAP_STDERR },
      { status: 0, stdout: 'a\nb\n', stderr: '' },
    ];
    let calls = 0;
    const retried = compareWithExitTrapTolerance(
      'retry',
      expected,
      () => replies[calls++] as RunOutput,
      '/tmp/host',
    );
    expect(calls).toBe(2);
    expect(retried.status).toBe(0);

    let warnCalls = 0;
    const warned = compareWithExitTrapTolerance(
      'warn',
      expected,
      () => {
        warnCalls += 1;
        return { status: 99, stdout: 'a\nb\n', stderr: EXIT_TRAP_STDERR };
      },
      '/tmp/host',
    );
    expect(warnCalls).toBe(2);
    expect(warned.status).toBe(99);
  });

  it('compareWithExitTrapTolerance 不放过 stdout 截断或爆栈失败', () => {
    const expected: RunOutput = { status: 0, stdout: 'a\nb\n', stderr: '' };
    let calls = 0;
    expect(() =>
      compareWithExitTrapTolerance(
        'truncated',
        expected,
        () => {
          calls += 1;
          return { status: 99, stdout: 'a\n', stderr: EXIT_TRAP_STDERR };
        },
        '/tmp/host',
      ),
    ).toThrow(/校验未通过/);
    expect(calls).toBe(1);

    calls = 0;
    expect(() =>
      compareWithExitTrapTolerance(
        'stack',
        expected,
        () => {
          calls += 1;
          return { status: 1, stdout: 'a\nb\n', stderr: 'Maximum call stack size exceeded' };
        },
        '/tmp/host',
      ),
    ).toThrow(/退出码不一致/);
    expect(calls).toBe(1);
  });

  it('语料覆盖正向/负向/Fuzzing/深栈压测全部关键元素', () => {
    const diff = buildDifferentialCorpus();
    expect(diff).toContain('e.replace');
    expect(diff).toContain('withTrackingZetaDelta');
    expect(NEGATIVE_CORPUS_CASES).toHaveLength(6);
    expect(NEGATIVE_CORPUS_CASES.map((c) => c.name)).toContain('neg_kernel_adddecl_illtyped.lean');

    const stress = buildDeepStressCorpus();
    expect(stress).toContain('mkDeepApp 2000');
    expect(CURATED_UPSTREAM_TESTS).toContain('tests/elab/6123_mod_cast.lean');
    expect(CURATED_UPSTREAM_FAIL_TESTS).toContain('tests/elab_fail/1062.lean');
  });

  it('parseEquivalenceOptions 同时支持 wasm64 模式与 native --candidate-lean 模式', () => {
    const fix = createTempFixtureRepo();
    const nativeLean = join(fix.root, 'native-lean');
    writeFileSync(nativeLean, '');

    const wasmOpts = parseEquivalenceOptions([
      '--boot-lean',
      fix.bootLean,
      '--boot-lib',
      fix.bootLib,
      '--wasm-lean',
      fix.wasmLean,
      '--lean4-src',
      fix.lean4Src,
      '--run-lean',
      fix.runLean,
    ]);
    expect(wasmOpts.fuzzCases).toBe(48);
    expect(wasmOpts.timeoutMs).toBe(180_000);

    const nativeOpts = parseEquivalenceOptions([
      '--boot-lean',
      fix.bootLean,
      '--boot-lib',
      fix.bootLib,
      '--candidate-lean',
      nativeLean,
      '--lean4-src',
      fix.lean4Src,
      '--skip-deep-stress',
    ]);
    expect(nativeOpts.fuzzCases).toBe(300);
    expect(nativeOpts.skipDeepStress).toBe(true);

    expect(() =>
      parseEquivalenceOptions([
        '--boot-lean',
        fix.bootLean,
        '--boot-lib',
        fix.bootLib,
        '--lean4-src',
        fix.lean4Src,
      ]),
    ).toThrow(CliError);

    expect(() =>
      parseEquivalenceOptions([
        '--boot-lean',
        fix.bootLean,
        '--boot-lib',
        fix.bootLib,
        '--wasm-lean',
        fix.wasmLean,
        '--lean4-src',
        fix.lean4Src,
      ]),
    ).toThrow(/必须同时提供/);

    expect(() =>
      parseEquivalenceOptions([
        '--boot-lean',
        fix.bootLean,
        '--boot-lib',
        fix.bootLib,
        '--candidate-lean',
        nativeLean,
        '--lean4-src',
        fix.lean4Src,
        '--fuzz-cases',
        '0',
      ]),
    ).toThrow(CliError);
  });

  it('runEquivalenceSuite 串联 5 层防线、双检验器与 Exit42/DeepStress 容忍', () => {
    const fix = createTempFixtureRepo();
    const leanchecker = join(fix.root, 'leanchecker');
    const leanexport = join(fix.root, 'leanexport');
    const nanoda = join(fix.root, 'nanoda_bin');
    writeFileSync(leanchecker, '');
    writeFileSync(leanexport, '');
    writeFileSync(nanoda, '');

    const options: EquivalenceOptions = {
      bootLean: fix.bootLean,
      bootLib: fix.bootLib,
      wasmLean: fix.wasmLean,
      runLean: fix.runLean,
      lspGlue: fix.lspGlue,
      lean4Src: fix.lean4Src,
      lspScript: __filename,
      fuzzSeed: 20260436,
      fuzzCases: 12,
      leanchecker,
      leanexport,
      nanoda,
      skipDeepStress: false,
      timeoutMs: 30_000,
    };

    const recordedDualOpts: DualCheckerOptions[] = [];
    const seenWasmFiles: string[] = [];

    runEquivalenceSuite(options, {
      runBoot: (_opts, workDir, filePath) => {
        if (filePath.includes('DivergenceSimpRecDepth.lean')) {
          return {
            status: 1,
            stdout: `${workDir}/DivergenceSimpRecDepth.lean:9:2: error: maximum recursion depth has been reached\n`,
            stderr: '',
          };
        }
        if (filePath.includes('neg_') || filePath.includes('tests_elab_fail_')) {
          return { status: 1, stdout: '<src>/err:1:0: error: rejected\n', stderr: '' };
        }
        return {
          status: 0,
          stdout: `${workDir.replace(/\\/g, '/')}/${filePath.split(/[\\/]/).pop()}: ok\n`,
          stderr: '',
        };
      },
      runCandidate: (_opts, _workDir, relFile) => {
        seenWasmFiles.push(relFile);
        if (relFile === 'Exit42.lean') return { status: 1, stdout: '', stderr: 'DataCloneError' };
        if (relFile === 'DivergenceSimpRecDepth.lean') {
          return { status: 0, stdout: 'div_001_boundary_ok\n', stderr: '' };
        }
        if (relFile.startsWith('neg_') || relFile.startsWith('tests_elab_fail_')) {
          return { status: 1, stdout: '<src>/err:1:0: error: rejected\n', stderr: '' };
        }
        if (relFile === 'DeepStress.lean') {
          return { status: 0, stdout: 'deep_replace_ok\ndeep_stress_ok\n', stderr: '' };
        }
        return { status: 99, stdout: `/src/${relFile}: ok\n`, stderr: EXIT_TRAP_STDERR };
      },
      compileOlean: (_opts, workDir, _relFile, outOleanRel) => {
        const abs = join(workDir, outOleanRel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, 'FAKE_OLEAN');
        return { status: 99, stdout: '', stderr: EXIT_TRAP_STDERR };
      },
      runDualCheckers: (dOpts) => {
        recordedDualOpts.push(dOpts);
        return {
          moduleName: dOpts.moduleName,
          leancheckerFreshPassed: true,
          leancheckerFromExportPassed: true,
          nanodaPassed: true,
          negativeAxiomRejected: true,
          externalCheckerPassed: false,
        };
      },
      runLsp: () => ({ status: 0, stdout: 'lsp_deep_ok\n', stderr: '' }),
    });

    expect(seenWasmFiles).toContain('PatchEquiv.lean');
    expect(seenWasmFiles).toContain('FuzzEquiv.lean');
    expect(seenWasmFiles).toContain('neg_kernel_adddecl_illtyped.lean');
    expect(seenWasmFiles).toContain('tests_elab_fail_1062.lean');
    expect(seenWasmFiles).toContain('DivergenceSimpRecDepth.lean');
    expect(seenWasmFiles).toContain('DeepStress.lean');
    expect(recordedDualOpts).toHaveLength(1);
    expect(recordedDualOpts[0]?.moduleName).toBe('CertProofs');
    expect(recordedDualOpts[0]?.theorems).toEqual(CERT_THEOREM_NAMES);
    expect(recordedDualOpts[0]?.rejectModuleName).toBe('CertRejectSorry');

    // 反向用例错误放行必须阻断
    expect(() =>
      runEquivalenceSuite(options, {
        runBoot: (_opts, _workDir, filePath) => {
          if (filePath.includes('neg_') || filePath.includes('tests_elab_fail_')) {
            return { status: 1, stdout: 'error: bad\n', stderr: '' };
          }
          return { status: 0, stdout: 'ok\n', stderr: '' };
        },
        runCandidate: (_opts, _workDir, relFile) => {
          if (relFile === 'neg_type_mismatch.lean') return { status: 0, stdout: '', stderr: '' };
          if (relFile.startsWith('neg_') || relFile.startsWith('tests_elab_fail_')) {
            return { status: 1, stdout: 'error: bad\n', stderr: '' };
          }
          return { status: 0, stdout: 'ok\n', stderr: '' };
        },
      }),
    ).toThrow(/安全红线违背/);

    // DIV-001 在候选端失败也必须阻断
    expect(() =>
      runEquivalenceSuite(options, {
        runBoot: (_opts, _workDir, filePath) => {
          if (filePath.includes('DivergenceSimpRecDepth')) {
            return {
              status: 1,
              stdout: 'error: maximum recursion depth has been reached',
              stderr: '',
            };
          }
          if (filePath.includes('neg_') || filePath.includes('tests_elab_fail_')) {
            return { status: 1, stdout: 'error: bad\n', stderr: '' };
          }
          return { status: 0, stdout: 'ok\n', stderr: '' };
        },
        runCandidate: (_opts, _workDir, relFile) => {
          if (relFile === 'DivergenceSimpRecDepth.lean')
            return { status: 1, stdout: 'failed', stderr: '' };
          if (relFile.startsWith('neg_') || relFile.startsWith('tests_elab_fail_')) {
            return { status: 1, stdout: 'error: bad\n', stderr: '' };
          }
          return { status: 0, stdout: 'ok\n', stderr: '' };
        },
      }),
    ).toThrow(/DIV-001/);
  });
});
