/**
 * 官方原生 `lean` vs Chrome `wasm64` 跨端差分一致性门禁（Issue #83 第二项）：
 *
 * 支持两种启动形态：
 * 1. 基于 `smoke`/`deep` 现场构建目录（`--dist-dir work/dist --boot-lib work/olean32`）；
 * 2. 基于缓存的 `wasm64-runtime-release` 产物目录（`--packed-runtime ...`，无需重新编译 Lean）。
 *
 * 用法：
 *   node scripts/ci/cross-platform-diff.ts \
 *     --boot-lean <bin/lean> --boot-lib <dir> \
 *     [--dist-dir <dir> | --packed-runtime <dir>] \
 *     [--suite init|all] [--cases id1,id2] [--summary <file>] [--report <file>]
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import {
  CliError,
  optionalString,
  parseArgs,
  requireNumber,
  requireString,
  runCli,
  type FlagSpec,
} from '../lib/cli.ts';
import {
  compareCrossPlatformResults,
  normalizeChromeLspResult,
  parseNativeLeanOutput,
  renderDiffSummaryMarkdown,
  selectCrossDiffCases,
  type CaseComparison,
  type CrossDiffCase,
  type CrossDiffReport,
  type CrossSideResult,
  type RawChromeDiagnostic,
} from '../lib/cross-diff-corpus.ts';
import { isMainModule } from '../lib/entry.ts';
import { requireDir, requireFile } from '../lib/fs-guards.ts';
import { collectOleanManifest } from './gen-olean-manifest.ts';
import { unpackPackedLib } from './unpack-packed-lib.ts';

export interface CrossDiffOptions {
  readonly bootLean: string;
  readonly bootLib: string;
  readonly distDir?: string;
  readonly packedRuntime?: string;
  readonly harnessDir?: string;
  readonly gluePath: string;
  readonly manifestPath: string;
  readonly suite: 'init' | 'all';
  readonly caseIds?: readonly string[];
  readonly summaryPath?: string;
  readonly reportPath?: string;
  readonly timeoutMs: number;
}

const SPEC: Record<string, FlagSpec> = {
  'boot-lean': { kind: 'string', required: true, valueName: 'bin/lean' },
  'boot-lib': { kind: 'string', required: true, valueName: 'lib/lean' },
  'dist-dir': { kind: 'string', valueName: 'work/dist' },
  'packed-runtime': { kind: 'string', valueName: 'runtimeDir' },
  'harness-dir': { kind: 'string', valueName: 'dirWithHarnessMjs' },
  glue: { kind: 'string', valueName: '/lean-adapted-proxy.mjs' },
  manifest: { kind: 'string', valueName: '/olean-manifest.json' },
  suite: { kind: 'string', valueName: 'init|all' },
  cases: { kind: 'string', valueName: 'id1,id2' },
  summary: { kind: 'string', valueName: 'file' },
  report: { kind: 'string', valueName: 'report.json' },
  timeout: { kind: 'number', valueName: 'ms' },
};

export const parseCrossDiffOptions = (argv: readonly string[]): CrossDiffOptions => {
  const parsed = parseArgs(argv, SPEC);
  const distDir = optionalString(parsed, 'dist-dir');
  const packedRuntime = optionalString(parsed, 'packed-runtime');
  if (distDir === undefined && packedRuntime === undefined) {
    throw new CliError('必须提供 --dist-dir 或 --packed-runtime 之一');
  }
  const suiteRaw = optionalString(parsed, 'suite') ?? 'init';
  if (suiteRaw !== 'init' && suiteRaw !== 'all') {
    throw new CliError(`--suite 只能是 init 或 all，收到 ${suiteRaw}`);
  }
  const timeoutMs = parsed.flags.timeout === undefined ? 180_000 : requireNumber(parsed, 'timeout');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`--timeout 必须是正整数，收到 ${timeoutMs}`);
  }
  const casesRaw = optionalString(parsed, 'cases');
  const caseIds = casesRaw
    ? casesRaw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
  const gluePath =
    optionalString(parsed, 'glue') ??
    (packedRuntime ? '/lean-lsp-adapted.mjs' : '/lean-adapted-proxy.mjs');
  const manifestPath = optionalString(parsed, 'manifest') ?? '/olean-manifest.json';
  const harnessDir = optionalString(parsed, 'harness-dir');
  const summaryPath = optionalString(parsed, 'summary');
  const reportPath = optionalString(parsed, 'report');

  return {
    bootLean: requireFile(requireString(parsed, 'boot-lean'), 'boot-lean'),
    bootLib: requireDir(requireString(parsed, 'boot-lib'), 'boot-lib'),
    ...(distDir === undefined ? {} : { distDir: requireDir(distDir, 'dist-dir') }),
    ...(packedRuntime === undefined
      ? {}
      : { packedRuntime: requireDir(packedRuntime, 'packed-runtime') }),
    ...(harnessDir === undefined ? {} : { harnessDir: requireDir(harnessDir, 'harness-dir') }),
    gluePath,
    manifestPath,
    suite: suiteRaw,
    ...(caseIds === undefined ? {} : { caseIds }),
    ...(summaryPath === undefined ? {} : { summaryPath }),
    ...(reportPath === undefined ? {} : { reportPath }),
    timeoutMs,
  };
};

export type LeanExecFn = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
};

const defaultLeanExec: LeanExecFn = (bin, args, env, timeoutMs) => {
  const started = Date.now();
  const res = spawnSync(bin, [...args], {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.error ? `${res.error.message}\n${res.stderr ?? ''}` : (res.stderr ?? ''),
    elapsedMs: Date.now() - started,
  };
};

/** 预编译用例所需的跨文件辅助模块，返回其输出目录（若无辅助模块返回 undefined）。 */
export const prepareHelperModules = (
  cases: readonly CrossDiffCase[],
  bootLean: string,
  bootLib: string,
  workDir: string,
  execFn: LeanExecFn = defaultLeanExec,
  timeoutMs = 120_000,
): string | undefined => {
  const modules = new Map<string, string>();
  for (const item of cases) {
    for (const [fileName, source] of Object.entries(item.helperModules ?? {})) {
      const prev = modules.get(fileName);
      if (prev !== undefined && prev !== source) {
        throw new Error(`辅助模块源码冲突: ${fileName}`);
      }
      modules.set(fileName, source);
    }
  }
  if (modules.size === 0) return undefined;

  const srcDir = join(workDir, 'helper-src');
  const libDir = join(workDir, 'helper-lib');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });

  const env = {
    ...process.env,
    LEAN_PATH: `${libDir}${process.platform === 'win32' ? ';' : ':'}${bootLib}`,
  };
  for (const [fileName, source] of modules) {
    const srcPath = join(srcDir, fileName);
    const stem = fileName.replace(/\.lean$/, '');
    const outOlean = join(libDir, `${stem}.olean`);
    mkdirSync(join(srcPath, '..'), { recursive: true });
    mkdirSync(join(outOlean, '..'), { recursive: true });
    writeFileSync(srcPath, source);
    const compiled = execFn(bootLean, ['-R', srcDir, '-o', outOlean, srcPath], env, timeoutMs);
    if (compiled.status !== 0) {
      throw new Error(
        `预编译辅助模块 ${fileName} 失败 (status=${compiled.status}): ${compiled.stderr || compiled.stdout}`,
      );
    }
  }
  return libDir;
};

/** 用官方原生 `lean` 执行单条差分用例并解析归一化结果。 */
export const runNativeCase = (
  item: CrossDiffCase,
  bootLean: string,
  bootLib: string,
  helperLib: string | undefined,
  workDir: string,
  timeoutMs: number,
  execFn: LeanExecFn = defaultLeanExec,
): CrossSideResult => {
  const srcDir = join(workDir, 'native-src');
  mkdirSync(srcDir, { recursive: true });
  const filePath = join(srcDir, item.fileName);
  writeFileSync(filePath, item.code);
  const sepChar = process.platform === 'win32' ? ';' : ':';
  const leanPath = helperLib ? `${helperLib}${sepChar}${bootLib}` : bootLib;
  const out = execFn(
    bootLean,
    ['-j2', filePath],
    { ...process.env, LEAN_PATH: leanPath },
    timeoutMs,
  );
  return parseNativeLeanOutput(out.stdout, out.stderr, out.status, out.elapsedMs);
};

export interface UnpackedRuntimeStage {
  readonly distDir: string;
  readonly libDir: string;
}

/** 从缓存产物目录 `wasm64-runtime-release` 还原浏览器可直接伺服的 `dist + olean-manifest.json`。 */
export const prepareDistFromPackedRuntime = (
  packedDir: string,
  outDir: string,
  harnessDir?: string,
): UnpackedRuntimeStage => {
  const distDir = join(outDir, 'dist');
  const libDir = join(outDir, 'lib');
  mkdirSync(distDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });

  const glueSrc = join(packedDir, 'lean-lsp-adapted.mjs');
  if (existsSync(glueSrc)) copyFileSync(glueSrc, join(distDir, 'lean-lsp-adapted.mjs'));
  const wasmZst = join(packedDir, 'lean-lsp.wasm.zst');
  if (existsSync(wasmZst)) {
    writeFileSync(join(distDir, 'lean-lsp.wasm'), zstdDecompressSync(readFileSync(wasmZst)));
  }
  if (harnessDir) {
    for (const file of ['harness.mjs', 'lsp-worker.mjs']) {
      const candidate = join(harnessDir, file);
      if (existsSync(candidate)) copyFileSync(candidate, join(distDir, file));
    }
  }

  const indexes = readdirSync(packedDir)
    .filter((name) => name.endsWith('.index.json'))
    .sort((a, b) => (a.includes('init') ? -1 : b.includes('init') ? 1 : a.localeCompare(b)));
  if (indexes.length === 0) throw new CliError(`在 ${packedDir} 中未找到 *.index.json`);
  for (const idx of indexes) {
    unpackPackedLib({ indexPath: join(packedDir, idx), chunksDir: packedDir, outDir: libDir });
  }

  const roots = readdirSync(libDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const manifest = collectOleanManifest(libDir, { roots, includeIr: true });
  writeFileSync(join(distDir, 'olean-manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { distDir, libDir };
};

const MIME_TYPES: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

const PAGE_HTML =
  '<!doctype html><meta charset="utf-8"><title>cross-platform diff</title><script type="module" src="/harness.mjs"></script>';

const send = (
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: string | Buffer,
): void => {
  res.writeHead(status, headers);
  res.end(body);
};

interface BrowserProbeResponse {
  readonly ok: boolean;
  readonly crossDiffResults?: ReadonlyArray<{
    readonly id: string;
    readonly diagnostics: readonly RawChromeDiagnostic[];
    readonly elapsedMs: number;
    readonly peakMemoryBytes?: number;
    readonly workerError?: string;
  }>;
}

export const runChromeCrossDiff = async (
  distDir: string,
  libDirs: readonly string[],
  cases: readonly CrossDiffCase[],
  helperLib: string | undefined,
  options: Pick<CrossDiffOptions, 'gluePath' | 'manifestPath' | 'timeoutMs'>,
): Promise<Map<string, CrossSideResult>> => {
  const baseManifest = JSON.parse(
    readFileSync(resolve(distDir, `.${options.manifestPath}`), 'utf8'),
  ) as string[];
  const extraFiles = helperLib
    ? collectOleanManifest(helperLib, {
        roots: readdirSync(helperLib, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .concat(
            readdirSync(helperLib)
              .filter((f) => f.endsWith('.olean'))
              .map((f) => f.replace(/\.olean$/, '')),
          ),
      })
    : [];
  const mergedManifest = [...new Set([...baseManifest, ...extraFiles])];
  const serializedCases = JSON.stringify(
    cases.map((item) => ({
      id: item.id,
      fileName: item.fileName,
      code: item.code,
      expectOk: item.expectOk,
    })),
  );

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      send(res, 200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }, PAGE_HTML);
      return;
    }
    if (url.pathname === '/cross-diff-cases.json') {
      send(res, 200, { ...headers, 'Content-Type': 'application/json' }, serializedCases);
      return;
    }
    if (url.pathname === '/cross-diff-manifest.json') {
      send(
        res,
        200,
        { ...headers, 'Content-Type': 'application/json' },
        JSON.stringify(mergedManifest),
      );
      return;
    }
    if (url.pathname.startsWith('/lean-lib/')) {
      const rel = decodeURIComponent(url.pathname.slice('/lean-lib/'.length));
      for (const dir of libDirs) {
        const resolvedDir = resolve(dir);
        const filePath = resolve(resolvedDir, rel);
        if (!filePath.startsWith(resolvedDir + sep)) continue;
        try {
          const body = await readFile(filePath);
          send(res, 200, { ...headers, 'Content-Type': 'application/octet-stream' }, body);
          return;
        } catch {
          // 尝试下一层目录。
        }
      }
      send(res, 404, headers);
      return;
    }
    const resolvedDist = resolve(distDir);
    const filePath = resolve(resolvedDist, `.${decodeURIComponent(url.pathname)}`);
    if (filePath !== resolvedDist && !filePath.startsWith(resolvedDist + sep)) {
      send(res, 403, headers);
      return;
    }
    try {
      const body = await readFile(filePath);
      send(
        res,
        200,
        { ...headers, 'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream' },
        body,
      );
    } catch {
      send(res, 404, headers);
    }
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取本地服务端口');
  const origin = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (message) =>
      console.log(`[cross-diff:${message.type()}] ${message.text()}`),
    );
    const pageError = new Promise<never>((_, reject) => {
      page.once('pageerror', (error) => reject(new Error(`Chrome pageerror: ${error.message}`)));
    });
    const query = new URLSearchParams({
      mode: 'cross-diff',
      manifest: '/cross-diff-manifest.json',
      glue: options.gluePath,
    });
    await page.goto(`${origin}/?${query.toString()}`, { waitUntil: 'load', timeout: 60_000 });
    await Promise.race([
      page.waitForFunction('window.__probeResult !== undefined', undefined, {
        timeout: Math.max(300_000, cases.length * options.timeoutMs),
      }),
      pageError,
    ]);
    const probe = (await page.evaluate('window.__probeResult')) as BrowserProbeResponse;
    await page.close();
    const map = new Map<string, CrossSideResult>();
    for (const item of probe.crossDiffResults ?? []) {
      map.set(
        item.id,
        normalizeChromeLspResult(
          item.diagnostics,
          item.elapsedMs,
          item.peakMemoryBytes,
          item.workerError,
        ),
      );
    }
    return map;
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
};

export interface SuiteDeps {
  readonly runNative?: (
    item: CrossDiffCase,
    helperLib: string | undefined,
    workDir: string,
  ) => CrossSideResult;
  readonly runChrome?: (
    distDir: string,
    libDirs: readonly string[],
    cases: readonly CrossDiffCase[],
    helperLib: string | undefined,
  ) => Promise<Map<string, CrossSideResult>>;
  readonly prepareHelpers?: (
    cases: readonly CrossDiffCase[],
    workDir: string,
  ) => string | undefined;
}

export const runCrossDiffSuite = async (
  options: CrossDiffOptions,
  deps: SuiteDeps = {},
): Promise<CrossDiffReport> => {
  const cases = selectCrossDiffCases(options.suite, options.caseIds);
  const workDir = mkdtempSync(join(tmpdir(), 'lean-cross-diff-'));
  try {
    let distDir = options.distDir;
    let baseLibDir = options.bootLib;
    if (options.packedRuntime) {
      const unpacked = prepareDistFromPackedRuntime(
        options.packedRuntime,
        join(workDir, 'packed'),
        options.harnessDir,
      );
      distDir = distDir ?? unpacked.distDir;
      baseLibDir = unpacked.libDir;
    }
    if (!distDir) throw new CliError('未能解析 browser distDir');

    const helperLib = deps.prepareHelpers
      ? deps.prepareHelpers(cases, workDir)
      : prepareHelperModules(
          cases,
          options.bootLean,
          baseLibDir,
          workDir,
          defaultLeanExec,
          options.timeoutMs,
        );

    const libDirs = helperLib ? [helperLib, baseLibDir] : [baseLibDir];
    const nativeResults = new Map<string, CrossSideResult>();
    for (const item of cases) {
      nativeResults.set(
        item.id,
        deps.runNative
          ? deps.runNative(item, helperLib, workDir)
          : runNativeCase(
              item,
              options.bootLean,
              baseLibDir,
              helperLib,
              workDir,
              options.timeoutMs,
            ),
      );
    }

    const chromeResults = deps.runChrome
      ? await deps.runChrome(distDir, libDirs, cases, helperLib)
      : await runChromeCrossDiff(distDir, libDirs, cases, helperLib, options);

    const comparisons: CaseComparison[] = cases.map((item) => {
      const native = nativeResults.get(item.id);
      const chrome =
        chromeResults.get(item.id) ??
        normalizeChromeLspResult([], 0, undefined, `Chrome 未返回用例 ${item.id} 的结果`);
      if (!native) throw new Error(`原生未返回用例 ${item.id} 的结果`);
      return compareCrossPlatformResults(item, native, chrome);
    });

    const passed = comparisons.filter((entry) => entry.ok).length;
    const report: CrossDiffReport = {
      suite: options.suite,
      total: comparisons.length,
      passed,
      failed: comparisons.length - passed,
      cases: comparisons,
    };

    const markdown = renderDiffSummaryMarkdown(report);
    process.stdout.write(markdown);
    if (options.summaryPath) writeFileSync(options.summaryPath, markdown, { flag: 'a' });
    if (options.reportPath) {
      mkdirSync(join(options.reportPath, '..'), { recursive: true });
      writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const options = parseCrossDiffOptions(process.argv.slice(2));
  const report = await runCrossDiffSuite(options);
  if (report.failed > 0) {
    throw new CliError(`跨端差分一致性失败：${report.failed}/${report.total} 组存在行为分歧`);
  }
};

if (isMainModule(import.meta.url, process.argv[1])) runCli(main);
