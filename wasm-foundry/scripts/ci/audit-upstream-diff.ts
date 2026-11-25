// 软 Fork 分级 Diff 审计（Issue #83）：对比上游官方 tag，输出 src/ 的改动清单与「需要哪一档门禁」。
//
// 动机：改动 src/Init、src/Std、src/Lean 或编译器 Pass 即使语义等价，也会让私有 / 特化声明
// 的哈希（`_private..._hygCtx._hyg.*.spec_0`）与官方预编译 Mathlib .olean 不兼容；但一律禁止
// 修改 src/ 又会挡住必要的深度适配。这里把改动分层，用「分级」代替「白名单」。
//
// 用法:
//   node scripts/ci/audit-upstream-diff.ts --tag v4.36.0 [--repo <root>] \
//     [--summary <file>] [--output <file>] [--json]
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { optionalString, parseArgs, requireString, runCli, type FlagSpec } from '../lib/cli.ts';
import { isMainModule } from '../lib/entry.ts';

export type DiffLayer = 'lean-core' | 'runtime' | 'engine' | 'other';

/** 分档顺序即严重度：lean-core 最可能破坏官方 .olean 的 ABI 兼容性。 */
export type DiffTier = 'light' | 'engine' | 'runtime' | 'lean-core';

export interface DiffEntry {
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
}

export interface LayerGroup {
  readonly layer: DiffLayer;
  readonly files: readonly DiffEntry[];
  readonly added: number;
  readonly deleted: number;
}

export interface DiffAudit {
  readonly tier: DiffTier;
  readonly totalFiles: number;
  readonly added: number;
  readonly deleted: number;
  readonly groups: readonly LayerGroup[];
}

const LEAN_CORE_PREFIXES = ['src/Init/', 'src/Std/', 'src/Lean/'] as const;
const RUNTIME_PREFIXES = [
  'src/runtime/',
  'src/kernel/',
  'src/library/',
  'src/util/',
  'src/include/',
  'src/initialize/',
] as const;

/** `src/CMakeLists.txt` 等构建文件归到 engine：会改编译参数但不改语义。 */
const ENGINE_EXACT = new Set(['src/CMakeLists.txt']);

export const classifyPath = (path: string): DiffLayer => {
  if (LEAN_CORE_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'lean-core';
  if (RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'runtime';
  if (ENGINE_EXACT.has(path)) return 'engine';
  return 'other';
};

const LAYER_ORDER: readonly DiffLayer[] = ['lean-core', 'runtime', 'engine', 'other'];

export const summarizeDiff = (entries: readonly DiffEntry[]): DiffAudit => {
  const groups: LayerGroup[] = [];
  for (const layer of LAYER_ORDER) {
    const files = entries.filter((entry) => classifyPath(entry.path) === layer);
    if (files.length === 0) continue;
    groups.push({
      layer,
      files,
      added: files.reduce((sum, file) => sum + file.added, 0),
      deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    });
  }
  const touched = new Set(groups.map((group) => group.layer));
  const tier: DiffTier = touched.has('lean-core')
    ? 'lean-core'
    : touched.has('runtime')
      ? 'runtime'
      : touched.has('engine')
        ? 'engine'
        : 'light';
  return {
    tier,
    totalFiles: entries.length,
    added: entries.reduce((sum, entry) => sum + entry.added, 0),
    deleted: entries.reduce((sum, entry) => sum + entry.deleted, 0),
    groups,
  };
};

/** `git diff --numstat` 输出；二进制文件是 `-\t-\tpath`，按 0 行处理。 */
export const parseNumstat = (stdout: string): DiffEntry[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (path === '') throw new Error(`无法解析 numstat 行: ${line}`);
      const toNumber = (value: string | undefined): number => {
        if (value === undefined || value === '-') return 0;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new Error(`numstat 的增删行数非法: ${line}`);
        }
        return parsed;
      };
      return { path, added: toNumber(added), deleted: toNumber(deleted) };
    });

const TIER_ADVICE: Record<DiffTier, string> = {
  light: '只动外围工程文件：轻量 lint + 打包校验即可。',
  engine:
    '只动构建/编译参数：轻量 lint + 打包校验即可；改了 emcc 参数请顺手确认 wasm32 产物仍可链接。',
  runtime:
    '触及 C++ 运行时 / Emscripten 适配层：必须跑 C ABI Diff 与原生 vs wasm64 跨端差分（Consistency · 5-Layer Gate）。',
  'lean-core':
    '触及 Lean 核心库（src/Init、src/Std、src/Lean）或编译器 Pass：私有声明哈希可能与官方预编译 Mathlib .olean 漂移。' +
    '合并前必须手动 dispatch `Runtime · Lean wasm64 gate` 的 `mode=deep`（它跑官方 Mathlib 实弹门禁）。',
};

export const renderReport = (audit: DiffAudit, tag: string): string => {
  const lines: string[] = [];
  lines.push(`### 软 Fork Diff 审计（相对上游 ${tag}）`);
  lines.push('');
  if (audit.totalFiles === 0) {
    lines.push('`src/` 与上游完全一致。');
    lines.push('');
    lines.push(`**分级：light** — ${TIER_ADVICE.light}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `改动 ${audit.totalFiles} 个文件，+${audit.added} / -${audit.deleted}；分级 **${audit.tier}**。`,
  );
  lines.push('');
  lines.push('| 分层 | 文件 | + | - |');
  lines.push('| --- | --- | --- | --- |');
  for (const group of audit.groups) {
    lines.push(`| ${group.layer} | ${group.files.length} | +${group.added} | -${group.deleted} |`);
  }
  lines.push('');
  lines.push(`> ${TIER_ADVICE[audit.tier]}`);
  lines.push('');
  lines.push('<details><summary>文件清单</summary>');
  lines.push('');
  for (const group of audit.groups) {
    lines.push(`**${group.layer}**`);
    lines.push('');
    for (const file of group.files) {
      lines.push(`- \`${file.path}\` +${file.added} / -${file.deleted}`);
    }
    lines.push('');
  }
  lines.push('</details>');
  return `${lines.join('\n')}\n`;
};

export const readDiff = (repo: string, tag: string): DiffEntry[] => {
  const stdout = execFileSync(
    'git',
    ['-C', repo, 'diff', '--numstat', `${tag}..HEAD`, '--', 'src/'],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return parseNumstat(stdout);
};

const SPEC: Record<string, FlagSpec> = {
  tag: { kind: 'string', required: true, valueName: 'v4.36.0' },
  repo: { kind: 'string', valueName: 'dir' },
  summary: { kind: 'string', valueName: 'file' },
  output: { kind: 'string', valueName: 'file' },
  json: { kind: 'boolean' },
};

const main = (): void => {
  const parsed = parseArgs(process.argv.slice(2), SPEC);
  const tag = requireString(parsed, 'tag');
  const repo = optionalString(parsed, 'repo') ?? process.cwd();
  const audit = summarizeDiff(readDiff(repo, tag));
  const report = renderReport(audit, tag);
  process.stdout.write(report);
  const summary = optionalString(parsed, 'summary');
  if (summary !== undefined) appendFileSync(summary, report);
  const output = optionalString(parsed, 'output');
  if (output !== undefined) {
    writeFileSync(
      output,
      [`tier=${audit.tier}`, `lean_core_changed=${audit.tier === 'lean-core'}`].join('\n') + '\n',
      { flag: 'a' },
    );
  }
  if (parsed.flags.json === true) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  }
};

if (isMainModule(import.meta.url, process.argv[1])) runCli(main);
