import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packLibrary } from '../pack-lean-lib.ts';
import { collectExtensionRoots, unpackPackedLib } from './unpack-packed-lib.ts';

const dirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'unpack-packed-lib-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('collectExtensionRoots', () => {
  it('excludes Init/Std/Lean/Lake and preserves Mathlib plus transitive Lake roots like Batteries and Qq', () => {
    const libDir = makeTempDir();
    for (const rel of [
      'Init.olean',
      'Init/Prelude.olean',
      'Std/Data/HashMap.olean',
      'Lean/CoreM.olean',
      'Lake.olean',
      'Batteries.olean',
      'Batteries/Control/ForInStep.olean',
      'Qq/Macro.olean',
      'Mathlib.olean',
      'Mathlib/Tactic/Basic.olean',
    ]) {
      const full = join(libDir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, rel);
    }

    expect(collectExtensionRoots(libDir)).toEqual(['Batteries', 'Mathlib', 'Qq']);
  });
});

describe('unpackPackedLib', () => {
  it('round-trips chunked zstd packs back to the exact file tree', () => {
    const src = makeTempDir();
    const packedDir = makeTempDir();
    const unpackedDir = makeTempDir();

    const files = ['Batteries/Basic.olean', 'Mathlib/Tactic/Basic.olean', 'Mathlib.olean'];
    for (const rel of files) {
      const full = join(src, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, `payload:${rel}`);
    }

    packLibrary({
      libDir: src,
      files,
      outDir: packedDir,
      prefix: 'lean-mathlib-64',
      chunkBytes: 32,
      level: 1,
    });

    const result = unpackPackedLib({
      indexPath: join(packedDir, 'lean-mathlib-64.index.json'),
      outDir: unpackedDir,
    });

    expect(result.files).toBe(3);
    for (const rel of files) {
      expect(readFileSync(join(unpackedDir, rel), 'utf8')).toBe(`payload:${rel}`);
    }
  });
});
