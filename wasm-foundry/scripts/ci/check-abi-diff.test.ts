import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PINNED_PRIVATE_ABI_SYMBOLS,
  collectExternalSymbolRefs,
  diffExportSymbols,
  isInternalCompilerSymbol,
  parseAbiDiffOptions,
  parseLeanExportSymbols,
} from './check-abi-diff.ts';

describe('check-abi-diff (Layer 4)', () => {
  it('parseLeanExportSymbols 正确解析原型、多行函数定义（去形参名）与导出变量', () => {
    const cSrc = [
      'LEAN_EXPORT lean_object* l_Lean_Meta_whnfCore(lean_object*, lean_object*, lean_object*, lean_object*, lean_object*);',
      'LEAN_EXPORT uint8_t l_Lean_Meta_hasSmartUnfoldingDecl(',
      '    lean_object* v_env_1_,',
      '    lean_object* v_n_2_,',
      '    size_t v_idx_3_',
      ') {',
      '  return 0;',
      '}',
      'LEAN_EXPORT const lean_object* l_Lean_Meta_smartUnfoldingSuffix = (const lean_object*)&x;',
      'LEAN_EXPORT lean_object* l___private_Lean_Meta_WHNF_0__Lean_Meta_whnfCore_go(lean_object*, lean_object*);',
      'LEAN_EXPORT lean_object* l_noParams(void);',
    ].join('\n');

    const map = parseLeanExportSymbols(cSrc);
    expect(map.get('l_Lean_Meta_whnfCore')).toEqual({
      name: 'l_Lean_Meta_whnfCore',
      kind: 'fn',
      returnType: 'lean_object*',
      paramTypes: ['lean_object*', 'lean_object*', 'lean_object*', 'lean_object*', 'lean_object*'],
      isPrivate: false,
    });
    expect(map.get('l_Lean_Meta_hasSmartUnfoldingDecl')).toEqual({
      name: 'l_Lean_Meta_hasSmartUnfoldingDecl',
      kind: 'fn',
      returnType: 'uint8_t',
      paramTypes: ['lean_object*', 'lean_object*', 'size_t'],
      isPrivate: false,
    });
    expect(map.get('l_Lean_Meta_smartUnfoldingSuffix')).toEqual({
      name: 'l_Lean_Meta_smartUnfoldingSuffix',
      kind: 'var',
      returnType: 'const lean_object*',
      paramTypes: [],
      isPrivate: false,
    });
    expect(map.get('l___private_Lean_Meta_WHNF_0__Lean_Meta_whnfCore_go')?.isPrivate).toBe(true);
    expect(map.get('l_noParams')?.paramTypes).toEqual([]);
  });

  it('isInternalCompilerSymbol 精确区分公开 ABI 与内部/特化/闭包符号', () => {
    expect(isInternalCompilerSymbol('l_Lean_Meta_whnfCore')).toBe(false);
    expect(isInternalCompilerSymbol('l_Lean_Meta_Simp_simpLoop___boxed')).toBe(false);
    expect(isInternalCompilerSymbol('lean_simp')).toBe(false);
    expect(isInternalCompilerSymbol('l___private_Lean_Meta_WHNF_0__Lean_Meta_whnfCore_go')).toBe(
      true,
    );
    expect(
      isInternalCompilerSymbol('l_Lean_SMap_find_x3f___at___00Lean_Meta_Simp_simpLoop_spec__4'),
    ).toBe(true);
    expect(isInternalCompilerSymbol('l_Lean_Meta_simpGoal___lam__0')).toBe(true);
  });

  it('collectExternalSymbolRefs 识别其他 .c 文件中的跨模块引用（含 ComputedFields.c 风格声明）', () => {
    const files = new Map<string, string>([
      [
        'Lean/Meta/WHNF.c',
        'LEAN_EXPORT lean_object* l___private_Lean_Meta_WHNF_0__Lean_Meta_whnfCore_go(lean_object*);',
      ],
      [
        'Lean/Elab/ComputedFields.c',
        [
          'static lean_object* helper_local(lean_object*);',
          'lean_object* l___private_Lean_Meta_WHNF_0__Lean_Meta_whnfCore_go(lean_object*, lean_object*);',
          'extern lean_object* l___private_Other_0__helper(lean_object*);',
        ].join('\n'),
      ],
    ]);

    const refs = collectExternalSymbolRefs(files, new Set(['Lean/Meta/WHNF.c']));
    expect(refs.has('l___private_Lean_Meta_WHNF_0__Lean_Meta_whnfCore_go')).toBe(true);
    expect(refs.has('l___private_Other_0__helper')).toBe(true);
    expect(refs.has('helper_local')).toBe(false);
  });

  it('diffExportSymbols 拦截公开符号、pinned private 符号和跨模块引用符号的删除或变参，放行纯局部内部重构', () => {
    const base = parseLeanExportSymbols(
      [
        'LEAN_EXPORT lean_object* l_Lean_Meta_Simp_simpLoop(lean_object*, lean_object*);',
        `LEAN_EXPORT lean_object* ${PINNED_PRIVATE_ABI_SYMBOLS[0]}(lean_object*, lean_object*);`,
        'LEAN_EXPORT lean_object* l___private_LocalOnly_0__helper(lean_object*);',
        'LEAN_EXPORT lean_object* l___private_UsedElsewhere_0__hook(lean_object*);',
      ].join('\n'),
    );

    // 1. 纯局部内部符号删除 + 新增 simpLoopStep：允许且记录到 internalChanges / addedSymbols
    const safeFork = parseLeanExportSymbols(
      [
        'LEAN_EXPORT lean_object* l_Lean_Meta_Simp_simpLoop(lean_object* v_e_1_, lean_object* v_s_2_) { return 0; }',
        `LEAN_EXPORT lean_object* ${PINNED_PRIVATE_ABI_SYMBOLS[0]}(lean_object*, lean_object*);`,
        'LEAN_EXPORT lean_object* l___private_UsedElsewhere_0__hook(lean_object*);',
        'LEAN_EXPORT lean_object* l___private_LocalOnly_0__simpLoopStep(lean_object*, lean_object*);',
      ].join('\n'),
    );
    const safeReport = diffExportSymbols('Simp/Main.lean', base, safeFork, {
      externalRefs: new Set(['l___private_UsedElsewhere_0__hook']),
    });
    expect(safeReport.breakingChanges).toEqual([]);
    expect(safeReport.internalChanges).toHaveLength(1);
    expect(safeReport.addedSymbols).toEqual(['l___private_LocalOnly_0__simpLoopStep']);

    // 2. 删除 pinned private 或改动公开参数个数 -> 破坏性变更报错
    const brokenFork = parseLeanExportSymbols(
      [
        'LEAN_EXPORT lean_object* l_Lean_Meta_Simp_simpLoop(lean_object*);',
        'LEAN_EXPORT lean_object* l___private_UsedElsewhere_0__hook(lean_object*, uint8_t);',
      ].join('\n'),
    );
    const brokenReport = diffExportSymbols('WHNF.lean', base, brokenFork, {
      externalRefs: new Set(['l___private_UsedElsewhere_0__hook']),
    });
    expect(
      brokenReport.breakingChanges.map((c) => `${c.classification}:${c.symbol}:${c.reason}`),
    ).toEqual([
      'public:l_Lean_Meta_Simp_simpLoop:signature_changed',
      `pinned_private:${PINNED_PRIVATE_ABI_SYMBOLS[0]}:removed`,
      'external_ref:l___private_UsedElsewhere_0__hook:signature_changed',
    ]);
  });

  it('parseAbiDiffOptions 解析参数与可选字段', () => {
    const root = mkdtempSync(join(tmpdir(), 'abi-diff-opt-'));
    const bootLean = join(root, 'lean');
    const bootLib = join(root, 'lib');
    const repo = join(root, 'repo');
    const cgen = join(root, 'cgen');
    writeFileSync(bootLean, '');
    mkdirSync(bootLib);
    mkdirSync(repo);
    mkdirSync(cgen);

    const parsed = parseAbiDiffOptions([
      '--boot-lean',
      bootLean,
      '--boot-lib',
      bootLib,
      '--repo',
      repo,
      '--cgen-dir',
      cgen,
      '--files',
      'src/Lean/Meta/WHNF.lean,src/Lean/Meta/Tactic/Simp/Main.lean',
      '--strict-internal',
      '--timeout',
      '60000',
    ]);
    expect(parsed.baseRef).toBe('v4.36.0');
    expect(parsed.strictInternal).toBe(true);
    expect(parsed.timeoutMs).toBe(60_000);
    expect(parsed.files).toEqual([
      'src/Lean/Meta/WHNF.lean',
      'src/Lean/Meta/Tactic/Simp/Main.lean',
    ]);
  });
});
