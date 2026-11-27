import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeChromeLspResult,
  parseNativeLeanOutput,
  selectCrossDiffCases,
} from '../lib/cross-diff-corpus.ts';
import {
  parseCrossDiffOptions,
  prepareDistFromPackedRuntime,
  prepareHelperModules,
  runCrossDiffSuite,
  runNativeCase,
} from './cross-platform-diff.ts';

const temps: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cross-diff-test-'));
  temps.push(dir);
  return dir;
};

describe('cross-platform-diff CLI 与准备工作', () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('parseCrossDiffOptions 校验参数默认值与非法输入', () => {
    const dir = makeTempDir();
    const leanBin = join(dir, 'lean');
    const bootLib = join(dir, 'lib');
    const distDir = join(dir, 'dist');
    const packedDir = join(dir, 'packed');
    writeFileSync(leanBin, '');
    mkdirSync(bootLib);
    mkdirSync(distDir);
    mkdirSync(packedDir);

    const parsed = parseCrossDiffOptions([
      '--boot-lean',
      leanBin,
      '--boot-lib',
      bootLib,
      '--dist-dir',
      distDir,
      '--cases',
      'init_gmp_pow2_100,init_platform_64bit',
    ]);
    expect(parsed.suite).toBe('init');
    expect(parsed.gluePath).toBe('/lean-adapted-proxy.mjs');
    expect(parsed.caseIds).toEqual(['init_gmp_pow2_100', 'init_platform_64bit']);

    const packedOpts = parseCrossDiffOptions([
      '--boot-lean',
      leanBin,
      '--boot-lib',
      bootLib,
      '--packed-runtime',
      packedDir,
      '--suite',
      'all',
      '--timeout',
      '60000',
    ]);
    expect(packedOpts.suite).toBe('all');
    expect(packedOpts.gluePath).toBe('/lean-lsp-adapted.mjs');

    expect(() => parseCrossDiffOptions(['--boot-lean', leanBin, '--boot-lib', bootLib])).toThrow(
      /必须提供/,
    );
    expect(() =>
      parseCrossDiffOptions([
        '--boot-lean',
        leanBin,
        '--boot-lib',
        bootLib,
        '--dist-dir',
        distDir,
        '--suite',
        'bad',
      ]),
    ).toThrow(/--suite/);
  });

  it('prepareHelperModules 与 runNativeCase 正确调用原生 lean 与解析结果', () => {
    const dir = makeTempDir();
    const execMock = vi.fn(() => ({
      status: 0,
      stdout: '/tmp/Cd.lean:3:0: info: 42\n',
      stderr: '',
      elapsedMs: 12,
    }));
    const cases = selectCrossDiffCases('init', ['multifile_import_helper']);
    const helperLib = prepareHelperModules(cases, '/bin/lean', '/boot/lib', dir, execMock);
    expect(helperLib).toBe(join(dir, 'helper-lib'));
    expect(execMock).toHaveBeenCalledTimes(1);

    const nativeRes = runNativeCase(
      cases[0]!,
      '/bin/lean',
      '/boot/lib',
      helperLib,
      dir,
      5000,
      execMock,
    );
    expect(nativeRes.exitCode).toBe(0);
    expect(nativeRes.stdout).toContain('42');

    // 无辅助模块时返回 undefined。
    expect(
      prepareHelperModules(
        selectCrossDiffCases('init', ['init_platform_64bit']),
        '/bin/lean',
        '/boot/lib',
        dir,
        execMock,
      ),
    ).toBeUndefined();
  });

  it('prepareDistFromPackedRuntime 解包分片并生成 olean-manifest.json 与 wasm', () => {
    const dir = makeTempDir();
    const packed = join(dir, 'packed');
    const harness = join(dir, 'harness');
    const out = join(dir, 'out');
    mkdirSync(packed);
    mkdirSync(harness);

    const oleanBytes = Buffer.from([1, 2, 3, 4]);
    const packedChunk = zstdCompressSync(oleanBytes);
    writeFileSync(join(packed, 'lean-init-64-00.pack.zst.bin'), packedChunk);
    writeFileSync(
      join(packed, 'lean-init-64.index.json'),
      JSON.stringify({
        chunks: [
          { path: 'lean-init-64-00.pack.zst', offset: 0, uncompressedBytes: oleanBytes.byteLength },
        ],
        files: [{ path: 'Init/Demo.olean', offset: 0, bytes: oleanBytes.byteLength }],
      }),
    );
    writeFileSync(
      join(packed, 'lean-lsp.wasm.zst'),
      zstdCompressSync(Buffer.from([0x00, 0x61, 0x73, 0x6d])),
    );
    writeFileSync(join(packed, 'lean-lsp-adapted.mjs'), 'export default () => ({});');
    writeFileSync(join(harness, 'harness.mjs'), '// harness');
    writeFileSync(join(harness, 'lsp-worker.mjs'), '// worker');

    const stage = prepareDistFromPackedRuntime(packed, out, harness);
    expect(readFileSync(join(stage.libDir, 'Init/Demo.olean'))).toEqual(oleanBytes);
    expect(JSON.parse(readFileSync(join(stage.distDir, 'olean-manifest.json'), 'utf8'))).toEqual([
      'Init/Demo.olean',
    ]);
    expect([...readFileSync(join(stage.distDir, 'lean-lsp.wasm'))]).toEqual([
      0x00, 0x61, 0x73, 0x6d,
    ]);
    expect(readFileSync(join(stage.distDir, 'harness.mjs'), 'utf8')).toBe('// harness');
  });

  it('runCrossDiffSuite 汇总双端比对并写出 summary 与 JSON report，捕捉分歧失败', async () => {
    const dir = makeTempDir();
    const leanBin = join(dir, 'lean');
    const bootLib = join(dir, 'lib');
    const distDir = join(dir, 'dist');
    const summaryPath = join(dir, 'summary.md');
    const reportPath = join(dir, 'report.json');
    writeFileSync(leanBin, '');
    mkdirSync(bootLib);
    mkdirSync(distDir);

    const passReport = await runCrossDiffSuite(
      {
        bootLean: leanBin,
        bootLib,
        distDir,
        gluePath: '/lean-adapted-proxy.mjs',
        manifestPath: '/olean-manifest.json',
        suite: 'init',
        caseIds: ['init_platform_64bit', 'err_type_mismatch'],
        summaryPath,
        reportPath,
        timeoutMs: 10_000,
      },
      {
        prepareHelpers: () => undefined,
        runNative: (item) =>
          item.id === 'init_platform_64bit'
            ? parseNativeLeanOutput('/tmp/Cd.lean:3:0: info: 64\n', '', 0, 10)
            : parseNativeLeanOutput('/tmp/Cd.lean:3:0: error: type mismatch\n', '', 1, 12),
        runChrome: async () =>
          new Map([
            [
              'init_platform_64bit',
              normalizeChromeLspResult([{ severity: 3, message: '64' }], 50, 512 * 1024 * 1024),
            ],
            [
              'err_type_mismatch',
              normalizeChromeLspResult([{ severity: 1, message: 'type mismatch' }], 40),
            ],
          ]),
      },
    );

    expect(passReport.total).toBe(2);
    expect(passReport.passed).toBe(2);
    expect(passReport.failed).toBe(0);
    expect(readFileSync(summaryPath, 'utf8')).toContain('PASS');
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).passed).toBe(2);

    // Chrome 漏掉某条用例时，判定失败而不是静默放行。
    const failReport = await runCrossDiffSuite(
      {
        bootLean: leanBin,
        bootLib,
        distDir,
        gluePath: '/lean-adapted-proxy.mjs',
        manifestPath: '/olean-manifest.json',
        suite: 'init',
        caseIds: ['init_platform_64bit'],
        timeoutMs: 10_000,
      },
      {
        prepareHelpers: () => undefined,
        runNative: () => parseNativeLeanOutput('/tmp/Cd.lean:3:0: info: 64\n', '', 0, 10),
        runChrome: async () => new Map(),
      },
    );
    expect(failReport.failed).toBe(1);
    expect(failReport.cases[0]?.mismatches[0]).toContain('Chrome 未返回');
  });
});
