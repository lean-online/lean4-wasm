// 第 4 层门禁：C 导出符号表 ABI 静态 Diff（对比官方基准 v4.36.0 与软 Fork 改动 `.lean` 模块）。
// 目的：确保对内核或策略 `.lean` 的改造不删除、不改变任何公开导出符号（或跨模块引用的内部符号）
// 的名称、返回类型或参数签名，守住「软 Fork 复用官方全量 Mathlib .olean」的底线。
//
// 用法:
//   node scripts/ci/check-abi-diff.ts \
//     --boot-lean <bin/lean> --boot-lib <lib/lean> --repo <lean4Root> \
//     [--base-ref v4.36.0] [--cgen-dir <dir>] [--files a.lean,b.lean] [--timeout 180000]
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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

export interface ExportedSymbol {
  readonly name: string;
  readonly kind: 'fn' | 'var';
  readonly returnType: string;
  readonly paramTypes: readonly string[];
  readonly isPrivate: boolean;
}

export interface AbiChange {
  readonly symbol: string;
  readonly reason: 'removed' | 'signature_changed';
  readonly baselineSignature: string;
  readonly currentSignature?: string;
  readonly classification: 'public' | 'pinned_private' | 'external_ref' | 'internal';
}

export interface AbiDiffReport {
  readonly moduleName: string;
  readonly baselineCount: number;
  readonly currentCount: number;
  readonly breakingChanges: readonly AbiChange[];
  readonly internalChanges: readonly AbiChange[];
  readonly addedSymbols: readonly string[];
}

export interface AbiDiffOptions {
  readonly bootLean: string;
  readonly bootLib: string;
  readonly repo: string;
  readonly baseRef: string;
  readonly cgenDir?: string;
  readonly files?: readonly string[];
  readonly strictInternal: boolean;
  readonly timeoutMs: number;
}

/** 已被上游预编译 `.olean` 跨模块内联引用的内部符号（如 ComputedFields.c 调用 whnfCore_go）。 */
export const PINNED_PRIVATE_ABI_SYMBOLS = [
  'l___private_Lean_Meta_WHNF_0__Lean_Meta_whnfCore_go',
] as const;

const C_TYPE_KEYWORDS = new Set([
  'void',
  'int',
  'long',
  'short',
  'char',
  'float',
  'double',
  'signed',
  'unsigned',
  'const',
  'volatile',
  'restrict',
  'struct',
  'enum',
  'union',
]);

const normalizeWhitespace = (raw: string): string =>
  raw
    .replace(/\s+/g, ' ')
    .replace(/\s*\*\s*/g, '* ')
    .replace(/\* +(?=[),]|$)/g, '*')
    .trim();

const normalizeParamType = (rawParam: string): string => {
  const cleaned = normalizeWhitespace(rawParam);
  if (!cleaned || cleaned === 'void') return '';
  if (cleaned === '...') return '...';

  // 若末尾紧接参数形参名（如 `lean_object* v_x_1_` 或 `uint8_t v_flag_2_`），剥离形参名只保留 C 类型。
  const starIdx = cleaned.lastIndexOf('*');
  if (starIdx !== -1) {
    const afterStar = cleaned.slice(starIdx + 1).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(afterStar) && !C_TYPE_KEYWORDS.has(afterStar)) {
      return cleaned.slice(0, starIdx + 1).trim();
    }
    return cleaned;
  }

  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(last) && !C_TYPE_KEYWORDS.has(last)) {
      return tokens.slice(0, -1).join(' ');
    }
  }
  return cleaned;
};

const formatSymbolSignature = (sym: ExportedSymbol): string =>
  sym.kind === 'var'
    ? `var ${sym.returnType}`
    : `fn (${sym.paramTypes.join(', ')}) -> ${sym.returnType}`;

const signaturesEqual = (a: ExportedSymbol, b: ExportedSymbol): boolean => {
  if (a.kind !== b.kind || a.returnType !== b.returnType) return false;
  if (a.paramTypes.length !== b.paramTypes.length) return false;
  return a.paramTypes.every((param, idx) => param === b.paramTypes[idx]);
};

/** 判定符号是否属于编译器内部辅助产物（private、文件局部特化 ___at___..._spec__、闭包 ___lam__ 或卫生标记 ___hyg）。 */
export const isInternalCompilerSymbol = (name: string): boolean =>
  name.startsWith('l___private_') ||
  name.includes('___private_') ||
  (name.includes('___at___') && name.includes('_spec__')) ||
  name.includes('___lam__') ||
  name.includes('___hyg');

const findMatchingOpenParen = (text: string, closeParenIndex: number): number => {
  let depth = 0;
  for (let i = closeParenIndex; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** 解析 Lean C 后端生成的 `LEAN_EXPORT` 函数签名与导出全局变量。 */
export const parseLeanExportSymbols = (cSource: string): Map<string, ExportedSymbol> => {
  const symbols = new Map<string, ExportedSymbol>();
  const marker = /^LEAN_EXPORT\b/gm;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(cSource)) !== null) {
    const start = match.index + match[0].length;
    let parenDepth = 0;
    let end = start;
    while (end < cSource.length) {
      const ch = cSource[end];
      if (ch === '(') parenDepth += 1;
      else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
      else if (parenDepth === 0 && (ch === ';' || ch === '{' || ch === '=')) break;
      end += 1;
    }
    const header = cSource.slice(start, end).trim();
    if (!header) continue;

    if (header.endsWith(')')) {
      const openIdx = findMatchingOpenParen(header, header.length - 1);
      if (openIdx === -1) continue;
      const beforeParen = normalizeWhitespace(header.slice(0, openIdx));
      const nameMatch = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(beforeParen);
      if (!nameMatch?.[1] || !nameMatch[2]) continue;
      const returnType = normalizeWhitespace(nameMatch[1]);
      const name = nameMatch[2];
      const rawParams = header.slice(openIdx + 1, header.length - 1).trim();
      const paramTypes =
        rawParams === '' || rawParams === 'void'
          ? []
          : rawParams
              .split(',')
              .map((part) => normalizeParamType(part))
              .filter((part) => part !== '');
      if (!symbols.has(name)) {
        symbols.set(name, {
          name,
          kind: 'fn',
          returnType,
          paramTypes,
          isPrivate: isInternalCompilerSymbol(name),
        });
      }
    } else {
      const normalized = normalizeWhitespace(header);
      const varMatch = /^(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(normalized);
      if (!varMatch?.[1] || !varMatch[2]) continue;
      const returnType = normalizeWhitespace(varMatch[1]);
      const name = varMatch[2];
      if (!symbols.has(name)) {
        symbols.set(name, {
          name,
          kind: 'var',
          returnType,
          paramTypes: [],
          isPrivate: isInternalCompilerSymbol(name),
        });
      }
    }
  }

  return symbols;
};

/** 扫描其他 `.c` 模块中声明引用的跨模块外部 Lean 符号（包含显式 `extern` 与 Lean 前向声明）。 */
export const collectExternalSymbolRefs = (
  cFiles: ReadonlyMap<string, string>,
  skipModuleKeys: ReadonlySet<string> = new Set(),
): Set<string> => {
  const refs = new Set<string>();
  const protoRe =
    /^(?!\s*(?:LEAN_EXPORT|static|#|\*|\/))[^\n;{}=]*?\b(l_[A-Za-z0-9_]+)\s*(?:\([^)]*\)|)\s*;/gm;

  for (const [key, content] of cFiles.entries()) {
    if (skipModuleKeys.has(key)) continue;
    let m: RegExpExecArray | null;
    while ((m = protoRe.exec(content)) !== null) {
      if (m[1]) refs.add(m[1]);
    }
  }
  return refs;
};

export interface DiffOptions {
  readonly externalRefs?: ReadonlySet<string>;
  readonly pinnedPrivate?: readonly string[];
  readonly strictInternal?: boolean;
  readonly allowedInternalChanges?: ReadonlySet<string>;
}

/** 对比基准版（官方 v4.36.0）与当前软 Fork 模块的导出符号表，识别所有 ABI 破坏性变更。 */
export const diffExportSymbols = (
  moduleName: string,
  baseline: ReadonlyMap<string, ExportedSymbol>,
  current: ReadonlyMap<string, ExportedSymbol>,
  options: DiffOptions = {},
): AbiDiffReport => {
  const externalRefs = options.externalRefs ?? new Set<string>();
  const pinnedSet = new Set(options.pinnedPrivate ?? PINNED_PRIVATE_ABI_SYMBOLS);
  const strictInternal = options.strictInternal ?? false;
  const allowedInternal = options.allowedInternalChanges ?? new Set<string>();

  const breakingChanges: AbiChange[] = [];
  const internalChanges: AbiChange[] = [];

  for (const [name, baseSym] of baseline.entries()) {
    const currSym = current.get(name);
    let reason: AbiChange['reason'] | undefined;
    if (!currSym) reason = 'removed';
    else if (!signaturesEqual(baseSym, currSym)) reason = 'signature_changed';
    if (!reason) continue;

    const baselineSignature = formatSymbolSignature(baseSym);
    const currentSignature = currSym ? formatSymbolSignature(currSym) : undefined;
    const isPinned = pinnedSet.has(name);
    const isExternal = externalRefs.has(name);
    const classification: AbiChange['classification'] = !baseSym.isPrivate
      ? 'public'
      : isPinned
        ? 'pinned_private'
        : isExternal
          ? 'external_ref'
          : 'internal';

    const change: AbiChange = {
      symbol: name,
      reason,
      baselineSignature,
      ...(currentSignature === undefined ? {} : { currentSignature }),
      classification,
    };

    if (classification !== 'internal' || (strictInternal && !allowedInternal.has(name))) {
      breakingChanges.push(change);
    } else {
      internalChanges.push(change);
    }
  }

  const addedSymbols = [...current.keys()].filter((name) => !baseline.has(name));
  return {
    moduleName,
    baselineCount: baseline.size,
    currentCount: current.size,
    breakingChanges,
    internalChanges,
    addedSymbols,
  };
};

const ABI_SPEC: Record<string, FlagSpec> = {
  'boot-lean': { kind: 'string', required: true, valueName: 'bin/lean' },
  'boot-lib': { kind: 'string', required: true, valueName: 'lib/lean' },
  repo: { kind: 'string', required: true, valueName: 'lean4Root' },
  'base-ref': { kind: 'string', valueName: 'git-ref' },
  'cgen-dir': { kind: 'string', valueName: 'work/cgen' },
  files: { kind: 'string', valueName: 'comma-separated-src-lean' },
  'strict-internal': { kind: 'boolean' },
  timeout: { kind: 'number', valueName: 'ms' },
};

export const parseAbiDiffOptions = (argv: readonly string[]): AbiDiffOptions => {
  const parsed = parseArgs(argv, ABI_SPEC);
  const timeoutMs = parsed.flags.timeout === undefined ? 180_000 : requireNumber(parsed, 'timeout');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError(`--timeout 必须是正整数，收到 ${timeoutMs}`);
  }
  const cgenDir = optionalString(parsed, 'cgen-dir');
  const filesRaw = optionalString(parsed, 'files');
  const files = filesRaw
    ? filesRaw
        .split(',')
        .map((item) => item.trim().replace(/\\/g, '/'))
        .filter(Boolean)
    : undefined;
  return {
    bootLean: requireFile(requireString(parsed, 'boot-lean'), 'boot-lean'),
    bootLib: requireDir(requireString(parsed, 'boot-lib'), 'boot-lib'),
    repo: requireDir(requireString(parsed, 'repo'), 'repo'),
    baseRef: optionalString(parsed, 'base-ref') ?? 'v4.36.0',
    ...(cgenDir === undefined ? {} : { cgenDir: requireDir(cgenDir, 'cgen-dir') }),
    ...(files === undefined ? {} : { files }),
    strictInternal: Boolean(parsed.flags['strict-internal']),
    timeoutMs,
  };
};

const discoverChangedLeanFiles = (repo: string, baseRef: string): string[] => {
  const res = spawnSync('git', ['-C', repo, 'diff', '--name-only', baseRef, 'HEAD', '--', 'src/'], {
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git diff ${baseRef} HEAD 失败 (${res.status}): ${res.stderr}`);
  }
  return (res.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter((line) => line.endsWith('.lean') && line.startsWith('src/'));
};

const compileLeanToC = (
  bootLean: string,
  bootLib: string,
  srcRoot: string,
  leanRelUnderSrc: string,
  outCPath: string,
  timeoutMs: number,
): string => {
  mkdirSync(dirname(outCPath), { recursive: true });
  const res = spawnSync(
    bootLean,
    [
      '-j1',
      '-R',
      '.',
      '-Dinterpreter.prefer_native=false',
      '-Dpp.rawOnError=true',
      '-c',
      outCPath,
      leanRelUnderSrc,
    ],
    {
      cwd: srcRoot,
      env: { ...process.env, LEAN_PATH: bootLib },
      encoding: 'utf8',
      timeout: timeoutMs,
    },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `生成 ${leanRelUnderSrc} 的 C 源码失败 (${res.status}):\n${res.stderr}\n${res.stdout}`,
    );
  }
  return readFileSync(outCPath, 'utf8');
};

const loadCgenMap = (cgenDir: string): Map<string, string> => {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.c')) {
        map.set(relative(cgenDir, full).replace(/\\/g, '/'), readFileSync(full, 'utf8'));
      }
    }
  };
  walk(cgenDir);
  return map;
};

export const runAbiDiffCheck = (options: AbiDiffOptions): AbiDiffReport[] => {
  const changed = options.files ?? discoverChangedLeanFiles(options.repo, options.baseRef);
  if (changed.length === 0) {
    console.log(`[abi] 相对 ${options.baseRef} 无 src/**/*.lean 改动，跳过符号表 diff`);
    return [];
  }

  const workDir = mkdtempSync(join(tmpdir(), 'lean4-abi-diff-'));
  const baseWorktree = join(workDir, 'base-src');
  const outBaseDir = join(workDir, 'c-base');
  const outCurrDir = join(workDir, 'c-curr');
  let worktreeAdded = false;

  try {
    const wtAdd = spawnSync(
      'git',
      ['-C', options.repo, 'worktree', 'add', '--detach', baseWorktree, options.baseRef],
      { encoding: 'utf8' },
    );
    if (wtAdd.error) throw wtAdd.error;
    if (wtAdd.status !== 0) {
      throw new Error(
        `创建基准 git worktree (${options.baseRef}) 失败 (${wtAdd.status}): ${wtAdd.stderr}`,
      );
    }
    worktreeAdded = true;

    const cgenMap = options.cgenDir ? loadCgenMap(options.cgenDir) : new Map<string, string>();
    const skipKeys = new Set(changed.map((p) => p.replace(/^src\//, '').replace(/\.lean$/, '.c')));
    const externalRefs =
      cgenMap.size > 0 ? collectExternalSymbolRefs(cgenMap, skipKeys) : new Set<string>();

    const reports: AbiDiffReport[] = [];
    const allBreaking: Array<{ moduleName: string; change: AbiChange }> = [];

    for (const repoRel of changed) {
      const underSrc = repoRel.replace(/^src\//, '');
      const cRel = underSrc.replace(/\.lean$/, '.c');
      const baseSrcFile = join(baseWorktree, 'src', underSrc);
      const currSrcFile = join(options.repo, 'src', underSrc);
      if (!existsSync(baseSrcFile) || !statSync(baseSrcFile).isFile()) {
        console.log(`[abi] 新增模块（基准不存在），跳过对比: ${repoRel}`);
        continue;
      }
      if (!existsSync(currSrcFile)) {
        throw new Error(`改动文件 ${repoRel} 在当前源码中已被删除（破坏模块级 ABI）`);
      }

      const baseC = compileLeanToC(
        options.bootLean,
        options.bootLib,
        join(baseWorktree, 'src'),
        underSrc,
        join(outBaseDir, cRel),
        options.timeoutMs,
      );
      const currC =
        cgenMap.get(cRel) ??
        compileLeanToC(
          options.bootLean,
          options.bootLib,
          join(options.repo, 'src'),
          underSrc,
          join(outCurrDir, cRel),
          options.timeoutMs,
        );

      const report = diffExportSymbols(
        underSrc,
        parseLeanExportSymbols(baseC),
        parseLeanExportSymbols(currC),
        {
          externalRefs,
          pinnedPrivate: PINNED_PRIVATE_ABI_SYMBOLS,
          strictInternal: options.strictInternal,
        },
      );
      reports.push(report);
      for (const change of report.breakingChanges) {
        allBreaking.push({ moduleName: report.moduleName, change });
      }
      console.log(
        `[abi] ${report.moduleName}: baseline=${report.baselineCount} current=${report.currentCount} ` +
          `added=${report.addedSymbols.length} internalChanges=${report.internalChanges.length} breaking=${report.breakingChanges.length}`,
      );
    }

    if (allBreaking.length > 0) {
      const detail = allBreaking
        .map(
          ({ moduleName, change }) =>
            `  - [${moduleName}][${change.classification}] ${change.symbol} (${change.reason}): ` +
            `baseline=${change.baselineSignature}` +
            (change.currentSignature ? `, current=${change.currentSignature}` : ''),
        )
        .join('\n');
      throw new Error(`发现破坏性 C 导出符号 ABI 变更（将导致无法兼容官方 .olean）:\n${detail}`);
    }

    console.log(`[abi] all ${reports.length} modified Lean modules passed ABI compatibility check`);
    return reports;
  } finally {
    if (worktreeAdded) {
      spawnSync('git', ['-C', options.repo, 'worktree', 'remove', '--force', baseWorktree], {
        encoding: 'utf8',
      });
    }
    rmSync(workDir, { recursive: true, force: true });
  }
};

const main = (): void => {
  const options = parseAbiDiffOptions(process.argv.slice(2));
  runAbiDiffCheck(options);
};

if (isMainModule(import.meta.url, process.argv[1])) runCli(main);
