import { describe, expect, it } from 'vitest';
import {
  classifyPath,
  parseNumstat,
  renderReport,
  summarizeDiff,
  type DiffEntry,
} from './audit-upstream-diff.ts';

describe('classifyPath', () => {
  it('Lean 核心库（Init / Std / Lean）归 lean-core', () => {
    expect(classifyPath('src/Lean/Meta/WHNF.lean')).toBe('lean-core');
    expect(classifyPath('src/Init/Data/Nat/Basic.lean')).toBe('lean-core');
    expect(classifyPath('src/Std/Data/HashMap.lean')).toBe('lean-core');
  });

  it('C++ 运行时与适配层归 runtime', () => {
    expect(classifyPath('src/runtime/thread.cpp')).toBe('runtime');
    expect(classifyPath('src/kernel/replace_fn.cpp')).toBe('runtime');
    expect(classifyPath('src/include/lean/lean.h')).toBe('runtime');
  });

  it('构建文件归 engine，其它归 other', () => {
    expect(classifyPath('src/CMakeLists.txt')).toBe('engine');
    expect(classifyPath('src/README.md')).toBe('other');
  });
});

describe('summarizeDiff', () => {
  const entries: DiffEntry[] = [
    { path: 'src/runtime/thread.cpp', added: 4, deleted: 2 },
    { path: 'src/CMakeLists.txt', added: 10, deleted: 1 },
  ];

  it('有 runtime 改动时分级为 runtime', () => {
    const audit = summarizeDiff(entries);
    expect(audit.tier).toBe('runtime');
    expect(audit.totalFiles).toBe(2);
    expect(audit.added).toBe(14);
    expect(audit.deleted).toBe(3);
    expect(audit.groups.map((group) => group.layer)).toEqual(['runtime', 'engine']);
  });

  it('触及 Lean 核心时升级为 lean-core', () => {
    const audit = summarizeDiff([
      ...entries,
      { path: 'src/Lean/Meta/WHNF.lean', added: 7, deleted: 3 },
    ]);
    expect(audit.tier).toBe('lean-core');
    expect(audit.groups[0]?.layer).toBe('lean-core');
  });

  it('只有构建文件时为 engine，完全没有改动时为 light', () => {
    expect(summarizeDiff([entries[1] as DiffEntry]).tier).toBe('engine');
    expect(summarizeDiff([]).tier).toBe('light');
  });
});

describe('parseNumstat', () => {
  it('解析普通行，二进制文件按 0 行计', () => {
    const parsed = parseNumstat('12\t3\tsrc/runtime/io.cpp\n-\t-\tsrc/assets/blob.bin\n');
    expect(parsed).toEqual([
      { path: 'src/runtime/io.cpp', added: 12, deleted: 3 },
      { path: 'src/assets/blob.bin', added: 0, deleted: 0 },
    ]);
  });

  it('路径里的制表符不会被吞掉', () => {
    expect(parseNumstat('1\t1\tsrc/weird\tname.lean\n')[0]?.path).toBe('src/weird\tname.lean');
  });

  it('增删行数非法时直接报错，不静默按 0 处理', () => {
    expect(() => parseNumstat('abc\t1\tsrc/x.cpp\n')).toThrowError(/非法/);
  });
});

describe('renderReport', () => {
  it('lean-core 分级会提示必须跑 deep 门禁', () => {
    const audit = summarizeDiff([{ path: 'src/Lean/Meta/WHNF.lean', added: 7, deleted: 3 }]);
    const report = renderReport(audit, 'v4.36.0');
    expect(report).toContain('相对上游 v4.36.0');
    expect(report).toContain('**lean-core**');
    expect(report).toContain('mode=deep');
    expect(report).toContain('src/Lean/Meta/WHNF.lean');
    expect(report).toContain('+7 / -3');
  });

  it('无改动时给出 light 结论', () => {
    const report = renderReport(summarizeDiff([]), 'v4.36.0');
    expect(report).toContain('完全一致');
    expect(report).toContain('**分级：light**');
  });

  it('提供增量审计 changeAudit 时追加增量分级与深门禁提示', () => {
    const cumulative = summarizeDiff([{ path: 'src/Lean/Meta/WHNF.lean', added: 7, deleted: 3 }]);
    const lightDelta = summarizeDiff([]);
    const lightReport = renderReport(cumulative, 'v4.36.0', lightDelta, 'abc1234');
    expect(lightReport).toContain('本次变更增量分级（相对 abc1234）');
    expect(lightReport).toContain('增量分级：**light**');

    const coreDelta = summarizeDiff([
      { path: 'src/Init/Data/Nat/Basic.lean', added: 2, deleted: 0 },
    ]);
    const coreReport = renderReport(cumulative, 'v4.36.0', coreDelta, 'def5678');
    expect(coreReport).toContain('增量分级：**lean-core**');
    expect(coreReport).toContain('自动升级触发 `deep`');
  });
});
