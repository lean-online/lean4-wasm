// 从打包后的分片产物（<prefix>.index.json + <prefix>-XX.pack.zst.bin）解包还原
// 原始 .olean / .ilean 目录结构，用于独立验证每个扩展包在纯净环境下的传递依赖闭环。
// 同时提供 collectExtensionRoots 收集非核心模块根目录（避免漏打 Batteries / Qq 等依赖）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  CliError,
  optionalString,
  parseArgs,
  requireString,
  runCli,
  type FlagSpec,
} from '../lib/cli.ts';
import { isMainModule } from '../lib/entry.ts';
import { requireDir, requireFile } from '../lib/fs-guards.ts';
import type { PackChunk, PackFileEntry } from '../pack-lean-lib.ts';

export const CORE_BUNDLED_ROOTS = new Set(['Init', 'Std', 'Lean', 'Lake']);

const TOP_LEVEL_SUFFIX =
  /^(Init|Std|Lean|Lake|[A-Z][A-Za-z0-9_]*)\.(olean(?:\.server|\.private)?|ilean|ir(?:\.sig)?)$/;

interface PackIndexFile {
  readonly chunks: readonly PackChunk[];
  readonly files: readonly PackFileEntry[];
}

export interface UnpackOptions {
  readonly indexPath: string;
  readonly chunksDir?: string;
  readonly outDir: string;
}

export interface UnpackResult {
  readonly files: number;
  readonly bytes: number;
}

/**
 * 收集 libDir 中除 CORE_BUNDLED_ROOTS（Init/Std/Lean/Lake）外的所有顶级模块前缀，
 * 覆盖 Mathlib 及与其一同编译的第三方 Lake 依赖（如 Batteries、Qq）。
 */
export const collectExtensionRoots = (
  libDir: string,
  excludedRoots: ReadonlySet<string> = CORE_BUNDLED_ROOTS,
): string[] => {
  const dir = requireDir(libDir, 'lib');
  const roots = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (!excludedRoots.has(entry.name)) roots.add(entry.name);
      continue;
    }
    const match = TOP_LEVEL_SUFFIX.exec(entry.name);
    const stem = match?.[1];
    if (stem !== undefined && !excludedRoots.has(stem)) roots.add(stem);
  }
  return [...roots].sort();
};

const resolveChunkFile = (chunksDir: string, chunkPath: string): string => {
  const candidates = [join(chunksDir, `${chunkPath}.bin`), join(chunksDir, chunkPath)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new CliError(`缺少分片文件: ${candidates[0]}`);
};

/** 解包单个 <prefix>.index.json 及其关联分片到 outDir（按 entry.path 原样落盘）。 */
export const unpackPackedLib = (options: UnpackOptions): UnpackResult => {
  const indexPath = requireFile(options.indexPath, 'index');
  const chunksDir = requireDir(options.chunksDir ?? dirname(indexPath), 'chunksDir');
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<PackIndexFile>;
  if (!Array.isArray(parsed.chunks) || !Array.isArray(parsed.files)) {
    throw new CliError(`索引格式非法: ${indexPath}`);
  }

  const decompressedChunks = parsed.chunks.map((chunk) => {
    const chunkFile = resolveChunkFile(chunksDir, chunk.path);
    const raw = Buffer.from(zstdDecompressSync(readFileSync(chunkFile)));
    if (raw.byteLength !== chunk.uncompressedBytes) {
      throw new CliError(
        `分片解压长度不匹配 (${chunk.path}): ${raw.byteLength} != ${chunk.uncompressedBytes}`,
      );
    }
    return raw;
  });

  const combined = Buffer.concat(decompressedChunks);
  mkdirSync(options.outDir, { recursive: true });

  let totalBytes = 0;
  for (const entry of parsed.files) {
    if (entry.path.startsWith('/') || entry.path.includes('..') || entry.path.includes('\\')) {
      throw new CliError(`索引文件路径非法: ${entry.path}`);
    }
    const slice = combined.subarray(entry.offset, entry.offset + entry.bytes);
    if (slice.byteLength !== entry.bytes) {
      throw new CliError(`文件偏移越界: ${entry.path}`);
    }
    const dest = join(options.outDir, entry.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, slice);
    totalBytes += slice.byteLength;
  }

  return { files: parsed.files.length, bytes: totalBytes };
};

const SPEC: Record<string, FlagSpec> = {
  indexes: { kind: 'string', required: true, valueName: 'a.index.json,b.index.json' },
  'chunks-dir': { kind: 'string', valueName: 'dir' },
  out: { kind: 'string', required: true, valueName: 'outDir' },
};

const main = (): void => {
  const parsed = parseArgs(process.argv.slice(2), SPEC);
  const indexes = requireString(parsed, 'indexes')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (indexes.length === 0) throw new CliError('--indexes 不能为空');
  const chunksDir = optionalString(parsed, 'chunks-dir');
  const outDir = requireString(parsed, 'out');
  let totalFiles = 0;
  for (const indexPath of indexes) {
    const res = unpackPackedLib({
      indexPath,
      outDir,
      ...(chunksDir === undefined ? {} : { chunksDir }),
    });
    totalFiles += res.files;
  }
  console.log(`unpacked ${totalFiles} files from ${indexes.length} index(es) -> ${outDir}`);
};

if (isMainModule(import.meta.url, process.argv[1])) runCli(main);
