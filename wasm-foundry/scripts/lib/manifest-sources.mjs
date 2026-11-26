/**
 * 运行时资产发布/拉取脚本的源 URL 拼装工具（Node 构建/上传脚本专用，不依赖前端代码）。
 */

const isAbsoluteUrl = (value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

/** 给 URL 附加 revision 参数：换 revision 即换缓存键，避开旧边缘缓存变体。 */
export const withCacheKey = (rawUrl, cacheKey) => {
  if (!cacheKey) return rawUrl;
  if (!isAbsoluteUrl(rawUrl)) {
    const [path, query] = rawUrl.split('?');
    const params = new URLSearchParams(query ?? '');
    params.set('r', cacheKey);
    return `${path}?${params.toString()}`;
  }
  const url = new URL(rawUrl);
  url.searchParams.set('r', cacheKey);
  return url.href;
};

const composeUrl = (baseUrl, assetPath) => {
  if (isAbsoluteUrl(baseUrl)) {
    const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(assetPath, normalized).href;
  }
  const normalized = baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`;
  return `${normalized.endsWith('/') ? normalized : `${normalized}/`}${assetPath}`;
};

/**
 * 组装单资产的候选下载/探测 URL 列表（同源主源 → 可选魔搭镜像 → 仅 Node 构建期非 zstd 的可选归档参考，浏览器端无 Release 回退源）。
 */
export const assetSources = (manifest, asset, primaryBaseUrl, options = {}) => {
  const sources = [];
  const seen = new Set();

  const add = (label, baseUrl, assetPath, { cacheKey = true } = {}) => {
    if (!label || !baseUrl || !assetPath) return;
    const composed = composeUrl(baseUrl, assetPath);
    const url = cacheKey ? withCacheKey(composed, manifest.cacheKey) : composed;
    if (seen.has(url)) return;
    seen.add(url);
    sources.push({ label, url });
  };

  add(manifest.primary.label, primaryBaseUrl || manifest.primary.baseUrl, asset.key);

  if (options.includeMirror && manifest.mirror) {
    const prefix = manifest.mirror.prefix ?? manifest.cacheKey;
    add(manifest.mirror.label, manifest.mirror.baseUrl, `${prefix}/${asset.name}`, {
      cacheKey: false,
    });
  }

  if (asset.encoding !== 'zstd' && manifest.fallback) {
    add(manifest.fallback.label, manifest.fallback.baseUrl, asset.source);
  }

  return sources;
};
