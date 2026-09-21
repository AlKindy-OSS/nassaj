import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const presets = readFileSync(new URL('../src/lib/theme-presets.ts', import.meta.url), 'utf8');

test('fullscreen receives the same safe-area media query as standalone', () => {
  assert.match(
    css,
    /@media\s*\(display-mode:\s*standalone\),\s*\(display-mode:\s*fullscreen\)/,
  );
});

test('the blocking theme bootstrap precedes first-paint resources', () => {
  const bootstrap = html.indexOf('id="theme-mode-bootstrap"');
  assert.ok(bootstrap > 0);
  assert.ok(bootstrap < html.indexOf('rel="icon"'));
  assert.ok(bootstrap < html.indexOf('src="/src/main.jsx"'));
});

test('default theme backgrounds cannot drift between TypeScript and CSS', () => {
  const light = presets.match(/light:\s*'([^']+)'/)?.[1];
  const dark = presets.match(/dark:\s*'([^']+)'/)?.[1];
  assert.ok(light && dark);
  assert.match(css, new RegExp(`:root[\\s\\S]*?--background: ${light.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(css, new RegExp(`\\.dark[\\s\\S]*?--background: ${dark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
