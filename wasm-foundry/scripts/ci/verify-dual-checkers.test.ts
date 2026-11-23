import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import {
  CERT_THEOREM_NAMES,
  DEFAULT_PERMITTED_AXIOMS,
  buildCertificateProofCorpus,
  buildNanodaConfig,
  buildTamperedAxiomCorpus,
  parseDualCheckerOptions,
  runDualCheckerSuite,
} from './verify-dual-checkers.ts';

describe('verify-dual-checkers (Layer 3B)', () => {
  it('证书语料仅依赖 Init、覆盖关键路径且不含 sorry，反例语料含 sorry', () => {
    const cert = buildCertificateProofCorpus();
    expect(cert).toContain('import Init');
    expect(cert).not.toContain('import Lean');
    expect(cert).not.toContain('sorry');
    expect(cert).not.toContain('native_decide');
    for (const thm of CERT_THEOREM_NAMES) {
      expect(cert).toContain(`theorem ${thm}`);
    }

    const tampered = buildTamperedAxiomCorpus();
    expect(tampered).toContain('theorem cert_bad_sorry');
    expect(tampered).toContain('sorry');
  });

  it('buildNanodaConfig 产出符合 nanoda_bin 规范的配置且仅放行标准三大公理', () => {
    const cfg = buildNanodaConfig('/tmp/cert.ndjson');
    expect(cfg).toEqual({
      export_file_path: '/tmp/cert.ndjson',
      use_stdin: false,
      num_threads: 2,
      stack_size_bytes: 67_108_864,
      permitted_axioms: [...DEFAULT_PERMITTED_AXIOMS],
      unpermitted_axiom_hard_error: false,
      nat_extension: true,
      string_extension: true,
      print_success_message: true,
    });
  });

  it('runDualCheckerSuite 串联 C++ leanchecker + leanexport + Rust nanoda_bin 与 sorry 反例校验', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const report = runDualCheckerSuite(
      {
        oleanDir: '/tmp/oleans',
        moduleName: 'CertProofs',
        bootLib: '/tmp/boot/lib/lean',
        theorems: CERT_THEOREM_NAMES,
        leanchecker: '/tmp/bin/leanchecker',
        leanexport: '/tmp/bin/leanexport',
        nanoda: '/tmp/bin/nanoda_bin',
        rejectModuleName: 'CertRejectSorry',
        rejectTheorems: ['cert_bad_sorry'],
        externalCheckerCmd: '/tmp/bin/custom-checker',
        timeoutMs: 30_000,
      },
      (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === '/tmp/bin/leanexport') {
          return { status: 0, stdout: '{"meta":{}}\n', stderr: '' };
        }
        if (cmd === '/tmp/bin/nanoda_bin' && args[0]?.includes('nanoda-reject-config')) {
          return { status: 1, stdout: '', stderr: 'unpermitted axiom sorryAx' };
        }
        return { status: 0, stdout: 'ok\n', stderr: '' };
      },
    );

    expect(report).toEqual({
      moduleName: 'CertProofs',
      leancheckerFreshPassed: true,
      leancheckerFromExportPassed: true,
      nanodaPassed: true,
      negativeAxiomRejected: true,
      externalCheckerPassed: true,
    });
    expect(calls[0]).toEqual({ cmd: '/tmp/bin/leanchecker', args: ['--fresh', 'CertProofs'] });
    expect(calls[1]).toEqual({
      cmd: '/tmp/bin/leanexport',
      args: ['CertProofs', '--', ...CERT_THEOREM_NAMES],
    });
    expect(calls[2]?.cmd).toBe('/tmp/bin/leanchecker');
    expect(calls[2]?.args[0]).toBe('--from-export');
    expect(calls[3]?.cmd).toBe('/tmp/bin/nanoda_bin');
    expect(calls[4]?.cmd).toBe('/tmp/bin/leanexport');
    expect(calls[5]?.cmd).toBe('/tmp/bin/nanoda_bin');
    expect(calls[6]?.cmd).toBe('/tmp/bin/custom-checker');
  });

  it('当任意检验器失败或 nanoda 误放行 sorryAx 时立刻阻断', () => {
    expect(() =>
      runDualCheckerSuite(
        {
          oleanDir: '/tmp/oleans',
          moduleName: 'CertProofs',
          bootLib: '/tmp/boot/lib/lean',
          theorems: CERT_THEOREM_NAMES,
          leanchecker: '/tmp/bin/leanchecker',
          timeoutMs: 10_000,
        },
        () => ({ status: 1, stdout: '', stderr: 'kernel type error' }),
      ),
    ).toThrow(/leanchecker --fresh[\s\S]*kernel type error/);

    expect(() =>
      runDualCheckerSuite(
        {
          oleanDir: '/tmp/oleans',
          moduleName: 'CertProofs',
          bootLib: '/tmp/boot/lib/lean',
          theorems: CERT_THEOREM_NAMES,
          leanexport: '/tmp/bin/leanexport',
          nanoda: '/tmp/bin/nanoda_bin',
          rejectModuleName: 'CertRejectSorry',
          timeoutMs: 10_000,
        },
        (cmd) => {
          if (cmd === '/tmp/bin/leanexport')
            return { status: 0, stdout: '{"meta":{}}\n', stderr: '' };
          // 故意假绿返回 0 -> 必须被 sanity check 拦下
          return { status: 0, stdout: 'accepted everything', stderr: '' };
        },
      ),
    ).toThrow(/sanity check 违背/);
  });

  it('parseDualCheckerOptions 校验必填参数组合', () => {
    const root = mkdtempSync(join(tmpdir(), 'dual-chk-opt-'));
    const oleanDir = join(root, 'oleans');
    const bootLib = join(root, 'lib');
    const leanexport = join(root, 'leanexport');
    const nanoda = join(root, 'nanoda_bin');
    mkdirSync(oleanDir);
    mkdirSync(bootLib);
    writeFileSync(leanexport, '');
    writeFileSync(nanoda, '');

    expect(() =>
      parseDualCheckerOptions([
        '--olean-dir',
        oleanDir,
        '--module',
        'CertProofs',
        '--boot-lib',
        bootLib,
      ]),
    ).toThrow(CliError);

    expect(() =>
      parseDualCheckerOptions([
        '--olean-dir',
        oleanDir,
        '--module',
        'CertProofs',
        '--boot-lib',
        bootLib,
        '--nanoda',
        nanoda,
      ]),
    ).toThrow(/--leanexport/);

    const opts = parseDualCheckerOptions([
      '--olean-dir',
      oleanDir,
      '--module',
      'CertProofs',
      '--boot-lib',
      bootLib,
      '--leanexport',
      leanexport,
      '--nanoda',
      nanoda,
    ]);
    expect(opts.theorems).toEqual(CERT_THEOREM_NAMES);
    expect(opts.timeoutMs).toBe(180_000);
  });
});
