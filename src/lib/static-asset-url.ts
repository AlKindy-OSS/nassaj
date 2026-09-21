declare const __PUBLIC_ASSET_PATHS__: string[];

/** Address bundled public images at render time without changing stored user values. */
export function staticAssetUrl<T extends string | null | undefined>(value: T): T | string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return value;
  const path = value.split(/[?#]/, 1)[0].slice(1);
  const paths = typeof __PUBLIC_ASSET_PATHS__ === 'undefined' ? [] : __PUBLIC_ASSET_PATHS__;
  return paths.includes(path) ? `${import.meta.env.BASE_URL}${value.slice(1)}` : value;
}
