import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FUZZ_SEED,
  buildExprDagFuzzSection,
  buildFuzzDifferentialCorpus,
  buildWhnfConfigFuzzSection,
  createMulberry32,
  generateWhnfFuzzSpecs,
} from './differential-fuzz.ts';

describe('differential-fuzz (Layer 2)', () => {
  it('createMulberry32 对同一种子严格确定性输出', () => {
    const r1 = createMulberry32(DEFAULT_FUZZ_SEED);
    const r2 = createMulberry32(DEFAULT_FUZZ_SEED);
    const r3 = createMulberry32(DEFAULT_FUZZ_SEED + 1);
    const seq1 = Array.from({ length: 16 }, () => r1());
    const seq2 = Array.from({ length: 16 }, () => r2());
    const seq3 = Array.from({ length: 16 }, () => r3());
    expect(seq1).toEqual(seq2);
    expect(seq1).not.toEqual(seq3);
  });

  it('buildFuzzDifferentialCorpus 同种子字节一致且不同种子有差异', () => {
    const a = buildFuzzDifferentialCorpus({ seed: 20260436, exprCases: 12, whnfCases: 12 });
    const b = buildFuzzDifferentialCorpus({ seed: 20260436, exprCases: 12, whnfCases: 12 });
    const c = buildFuzzDifferentialCorpus({ seed: 20260437, exprCases: 12, whnfCases: 12 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('buildExprDagFuzzSection 覆盖所有 Expr 构造器与 BinderInfo，且分批组织大用例', () => {
    const src = buildExprDagFuzzSection(DEFAULT_FUZZ_SEED, 65);
    expect(src).toContain('fuzzExprBatch0');
    expect(src).toContain('fuzzExprBatch1');
    for (const marker of [
      '.default',
      '.implicit',
      '.strictImplicit',
      '.instImplicit',
      '.lam',
      '.forallE',
      '.letE',
      '.mdata',
      '.proj',
      '.lit (.natVal',
      '.lit (.strVal',
      '.sort',
      'e.replace',
      'e.instantiateLevelParams',
      'e.abstract',
      '.instantiate',
    ]) {
      expect(src).toContain(marker);
    }
  });

  it('count=300（6 个批次）时所有 fuzzExprBatch 均定义在 buildFuzzExprs 之前且无嵌套 def', () => {
    const src = buildExprDagFuzzSection(DEFAULT_FUZZ_SEED, 300);
    const buildIdx = src.indexOf('private def buildFuzzExprs');
    const runIdx = src.indexOf('private def runExprDagFuzz');
    expect(buildIdx).toBeGreaterThan(0);
    expect(runIdx).toBeGreaterThan(buildIdx);

    const buildBody = src.slice(buildIdx + 'private def buildFuzzExprs'.length, runIdx);
    expect(buildBody).not.toContain('private def');

    for (let k = 0; k < 6; k += 1) {
      const defMarker = `private def fuzzExprBatch${k}`;
      const defIdx = src.indexOf(defMarker);
      expect(defIdx).toBeGreaterThanOrEqual(0);
      expect(defIdx).toBeLessThan(buildIdx);
      expect(buildBody).toContain(`fuzzExprBatch${k} fv`);
    }
  });

  it('buildFuzzDifferentialCorpus 关闭 unusedVariables linter 警告', () => {
    const src = buildFuzzDifferentialCorpus({
      seed: DEFAULT_FUZZ_SEED,
      exprCases: 60,
      whnfCases: 60,
    });
    expect(src).toContain('set_option linter.unusedVariables false');
  });

  it('buildWhnfConfigFuzzSection 覆盖所有 TransparencyMode 与 ProjReductionKind', () => {
    const specs = generateWhnfFuzzSpecs(DEFAULT_FUZZ_SEED, 40);
    expect(specs).toHaveLength(40);
    const modes = new Set(specs.map((s) => s.transparency));
    const projs = new Set(specs.map((s) => s.proj));
    expect(modes).toEqual(new Set(['.all', '.default', '.reducible', '.instances']));
    expect(projs).toEqual(new Set(['.no', '.yes', '.yesWithDelta', '.yesWithDeltaI']));

    const src = buildWhnfConfigFuzzSection(DEFAULT_FUZZ_SEED, 40);
    expect(src).toContain('whnfCore target');
    expect(src).toContain('whnf target');
    expect(src).toContain('withTrackingZetaDelta');
    expect(src).toContain('mkFreshExprMVar');
  });

  it('拒绝非法用例数量', () => {
    expect(() => buildExprDagFuzzSection(1, 0)).toThrow(/正整数/);
    expect(() => generateWhnfFuzzSpecs(1, -3)).toThrow(/正整数/);
  });
});
