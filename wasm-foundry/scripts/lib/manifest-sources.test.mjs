import { describe, expect, it } from 'vitest';
import { assetSources, withCacheKey } from './manifest-sources.mjs';

const manifest = {
  cacheKey: 'z12345678',
  primary: { label: 'R2', baseUrl: '/cdn/' },
  fallback: { label: 'Release', baseUrl: 'https://example.com/releases/download/v1/' },
  mirror: {
    label: 'ModelScope',
    baseUrl: 'https://modelscope.cn/datasets/example/lean4-assets/resolve/master/',
    prefix: 'wasm-lean4/4.35.0',
  },
};

describe('manifest-sources', () => {
  it('为相对与绝对 URL 附加 ?r=cacheKey', () => {
    expect(withCacheKey('/cdn/a.mjs', 'zk1')).toBe('/cdn/a.mjs?r=zk1');
    expect(withCacheKey('/cdn/a.mjs?foo=1', 'zk1')).toBe('/cdn/a.mjs?foo=1&r=zk1');
    expect(withCacheKey('https://example.com/a.mjs', 'zk1')).toBe(
      'https://example.com/a.mjs?r=zk1',
    );
  });

  it('按主源 → 魔搭扁平镜像 → 非 zstd 回退顺序解析源列表', () => {
    const plain = { name: 'lean.mjs', key: 'wasm-lean4/4.35.0/lean.mjs', source: 'lean.mjs' };
    expect(
      assetSources(manifest, plain, 'https://site.test/cdn/', { includeMirror: true }),
    ).toEqual([
      { label: 'R2', url: 'https://site.test/cdn/wasm-lean4/4.35.0/lean.mjs?r=z12345678' },
      {
        label: 'ModelScope',
        url: 'https://modelscope.cn/datasets/example/lean4-assets/resolve/master/wasm-lean4/4.35.0/lean.mjs',
      },
      { label: 'Release', url: 'https://example.com/releases/download/v1/lean.mjs?r=z12345678' },
    ]);

    const zstd = { ...plain, encoding: 'zstd' };
    expect(assetSources(manifest, zstd, undefined, { includeMirror: false })).toEqual([
      { label: 'R2', url: '/cdn/wasm-lean4/4.35.0/lean.mjs?r=z12345678' },
    ]);
  });
});
