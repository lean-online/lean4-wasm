import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: [
        'scripts/lib/**/*.ts',
        'scripts/lib/**/*.mjs',
        'scripts/*.ts',
        'scripts/ci/**/*.ts',
      ],
      exclude: [
        'scripts/**/*.test.ts',
        'scripts/**/*.test.mjs',
        // 下面的脚本主体是启动 wasm/pthread 与真实浏览器/LSP 会话；
        // 单测只覆盖其中可导出的纯函数，整体行数不计入阈值（避免用假 wasm 刷覆盖率）。
        'scripts/wasm64-lsp-worker.ts',
        'scripts/wasm64-lsp-browser-worker.ts',
        'scripts/wasm64-lsp-diagnostics.ts',
        'scripts/wasm64-lsp-handshake.ts',
        'scripts/wasm64-browser-verify.ts',
        'scripts/wasm64-browser-harness.ts',
      ],
      thresholds: {
        lines: 75,
        statements: 75,
        branches: 60,
        functions: 60,
      },
    },
  },
});
