import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postcss from 'postcss';
import loadPostcssConfig from 'postcss-load-config';

test('Tailwind does not turn JavaScript negations into invalid component selectors', async () => {
  const { plugins, options } = await loadPostcssConfig({}, process.cwd());
  const source = await readFile('src/index.css', 'utf8');
  const result = await postcss(plugins).process(source, {
    ...options,
    from: 'src/index.css',
  });
  const emptySelectors = [];
  const negatedStateSelectors = [];

  result.root.walkRules((rule) => {
    const selector = rule.selector.trim();
    if (!selector) emptySelectors.push(rule.source?.start?.line ?? -1);
    if (/\.\\!(?:user|error)(?:\b|\s|>)/.test(selector)) {
      negatedStateSelectors.push(selector);
    }
  });

  assert.deepEqual(result.warnings(), []);
  assert.deepEqual(emptySelectors, []);
  assert.deepEqual(negatedStateSelectors, []);
});
