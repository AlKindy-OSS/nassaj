import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const footerSource = readFileSync(
  new URL('./SidebarFooter.tsx', import.meta.url),
  'utf8',
);
const statsSource = readFileSync(
  new URL('./SystemStats.tsx', import.meta.url),
  'utf8',
);
const accountSwitcherSource = readFileSync(
  new URL('./AccountSwitcher.tsx', import.meta.url),
  'utf8',
);

test('ذيل الشريط يعرض بطاقة العتاد ولوحة الأوامر المعلّقة قبل قائمة الحساب', () => {
  assert.match(footerSource, /<SystemStatsFooter t=\{t\} \/>/);
  assert.match(footerSource, /\{showBanner && \(/);
  assert.match(footerSource, /<AccountSwitcher/);
  assert.match(footerSource, /account\.roles\.\$\{user\?\.role \|\| 'user'\}/);
  assert.doesNotMatch(footerSource, /ListChecks/);
  assert.match(statsSource, /flex h-\[var\(--control-height-touch\)\] w-full items-center/);
  assert.match(statsSource, /px-3 py-0\.5/);
  assert.match(footerSource, /px-3 py-0\.5" role="status" aria-live="polite"/);
  assert.match(footerSource, /gap-1\.5 rounded-lg bg-amber-50\/80 px-2 text-start text-xs font-medium text-warning/);
  assert.match(footerSource, /relative flex h-5 w-5 shrink-0 items-center justify-center/);
  assert.match(footerSource, /h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-\[9px\]/);
  assert.match(footerSource, /mt-auto flex-shrink-0 pt-1/);
  assert.match(accountSwitcherSource, /min-h-\[var\(--control-height-touch\)\] w-full items-center/);
  assert.match(accountSwitcherSource, /start-0/);
  assert.match(accountSwitcherSource, /max-md:fixed max-md:inset-x-4 max-md:bottom-4/);
  assert.match(accountSwitcherSource, /role="menu"/);
  assert.match(accountSwitcherSource, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
  assert.match(accountSwitcherSource, /event\.key === 'Escape'/);
  assert.match(footerSource, /px-3 pb-0 pt-0\.5/);
});
