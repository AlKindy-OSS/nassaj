/**
 * vendorKeyLocaleKeys.test.ts — ADR-200 S9: the locale keys of the vendor-key
 * surface have no orphans in either direction.
 *
 *  - every key S9 added is used by the code (a static `t('…')` or a dynamic
 *    template whose prefix covers it), so nothing ships dead;
 *  - every English key has its Arabic twin, with all six CLDR plural forms for
 *    the two `count` strings (a missing `_two`/`_few`/`_many` silently falls
 *    through to English inside the Arabic UI);
 *  - the keys the removed UI owned (checkboxes, «يُكتب في», the subscription
 *    notices) are gone from every locale bundle that exists on disk.
 *
 * Repo convention (`src/i18n/languages.js`): `ar` and `en` carry the full
 * `settings` namespace; the other locales fall back to English per key, and
 * `fa`, `id`, `ur` ship no `settings.json` at all. Nothing in them to add or remove.
 *
 * RUNNER: vitest (`npm run test:client`) — node reads, no DOM.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const localesDir = path.join(root, 'src/i18n/locales');
type Tree = { [key: string]: string | Tree };

const loadSettings = (locale: string): Tree =>
  JSON.parse(readFileSync(path.join(localesDir, locale, 'settings.json'), 'utf8')) as Tree;

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function leaves(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => (
    typeof value === 'string' ? [prefix + key] : leaves(value, `${prefix}${key}.`)
  ));
}

function subtree(tree: Tree, dotted: string): Tree {
  return dotted.split('.').reduce<Tree>((node, part) => node[part] as Tree, tree);
}

/** The S9 namespaces: every leaf under them must be live. */
const S9_NAMESPACES = [
  'vendors.link', 'vendors.restore', 'linkMode', 'credentialGrants.grantorMode',
];
const S9_LEAVES = ['engines.needsKeyLine', 'engines.openVendorCard'];

function s9Keys(tree: Tree): string[] {
  return [
    ...S9_NAMESPACES.flatMap((namespace) => leaves(subtree(tree, namespace), `${namespace}.`)),
    ...S9_LEAVES.filter((key) => leaves(tree).includes(key)),
  ];
}

const baseKey = (key: string) => key.replace(PLURAL_SUFFIX, '');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'i18n' && name !== 'node_modules') sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|TestKit/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'shared'))]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

/** Prefixes of template-literal keys, e.g. `vendors.link.state.${…}` → `vendors.link.state.`. */
const DYNAMIC_PREFIXES = Array.from(SOURCE.matchAll(/`([\w.]+\.)\$\{/g)).map((match) => match[1]);

const isLive = (key: string) =>
  SOURCE.includes(`'${key}'`) || SOURCE.includes(`"${key}"`) || DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix));

describe('S9 locale keys', () => {
  const en = loadSettings('en');
  const ar = loadSettings('ar');
  const keys = s9Keys(en);

  it('are all present (the namespaces exist and are not empty)', () => {
    expect(keys.length).toBeGreaterThan(80);
  });

  it('have no orphan: every English key is used by the code', () => {
    const dead = [...new Set(keys.map(baseKey))].filter((key) => !isLive(key));
    expect(dead).toEqual([]);
  });

  it('have an Arabic twin for every English key, and no Arabic key without an English one', () => {
    const arKeys = s9Keys(ar);
    expect([...new Set(keys.map(baseKey))].sort()).toEqual([...new Set(arKeys.map(baseKey))].sort());
  });

  it('carry every plural category Arabic needs for the two member counts', () => {
    for (const key of ['linkMode.grantees', 'linkMode.confirm.grantees']) {
      const present = leaves(ar).filter((leaf) => baseKey(leaf) === key).map((leaf) => leaf.slice(key.length + 1));
      expect(present.sort()).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
      const english = leaves(en).filter((leaf) => baseKey(leaf) === key).map((leaf) => leaf.slice(key.length + 1));
      expect(english.sort()).toEqual(['one', 'other']);
    }
  });
});

describe('keys of the removed placement UI', () => {
  const REMOVED = [
    'vendors.storedInLine', 'vendors.removeFrom', 'vendors.slots', 'vendors.kind', 'vendors.status',
    'vendors.company.subscriptionNotice', 'vendors.company.subscriptionOverride',
    'vendors.company.subscriptionTokenOverride', 'vendors.company.subscriptionTokenIntoKeySlot',
    'vendors.company.showSlots', 'vendors.company.hideSlots', 'vendors.company.detailToggle',
    'vendors.company.outcome', 'engines.managedInVendors',
  ];

  it.each(readdirSync(localesDir).filter((locale) => existsSync(path.join(localesDir, locale, 'settings.json'))))(
    'are absent from %s/settings.json',
    (locale) => {
      const present = new Set(leaves(loadSettings(locale)));
      const stillThere = REMOVED.filter((key) => [...present].some((leaf) => leaf === key || leaf.startsWith(`${key}.`)));
      expect(stillThere).toEqual([]);
    },
  );

  it('are no longer referenced by the code', () => {
    const used = REMOVED.filter((key) => SOURCE.includes(`'${key}`) || SOURCE.includes(`"${key}`));
    expect(used).toEqual([]);
  });
});
