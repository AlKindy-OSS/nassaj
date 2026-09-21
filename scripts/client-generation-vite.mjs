import { readdirSync, readFileSync, writeFileSync, openSync, closeSync, fstatSync, constants, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Return a validated, input-derived generation URL prefix (legacy builds stay root). */
export function generationBase(generationId) {
  if (!generationId) return '/';
  if (!/^[a-f0-9]{64}$/.test(generationId)) throw new Error('Invalid client generation ID');
  return `/assets/generations/${generationId}/`;
}

/** Enumerate regular public assets without following symlinks. */
export function publicAssetPaths(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Public asset symlink: ${path}`);
    if (entry.isDirectory()) return publicAssetPaths(join(directory, entry.name), `${path}/`);
    if (!entry.isFile()) throw new Error(`Non-regular public asset: ${path}`);
    return [path];
  });
}

/** Rewrite only complete root-relative references to known static public files. */
export function rewritePublicReferences(source, paths, base) {
  if (base === '/') return source;
  const known = new Set(paths.filter(path => !['sw.js', 'version.json', 'index.html', 'manifest.json'].includes(path)));
  return source.replace(/(["'`(])\/(?!\/)([^"'`()\s?#]+)([?#][^"'`()\s]*)?(?=["'`)])/g,
    (match, before, path, suffix = '') => known.has(path) ? `${before}${base}${path}${suffix}` : match);
}

/** Replace a copied public file without modifying read-only source permissions. */
function rewriteCopiedPublicFile(target, rewrite) {
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let original;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe copied public asset');
    original = readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
  const updated = rewrite(original);
  if (updated === original) return;
  const scratch = mkdtempSync(join(dirname(target), '.generation-rewrite-'));
  try {
    const replacement = join(scratch, 'asset');
    writeFileSync(replacement, updated, { flag: 'wx', mode: 0o644 });
    renameSync(replacement, target);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Vite integration covers source literals, CSS, HTML, and copied public metadata. */
export function clientGenerationAssets({ publicDirectory, generationId }) {
  const base = generationBase(generationId);
  const paths = publicAssetPaths(publicDirectory);
  const rewrite = source => rewritePublicReferences(source, paths, base);
  return {
    name: 'nassaj-client-generation-assets',
    apply: 'build',
    enforce: 'pre',
    transform(source, id) {
      if (base === '/' || id.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|css)(?:\?|$)/.test(id)) return null;
      const code = rewrite(source);
      return code === source ? null : { code, map: null };
    },
    // Vite itself prefixes public links; restore the dynamic branding endpoint last.
    transformIndexHtml: { order: 'post', handler: html => rewrite(html).replaceAll(`${base}manifest.json`, '/manifest.json') },
    writeBundle(options) {
      if (base === '/') return;
      for (const path of paths) {
        if (!/\.(?:json|webmanifest|css|svg|js|html)$/.test(path)) continue;
        const target = join(options.dir, path);
        rewriteCopiedPublicFile(target, rewrite);
      }
    },
  };
}
