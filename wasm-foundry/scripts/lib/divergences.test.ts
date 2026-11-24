import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INTENTIONAL_DIVERGENCES,
  assertDivergenceRegistrySynced,
  buildDivergenceBoundaryCorpus,
  buildUpstreamTestExcludeRegex,
  extractDocumentedDivergenceIds,
} from './divergences.ts';

describe('divergences registry (Layer 5)', () => {
  it('docs/DIVERGENCES.md 与 INTENTIONAL_DIVERGENCES 保持双向同步', () => {
    const docPath = resolve(import.meta.dirname, '../../docs/DIVERGENCES.md');
    const markdown = readFileSync(docPath, 'utf8');
    expect(() => assertDivergenceRegistrySynced(markdown)).not.toThrow();
    expect(extractDocumentedDivergenceIds(markdown)).toEqual(
      INTENTIONAL_DIVERGENCES.map((entry) => entry.id),
    );
  });

  it('assertDivergenceRegistrySynced 拦截文档漏记、多记或重复编号', () => {
    expect(() => assertDivergenceRegistrySynced('# empty\n')).toThrow(/缺少差异登记条目/);
    expect(() =>
      assertDivergenceRegistrySynced('## DIV-001: simp\n\n## DIV-999: undocumented extra\n'),
    ).toThrow(/存在代码未登记条目/);
    expect(() => assertDivergenceRegistrySynced('## DIV-001: a\n\n## DIV-001: dup\n')).toThrow(
      /重复差异编号/,
    );
  });

  it('buildDivergenceBoundaryCorpus 生成 DIV-001 边界与 maxSteps 安全护栏断言', () => {
    const boundary = buildDivergenceBoundaryCorpus();
    expect(boundary.divergenceId).toBe('DIV-001');
    expect(boundary.name).toBe('DivergenceSimpRecDepth.lean');
    expect(boundary.code).toContain('set_option maxRecDepth 80');
    expect(boundary.code).toContain('maxSteps := 500');
    expect(boundary.code).toContain('maxSteps := 10');
    expect(boundary.code).toContain(boundary.expectedForkMarker);
    expect('error: maximum recursion depth has been reached').toMatch(
      boundary.expectedBootErrorPattern,
    );
  });

  it('buildUpstreamTestExcludeRegex 转义并拼接受有意差异影响的上游用例路径', () => {
    const regexStr = buildUpstreamTestExcludeRegex();
    expect(regexStr).toBe('elab/simpLoopProtection\\.lean|elab/simpDiag\\.lean');
    expect('elab/simpLoopProtection.lean').toMatch(new RegExp(`^(${regexStr})$`));
  });
});
