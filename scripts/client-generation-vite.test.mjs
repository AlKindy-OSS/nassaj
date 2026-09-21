import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, chmodSync, statSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { generationBase, rewritePublicReferences, publicAssetPaths, clientGenerationAssets } from './client-generation-vite.mjs';

const id = 'a'.repeat(64);
const base = generationBase(id);
test('generation identity rejects path injection, allows legacy root', () => {
  assert.equal(generationBase(), '/');
  assert.throws(() => generationBase('../escape'));
  assert.throws(() => generationBase('A'.repeat(64)));
});
test('complete known public references retain suffixes and preserve dynamic endpoints', () => {
  const input = `"/fixed.png?v=2" url('/font.woff2') \`/fixed.png\` '/api/fixed.png' '/overlay/fixed.png' '/branding/fixed.png' 'https://host/fixed.png' '//host/fixed.png' '/sw.js' '/version.json' '/manifest.json' '/avatars-gallery/'`;
  const result = rewritePublicReferences(input, ['fixed.png', 'font.woff2', 'sw.js', 'version.json', 'manifest.json'], base);
  assert.ok(result.includes(`"${base}fixed.png?v=2"`));
  assert.ok(result.includes(`url('${base}font.woff2')`));
  for (const path of ['/api/fixed.png', '/overlay/fixed.png', '/branding/fixed.png', '/sw.js', '/version.json', '/manifest.json', '/avatars-gallery/']) assert.ok(result.includes(`'${path}'`));
  assert.equal(rewritePublicReferences(input, ['fixed.png'], '/'), input);
});
test('public inventory rejects symlinks', () => {
  const root = mkdtempSync('/var/tmp/nassaj-assets-test-');
  try {
    symlinkSync('/etc/passwd', join(root, 'link'));
    assert.throws(() => publicAssetPaths(root), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const readonlyPublic of [false, true]) test(`real Vite build binds assets with readonly public=${readonlyPublic}`, async () => {
  const root = mkdtempSync('/var/tmp/nassaj-assets-test-');
  try {
    mkdirSync(join(root, 'public'));
    for (const file of ['fixed.png', 'font.woff2']) writeFileSync(join(root, 'public', file), 'fixture');
    writeFileSync(join(root, 'public/manifest.json'), JSON.stringify({ start_url: '/', scope: '/', icons: [{ src: '/fixed.png' }] }));
    writeFileSync(join(root, 'public/theme.css'), '@font-face{font-family:fixture;src:url(/font.woff2)}');
    writeFileSync(join(root, 'public/sw.js'), "const icon='/fixed.png';");
    writeFileSync(join(root, 'index.html'), '<link rel="manifest" href="/manifest.json"><link rel="stylesheet" href="/theme.css"><img src="/fixed.png"><script type="module" src="/entry.js"></script>');
    writeFileSync(join(root, 'entry.js'), 'window.image="/fixed.png"; window.lazy=()=>import("./lazy.js");');
    writeFileSync(join(root, 'lazy.js'), 'export const lazy="loaded";');
    const publicFiles = readdirSync(join(root, 'public'));
    if (readonlyPublic) {
      for (const file of publicFiles) chmodSync(join(root, 'public', file), 0o444);
      chmodSync(join(root, 'public'), 0o555);
    }
    await build({ configFile: false, root, base, plugins: [clientGenerationAssets({ publicDirectory: join(root, 'public'), generationId: id })], logLevel: 'silent' });
    if (readonlyPublic) {
      for (const file of publicFiles) assert.equal(statSync(join(root, 'public', file)).mode & 0o777, 0o444);
      assert.equal(readFileSync(join(root, 'public/theme.css'), 'utf8'), '@font-face{font-family:fixture;src:url(/font.woff2)}');
    }
    const output = join(root, 'dist');
    const html = readFileSync(join(output, 'index.html'), 'utf8');
    assert.ok(html.includes('href="/manifest.json"'), 'dynamic branding manifest retains its endpoint');
    for (const file of ['theme.css', 'fixed.png']) assert.ok(html.includes(`${base}${file}`), file);
    assert.ok(html.includes(`${base}assets/`));
    assert.ok(readFileSync(join(output, 'theme.css'), 'utf8').includes(`${base}font.woff2`));
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
    assert.equal(manifest.start_url, '/'); assert.equal(manifest.scope, '/');
    assert.equal(manifest.icons[0].src, `${base}fixed.png`);
    assert.ok(readFileSync(join(output, 'sw.js'), 'utf8').includes(`${base}fixed.png`));
    const js = readdirSync(join(output, 'assets')).filter(name => name.endsWith('.js'));
    assert.equal(js.length, 2);
    assert.ok(js.some(name => readFileSync(join(output, 'assets', name), 'utf8').includes(`${base}fixed.png`)));
  } finally {
    chmodSync(join(root, 'public'), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('copied public output refuses symlinks and hardlinks without changing source', () => {
  for (const link of [symlinkSync, linkSync]) {
    const root = mkdtempSync('/var/tmp/nassaj-assets-test-');
    try {
      const source = join(root, 'public');
      const output = join(root, 'dist');
      mkdirSync(source); mkdirSync(output);
      writeFileSync(join(source, 'fixed.png'), 'image');
      const original = '<img src="/fixed.png">';
      const sourceHtml = join(source, 'api-docs.html');
      writeFileSync(sourceHtml, original);
      link(sourceHtml, join(output, 'api-docs.html'));
      const plugin = clientGenerationAssets({ publicDirectory: source, generationId: id });
      assert.throws(() => plugin.writeBundle({ dir: output }));
      assert.equal(readFileSync(sourceHtml, 'utf8'), original);
      assert.ok(!readdirSync(output).some(file => file.startsWith('.generation-rewrite-')));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('dynamic bundled URLs change only when present in public inventory; stored values stay stable', async () => {
  const { transform } = await import('esbuild');
  const source = readFileSync(new URL('../src/lib/static-asset-url.ts', import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', define: {
    __PUBLIC_ASSET_PATHS__: JSON.stringify(['avatars-gallery/faris.svg', 'connector-logos/demo.svg']),
    'import.meta.env.BASE_URL': JSON.stringify(base),
  } });
  const { staticAssetUrl } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.equal(staticAssetUrl('/avatars-gallery/faris.svg'), `${base}avatars-gallery/faris.svg`);
  assert.equal(staticAssetUrl('/connector-logos/demo.svg?v=1'), `${base}connector-logos/demo.svg?v=1`);
  for (const value of ['/api/settings/branding/logo', '/api/auth/avatar/1', '/project-logos/x.svg', '/connector-logos/unknown.svg', '/overlay/logo.svg', 'https://host/logo.svg', '//host/logo.svg', 'data:image/svg+xml,hi', null, undefined, '']) assert.equal(staticAssetUrl(value), value);
});

test('generation asset hints do not become router basenames; proxy and explicit mounts survive', async () => {
  const { transform } = await import('esbuild');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const DEPLOYMENT_ASSET_DIRECTORIES');
  const end = source.indexOf('\n}', source.indexOf('function detectRouterBasename()', start)) + 2;
  const { code } = await transform(source.slice(start, end), { loader: 'ts' });
  const detect = (prefix, explicit = '') => runInNewContext(`${code}\ndetectRouterBasename()`, {
    URL, window: { __ROUTER_BASENAME__: explicit, location: { href: 'https://example.test/', origin: 'https://example.test' } },
    document: { baseURI: 'https://example.test/', querySelector: selector => ({ getAttribute: () => `${prefix}${selector.includes('manifest') ? 'manifest.json' : 'assets/index.js'}` }), querySelectorAll: () => [] },
  });
  assert.equal(detect(base), '');
  assert.equal(detect('/'), '');
  assert.equal(detect('/ai/'), '/ai');
  assert.equal(detect(base, '/custom/'), '/custom');
});
