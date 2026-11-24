// 第 2 层门禁：固定种子的确定性 Expr DAG + WHNF.Config 差分 Fuzzing 生成器。
// 所有随机决策均由 Mulberry32 PRNG 在 TypeScript 侧确定性展开，生成可独立编译运行的 Lean 4.36.0 语料，
// 确保相同种子跨平台产生完全一致的用例，并在官方 Linux Lean 与软 Fork / wasm64 间逐字节对比输出。

export const DEFAULT_FUZZ_SEED = 20260436;
export const DEFAULT_WASM_FUZZ_CASES = 48;
export const DEFAULT_NATIVE_FUZZ_CASES = 300;

/** Mulberry32 确定性 32 位伪随机数生成器（返回 [0, 1) 浮点数）。 */
export const createMulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(rng: () => number, items: readonly T[]): T => {
  const index = Math.floor(rng() * items.length) % items.length;
  return items[index] as T;
};

const randInt = (rng: () => number, minInclusive: number, maxInclusive: number): number =>
  minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));

const assertPositiveInt = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，收到 ${value}`);
  }
};

const BINDER_INFOS = ['.default', '.implicit', '.strictImplicit', '.instImplicit'] as const;

const TRANSPARENCY_MODES = ['.all', '.default', '.reducible', '.instances'] as const;

const PROJ_MODES = ['.no', '.yes', '.yesWithDelta', '.yesWithDeltaI'] as const;

const BATCH_SIZE = 50;

const chunkArray = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/**
 * 构造覆盖全部 Expr 构造器、共享 DAG 菱形节点（`is_shared` 缓存命中）、非共享节点（`wants_cache=false`）
 * 与多层 binder `offset + 1` 的确定性 Lean 代码段。
 */
export const buildExprDagFuzzSection = (seed: number, count: number): string => {
  assertPositiveInt(count, 'exprCases');
  const rng = createMulberry32(seed >>> 0);
  const caseExprs: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const bi0 = pick(rng, BINDER_INFOS);
    const bi1 = pick(rng, BINDER_INFOS);
    const nondep = rng() < 0.5 ? 'true' : 'false';
    const natVal = randInt(rng, 0, 99);
    const projIdx = randInt(rng, 0, 1);
    const depth = randInt(rng, 2, 5);
    const universe = rng() < 0.5 ? '(.succ u)' : 'u';
    const diamond = rng() < 0.7;

    // 所有 .bvar 索引严格不超过外层绑定深度，确保闭合同时又能命中深层 offset + 1 路径。
    let coreExpr = `(.app (.app (.const \`Nat.add []) (.lit (.natVal ${natVal}))) (.const \`Nat.zero []))`;
    if (rng() < 0.5) {
      coreExpr = `(.app (.const \`id [v]) (.lit (.strVal "f${i}")))`;
    }
    const baseShared = diamond
      ? `(.app (.app (.const \`Nat.add []) s0) (.mdata {} (.proj \`Prod ${projIdx} (.app s0 s1))))`
      : `(.mdata {} (.proj \`Prod ${projIdx} ${coreExpr}))`;

    let wrapped = baseShared;
    for (let d = 0; d < depth; d += 1) {
      const bindMod = d % 3;
      const binderBi = d % 2 === 0 ? bi0 : bi1;
      const outerBvar = Math.min(d, 2);
      if (bindMod === 0) {
        wrapped = `(.lam \`x${d} (.const \`Nat []) (.app (.app (.const \`Nat.add []) (.bvar ${outerBvar})) ${wrapped}) ${binderBi})`;
      } else if (bindMod === 1) {
        wrapped = `(.forallE \`t${d} (.sort ${universe}) (.app (.app (.const \`Nat.add []) (.bvar 0)) ${wrapped}) ${binderBi})`;
      } else {
        wrapped = `(.letE \`v${d} (.const \`Nat []) (.app s1 (.const \`Nat.zero [])) ${wrapped} ${nondep})`;
      }
    }

    caseExprs.push(
      [
        'do',
        '      let u : Level := .param `u',
        '      let v : Level := .param `v',
        `      let s0 : Expr := .app (.const \`Nat.succ []) ${i % 2 === 0 ? '(.const `Nat.zero [])' : 'fv'}`,
        `      let s1 : Expr := ${rng() < 0.5 ? '(.lam `y (.const `Nat []) (.app s0 (.bvar 0)) .default)' : 's0'}`,
        `      let e : Expr := ${wrapped}`,
        '      pure e',
      ].join('\n'),
    );
  }

  const batches = chunkArray(caseExprs, BATCH_SIZE);
  const batchDefs: string[] = [];
  const accLines: string[] = [];

  batches.forEach((batch, batchIdx) => {
    const fnName = `fuzzExprBatch${batchIdx}`;
    const body = batch
      .map((exprBlock, offset) => {
        const globalIdx = batchIdx * BATCH_SIZE + offset;
        return `    let e${globalIdx} ← (${exprBlock.replace(/\n {6}/g, '\n      ')})`;
      })
      .join('\n');
    const items = batch.map((_, offset) => `e${batchIdx * BATCH_SIZE + offset}`).join(', ');
    batchDefs.push(
      `private def ${fnName} (fv : Expr) : List Expr :=`,
      '  Id.run do',
      body,
      `    return [${items}]`,
      '',
    );
    accLines.push(`    acc := acc ++ (${fnName} fv).toArray`);
  });

  const lines: string[] = [
    `-- Expr DAG Fuzz Section (seed=${seed}, count=${count})`,
    ...batchDefs,
    'private def buildFuzzExprs (fv : Expr) : List Expr :=',
    '  Id.run do',
    '    let mut acc : Array Expr := #[]',
    ...accLines,
    '    return acc.toList',
    '',
    'private def runExprDagFuzz : MetaM Unit := do',
    '  withLocalDeclD `fuzzFv (.const `Nat []) fun fv => do',
    '    let mut idx := 0',
    '    for e in buildFuzzExprs fv do',
    '      let replaced := e.replace fun sub =>',
    '        if sub.isConstOf `Nat.zero then some (.const `zeroAlt []) else none',
    '      let noop := e.replace fun _ => none',
    '      let inst := e.instantiateLevelParams [`u, `v] [.one, .succ .one]',
    '      let absInst := (e.abstract #[fv]).instantiate #[fv]',
    '      IO.println s!"fuzz_expr[{idx}]={e == noop},{e != replaced},{replaced.hash},{inst.hash},{e == absInst}"',
    '      idx := idx + 1',
    '',
    '#eval show MetaM Unit from runExprDagFuzz',
    '',
  ];

  return lines.join('\n');
};

export interface WhnfFuzzCaseSpec {
  readonly index: number;
  readonly transparency: (typeof TRANSPARENCY_MODES)[number];
  readonly beta: boolean;
  readonly zeta: boolean;
  readonly zetaHave: boolean;
  readonly zetaUnused: boolean;
  readonly zetaDelta: boolean;
  readonly iota: boolean;
  readonly proj: (typeof PROJ_MODES)[number];
  readonly targetKind: number;
}

/** 生成确定性的 WHNF TransparencyMode × Meta.Config 组合规格列表。 */
export const generateWhnfFuzzSpecs = (seed: number, count: number): WhnfFuzzCaseSpec[] => {
  assertPositiveInt(count, 'whnfCases');
  // 使用偏移盐避免与 Expr 生成器共用同一序列位置。
  const rng = createMulberry32((seed ^ 0x9e3779b9) >>> 0);
  const specs: WhnfFuzzCaseSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    specs.push({
      index: i,
      transparency: pick(rng, TRANSPARENCY_MODES),
      beta: rng() < 0.6,
      zeta: rng() < 0.65,
      zetaHave: rng() < 0.55,
      zetaUnused: rng() < 0.5,
      zetaDelta: rng() < 0.6,
      iota: rng() < 0.7,
      proj: pick(rng, PROJ_MODES),
      targetKind: i < 8 ? i : randInt(rng, 0, 7),
    });
  }
  return specs;
};

/** 构造覆盖 WHNF TransparencyMode × Meta.Config × 8 类表达式形态的确定性 Lean 差分代码段。 */
export const buildWhnfConfigFuzzSection = (seed: number, count: number): string => {
  const specs = generateWhnfFuzzSpecs(seed, count);
  const batches = chunkArray(specs, BATCH_SIZE);

  const lines: string[] = [
    `-- WHNF Config Fuzz Section (seed=${seed}, count=${count})`,
    'def fuzzMkFun : Nat → Nat → Nat := fun k x => x + k',
    'structure FuzzBox where',
    '  fst : Nat',
    '  snd : Nat',
    'def fuzzWrapBox (n : Nat) : FuzzBox := ⟨n + 1, n + 2⟩',
    'def fuzzStepMatch : Nat → Nat',
    '  | 0 => 10',
    '  | k + 1 => k + 20',
    '',
    'private structure WhnfFuzzSpec where',
    '  idx        : Nat',
    '  mode       : TransparencyMode',
    '  beta       : Bool',
    '  zeta       : Bool',
    '  zetaHave   : Bool',
    '  zetaUnused : Bool',
    '  zetaDelta  : Bool',
    '  iota       : Bool',
    '  proj       : ProjReductionKind',
    '  kind       : Nat',
    '',
    'private def evalOneWhnfSpec (fv : Expr) (mv : Expr) (s : WhnfFuzzSpec) : MetaM Unit := do',
    '  let target : Expr := match s.kind with',
    '    | 0 => .proj `FuzzBox 0 (.app (.const `fuzzWrapBox []) (.lit (.natVal 4)))',
    '    | 1 => .proj `FuzzBox 1 (.app (.const `fuzzWrapBox []) (.lit (.natVal 7)))',
    '    | 2 => .app (.app (.const `fuzzMkFun []) (.lit (.natVal 5))) (.lit (.natVal 2))',
    '    | 3 => .app (.lam `x (.const `Nat []) (.bvar 0) .default) (.lit (.natVal 9))',
    '    | 4 => .letE `a (.const `Nat []) (.lit (.natVal 3)) (.app (.app (.const `Nat.add []) (.bvar 0)) (.lit (.natVal 1))) true',
    '    | 5 => .letE `u (.const `Nat []) (.lit (.natVal 8)) (.lit (.natVal 11)) true',
    '    | 6 => .mdata {} (.app (.const `fuzzStepMatch []) (.lit (.natVal 2)))',
    '    | _ => .app (.app (.const `Nat.add []) fv) mv',
    '  let (coreOut, fullOut, tracked) ← withTransparency s.mode <| withConfig (fun c => {',
    '    c with',
    '      beta := s.beta',
    '      zeta := s.zeta',
    '      zetaHave := s.zetaHave',
    '      zetaUnused := s.zetaUnused',
    '      zetaDelta := s.zetaDelta',
    '      iota := s.iota',
    '      proj := s.proj',
    '  }) <| withTrackingZetaDelta do',
    '    let wCore ← whnfCore target',
    '    let wFull ← whnf target',
    '    let ids ← getZetaDeltaFVarIds',
    '    return (wCore, wFull, ids.contains fv.fvarId!)',
    '  IO.println s!"fuzz_whnf[{s.idx}]={coreOut}|{fullOut}|{tracked}"',
    '',
  ];

  const batchNames: string[] = [];
  batches.forEach((batch, bIdx) => {
    const fnName = `whnfFuzzBatch${bIdx}`;
    batchNames.push(fnName);
    lines.push(`private def ${fnName} : List WhnfFuzzSpec := [`);
    for (const s of batch) {
      lines.push(
        `  ⟨${s.index}, ${s.transparency}, ${s.beta}, ${s.zeta}, ${s.zetaHave}, ${s.zetaUnused}, ${s.zetaDelta}, ${s.iota}, ${s.proj}, ${s.targetKind}⟩,`,
      );
    }
    lines.push(']', '');
  });

  lines.push(
    'private def runWhnfConfigFuzz : MetaM Unit := do',
    '  let mv ← mkFreshExprMVar (some (.const `Nat []))',
    '  mv.mvarId!.assign (.lit (.natVal 6))',
    '  withLetDecl `wfv (.const `Nat []) (.lit (.natVal 7)) fun fv => do',
    ...batchNames.map((n) => `    for spec in ${n} do evalOneWhnfSpec fv mv spec`),
    '',
    '#eval show MetaM Unit from runWhnfConfigFuzz',
    '',
  );

  return lines.join('\n');
};

export interface FuzzCorpusOptions {
  readonly seed?: number;
  readonly exprCases?: number;
  readonly whnfCases?: number;
}

/** 构造完整第 2 层差分 Fuzzing `.lean` 语料，同时测试 Expr DAG 与 WHNF 配置组合。 */
export const buildFuzzDifferentialCorpus = (options: FuzzCorpusOptions = {}): string => {
  const seed = options.seed ?? DEFAULT_FUZZ_SEED;
  const exprCases = options.exprCases ?? DEFAULT_WASM_FUZZ_CASES;
  const whnfCases = options.whnfCases ?? DEFAULT_WASM_FUZZ_CASES;
  return [
    'import Lean',
    'set_option linter.unusedVariables false',
    '',
    'open Lean Lean.Meta',
    '',
    buildExprDagFuzzSection(seed, exprCases),
    buildWhnfConfigFuzzSection(seed, whnfCases),
  ].join('\n');
};
