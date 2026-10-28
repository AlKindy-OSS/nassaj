#!/usr/bin/env node
/**
 * measure-prose-fence.mjs — real-layout check for B-1674 in Chromium.
 *
 * Renders the chat Markdown component inside the running app (private Vite dev
 * server from this tree, RTL chrome) and measures glyph positions with DOM
 * Ranges — not CSS text — to prove:
 *   1. a prose fence with mixed Arabic/Latin reads in logical order;
 *   2. JS / Python fences with Arabic comment lines keep indentation and the
 *      `//` / `#` marker on the left;
 *   3. a diff fence keeps `+` / `-` on the left;
 *   4. a `<pre dir="rtl">` (skill bodies) is unaffected;
 *   5. select + Ctrl+C on a prose fence keeps every blank line;
 *   6. prose line heights match a code fence with the same lines.
 *
 * Usage (Vite must already serve this tree):
 *   VITE_PORT=5287 HOST=127.0.0.1 TMPDIR=/var/tmp npx vite &
 *   BASE=http://127.0.0.1:5287 node scripts/bidi-measure/measure-prose-fence.mjs
 * Optional NASSAJ_TEST_CRED=<file> (line 1 user, line 2 password) logs in first;
 * the password is only sent to /api/auth/login and never printed.
 * Exit code 0 = all checks pass, 1 = a check failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5287';
const CRED = process.env.NASSAJ_TEST_CRED
  ?? path.join(os.homedir(), '.config/nassaj-test/wiki-diag-test.cred');

const CASES = {
  prose: { dir: 'rtl', md: '```\nاستخدم npm install ثم شغّل\n```\n' },
  proseMd: { dir: 'rtl', md: '```markdown\nاستخدم npm install ثم شغّل\n```\n' },
  js: { dir: 'rtl', md: '```js\nfunction sum(a) {\n    // احسب المجموع\n    return a;\n}\n```\n' },
  python: { dir: 'rtl', md: '```python\ndef f():\n    # تعليق\n    pass\n```\n' },
  diff: { dir: 'rtl', md: '```diff\n+ نص جديد\n- old text\n```\n' },
  blanks: { dir: 'rtl', md: '```\na\n\nسطر b\n\n\nend\n```\n' },
  blanksJs: { dir: 'rtl', md: '```js\na\n\nسطر b\n\n\nend\n```\n' },
};
const BLANKS_SOURCE = 'a\n\nسطر b\n\n\nend';

async function login(page) {
  if (!existsSync(CRED)) return false;
  const [username, password] = readFileSync(CRED, 'utf8').split('\n');
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { username, password } });
  if (!res.ok()) return false;
  const { token } = await res.json();
  if (!token) return false;
  await page.addInitScript((t) => localStorage.setItem('auth-token', t), token);
  return true;
}

/** Runs in the page: left edge (px, relative to the box) of the first occurrence of `text`. */
function measureInPage({ hostId, selector, needles }) {
  const box = document.querySelector(`#${hostId} ${selector}`);
  if (!box) return { error: `missing ${selector}` };
  const boxLeft = box.getBoundingClientRect().left;
  const out = { boxDir: getComputedStyle(box).direction };
  for (const needle of needles) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let x = null;
    for (let node = walker.nextNode(); node && x === null; node = walker.nextNode()) {
      const at = node.data.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      x = Math.round(range.getBoundingClientRect().left - boxLeft);
    }
    out[needle] = x;
  }
  return out;
}

async function run() {
  const browser = await chromium.launch();
  const rows = [];
  const fail = (name, ok, detail) => rows.push({ check: name, ok, ...detail });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await context.newPage();
    const loggedIn = await login(page);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; document.documentElement.lang = 'ar'; });
    await page.evaluate(async (cases) => {
      const { mountMarkdown } = await import('/scripts/bidi-measure/mount-markdown.js');
      for (const [id, c] of Object.entries(cases)) mountMarkdown(`m-${id}`, c.md, c.dir);
      const pre = document.createElement('pre');
      pre.id = 'm-rtlpre';
      pre.dir = 'rtl';
      pre.style.width = '640px';
      pre.className = 'mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-2 text-xs';
      pre.textContent = 'مرحبا world\n    // تعليق';
      document.body.appendChild(pre);
    }, CASES);
    await page.waitForTimeout(500);
    const m = (hostId, selector, needles) => page.evaluate(measureInPage, { hostId, selector, needles });
    const collect = async () => ({
      prose: await m('m-prose', 'pre', ['استخدم', 'شغّل', 'npm', 'install']),
      proseMd: await m('m-proseMd', 'pre', ['استخدم', 'شغّل', 'npm', 'install']),
      js: await m('m-js', 'pre', ['//', 'احسب', 'return', 'function']),
      python: await m('m-python', 'pre', ['#', 'تعليق', 'pass', 'def']),
      diff: await m('m-diff', 'pre', ['+', 'نص', '-', 'old']),
      skillPre: await page.evaluate(() => {
        const el = document.getElementById('m-rtlpre');
        const s = getComputedStyle(el);
        const range = document.createRange();
        range.setStart(el.firstChild, 0);
        range.setEnd(el.firstChild, 5);
        const r = range.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return { direction: s.direction, unicodeBidi: s.unicodeBidi, arabicLeft: Math.round(r.left - box.left) };
      }),
    });
    const withFix = await collect();
    // Real copy: select the prose fence's code, press Ctrl+C, read the clipboard.
    const copy = await page.evaluate(() => {
      const code = document.querySelector('#m-blanks pre code');
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const heights = [...code.querySelectorAll('.nassaj-prose-line')].map((l) => l.getBoundingClientRect().height);
      const jsHeight = document.querySelector('#m-blanksJs pre code').getBoundingClientRect().height;
      return { selectionText: selection.toString(), heights, proseHeight: code.getBoundingClientRect().height, jsHeight };
    });
    await page.keyboard.press('Control+C');
    copy.clipboard = await page.evaluate(() => navigator.clipboard.readText());
    fail('5 copy keeps blank lines', copy.clipboard.replace(/\n$/, '') === BLANKS_SOURCE
      && copy.selectionText.replace(/\n$/, '') === BLANKS_SOURCE, {
      fixed: { clipboard: JSON.stringify(copy.clipboard), selection: JSON.stringify(copy.selectionText) },
    });
    fail('6 line heights unchanged (6 equal lines, same total as a js fence)', copy.heights.length === 6
      && copy.heights.every((h) => h === copy.heights[0]) && Math.abs(copy.proseHeight - copy.jsHeight) < 1, {
      fixed: { heights: copy.heights, proseHeight: copy.proseHeight, jsHeight: copy.jsHeight },
    });
    // Baseline: drop only the B-1674 rules from the live stylesheets and re-measure.
    const removed = await page.evaluate(() => {
      let count = 0;
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (let i = rules.length - 1; i >= 0; i -= 1) {
          if (rules[i].selectorText?.includes('data-prose-fence')) { sheet.deleteRule(i); count += 1; }
        }
      }
      return count;
    });
    const baseline = await collect();

    for (const id of ['prose', 'proseMd']) {
      const r = withFix[id];
      fail(`1 ${id} fence logical order`, r['استخدم'] > r['شغّل'] && r.npm < r.install, { fixed: r, baseline: baseline[id] });
    }
    const { js, python: py, diff } = withFix;
    fail('2 js comment marker left, indent kept', js['//'] === js.return && js['//'] < js['احسب'] && js.function < js['//'], { fixed: js, baseline: baseline.js });
    fail('2 python comment marker left, indent kept', py['#'] === py.pass && py['#'] < py['تعليق'] && py.def < py['#'], { fixed: py, baseline: baseline.python });
    fail('3 diff +/- left', diff['+'] === diff['-'] && diff['+'] < diff['نص'] && diff['-'] < diff.old, { fixed: diff, baseline: baseline.diff });
    fail('4 skill <pre dir="rtl"> unaffected', JSON.stringify(withFix.skillPre) === JSON.stringify(baseline.skillPre)
      && withFix.skillPre.unicodeBidi !== 'plaintext', { fixed: withFix.skillPre, baseline: baseline.skillPre });
    fail('baseline reproduces the bug (rules removed: ' + removed + ')', baseline.prose['استخدم'] < baseline.prose['شغّل'], {});
    console.log(JSON.stringify({ base: BASE, loggedIn, chromeDir: 'rtl', rows }, null, 2));
  } finally {
    await browser.close();
  }
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
