import { describe, expect, it } from 'vitest';
import {
  CROSS_DIFF_CORPUS,
  classifyDiagnostic,
  compareCrossPlatformResults,
  normalizeChromeLspResult,
  parseNativeLeanOutput,
  renderDiffSummaryMarkdown,
  selectCrossDiffCases,
} from './cross-diff-corpus.ts';

describe('CROSS_DIFF_CORPUS 不变量与筛选', () => {
  it('包含 25 组样本且覆盖 6 大类，id 与 fileName 全局唯一', () => {
    expect(CROSS_DIFF_CORPUS.length).toBe(25);
    const ids = new Set(CROSS_DIFF_CORPUS.map((c) => c.id));
    const files = new Set(CROSS_DIFF_CORPUS.map((c) => c.fileName));
    expect(ids.size).toBe(25);
    expect(files.size).toBe(25);

    const categories = new Set(CROSS_DIFF_CORPUS.map((c) => c.category));
    expect(categories).toEqual(
      new Set([
        'core-proof',
        'recursion-stack',
        'memory-alloc',
        'multi-file',
        'error-diagnostic',
        'mathlib-tactic',
      ]),
    );
  });

  it('selectCrossDiffCases 支持 init / all 与按 id 过滤并在缺失时报错', () => {
    expect(selectCrossDiffCases('init')).toHaveLength(22);
    expect(selectCrossDiffCases('all')).toHaveLength(25);
    expect(selectCrossDiffCases('init', ['init_gmp_pow2_100']).map((c) => c.id)).toEqual([
      'init_gmp_pow2_100',
    ]);
    expect(() => selectCrossDiffCases('init', ['does_not_exist'])).toThrow(/未找到/);
  });
});

describe('classifyDiagnostic 与输出归一化', () => {
  it('按关键错误文案归类五大错误类别及非错误级别', () => {
    expect(classifyDiagnostic('info', 'hello')).toBe('info');
    expect(classifyDiagnostic('warning', 'unused')).toBe('warning');
    expect(classifyDiagnostic('error', 'maximum recursion depth has been reached')).toBe(
      'recursion-depth',
    );
    expect(classifyDiagnostic('error', 'unknown module prefix NonExistent')).toBe('unknown-module');
    expect(classifyDiagnostic('error', 'unknown identifier `foo`')).toBe('unknown-identifier');
    expect(classifyDiagnostic('error', 'unsolved goals\n⊢ False')).toBe('unsolved-goals');
    expect(classifyDiagnostic('error', 'type mismatch\n  "abc"\nhas type\n  String')).toBe(
      'type-mismatch',
    );
    expect(classifyDiagnostic('error', 'internal panic xyz')).toBe('other-error');
  });

  it('parseNativeLeanOutput 正确合并多行诊断并提取 info/stdout', () => {
    const out = [
      '42',
      '/tmp/Foo.lean:3:0: info: magic_ok',
      '/tmp/Foo.lean:5:2: error: type mismatch',
      '  "abc"',
    ].join('\n');
    const parsed = parseNativeLeanOutput(out, '', 1, 120);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stdout).toContain('42');
    expect(parsed.stdout).toContain('magic_ok');
    expect(parsed.diagnostics).toHaveLength(2);
    expect(parsed.diagnostics[1]?.category).toBe('type-mismatch');
    expect(parsed.diagnostics[1]?.message).toContain('"abc"');
  });

  it('normalizeChromeLspResult 映射 severity、1-based 行号与 workerError', () => {
    const okRes = normalizeChromeLspResult(
      [{ severity: 3, message: '64', range: { start: { line: 2 } } }],
      80,
      512 * 1024 * 1024,
    );
    expect(okRes.exitCode).toBe(0);
    expect(okRes.stdout).toBe('64');
    expect(okRes.diagnostics[0]?.line).toBe(3);

    const errRes = normalizeChromeLspResult([{ severity: 1, message: 'unsolved goals' }], 50);
    expect(errRes.exitCode).toBe(1);
    expect(errRes.diagnostics[0]?.category).toBe('unsolved-goals');

    const crashRes = normalizeChromeLspResult([], 10, undefined, 'worker crash');
    expect(crashRes.exitCode).toBe(1);
    expect(crashRes.workerError).toBe('worker crash');
  });
});

describe('compareCrossPlatformResults 与报告渲染', () => {
  const passCase = selectCrossDiffCases('init', ['init_platform_64bit'])[0]!;
  const errCase = selectCrossDiffCases('init', ['err_type_mismatch'])[0]!;

  it('一致样本判定为 ok 并输出 Markdown 汇总表', () => {
    const native = parseNativeLeanOutput('/tmp/Cd.lean:3:0: info: 64\n', '', 0, 20);
    const chrome = normalizeChromeLspResult([{ severity: 3, message: '64' }], 95, 1024 ** 3);
    const cmp = compareCrossPlatformResults(passCase, native, chrome);
    expect(cmp.ok).toBe(true);
    expect(cmp.mismatches).toEqual([]);

    const md = renderDiffSummaryMarkdown({
      suite: 'init',
      total: 1,
      passed: 1,
      failed: 0,
      cases: [cmp],
    });
    expect(md).toContain('init_platform_64bit');
    expect(md).toContain('1024 MiB');
    expect(md).toContain('PASS');
  });

  it('捕获放行不一致、错误类别不一致、worker 崩溃与输出缺失', () => {
    const nativeReject = parseNativeLeanOutput(
      '/tmp/E.lean:3:0: error: unknown identifier foo',
      '',
      1,
      15,
    );
    const chromeAccept = normalizeChromeLspResult([], 25);
    const mismatch = compareCrossPlatformResults(errCase, nativeReject, chromeAccept);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.mismatches.some((m) => m.includes('双端放行/拒绝不一致'))).toBe(true);
    expect(mismatch.mismatches.some((m) => m.includes('原生错误类别未包含'))).toBe(true);
    expect(mismatch.mismatches.some((m) => m.includes('Chrome 错误类别未包含'))).toBe(true);

    const crashed = compareCrossPlatformResults(
      passCase,
      { exitCode: 0, diagnostics: [], stdout: '64', elapsedMs: 10 },
      normalizeChromeLspResult([], 10, undefined, 'boom'),
    );
    expect(crashed.ok).toBe(false);
    expect(crashed.mismatches.some((m) => m.includes('Chrome worker 异常'))).toBe(true);
    expect(crashed.mismatches.some((m) => m.includes('Chrome LSP info 缺少关键片段'))).toBe(true);
  });
});
