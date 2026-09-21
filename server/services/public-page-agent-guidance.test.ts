/**
 * T-1804 — قفص مخرجات البناء: ما يُمنع، وما لا يُمنع، وأين يعيش الناشر.
 *
 * الحادثة التي يقفله هذا الملفّ: صفحةُ هبوطٍ زُرعت في `dist/` فكسرت تحديث
 * العقدة (`client_asset_manifest_changed`). ونصفُ الاختبارات هنا للنقيض: أن
 * القفص لا يعترض وكيلاً يطوّر نسّاج نفسه — `public/` و`src/` ومشروعُ مستخدمٍ
 * له `dist/` خاصّ به، كلّها تمرّ.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  PUBLIC_PAGE_GUARDED_TOOLS,
  evaluatePublicPageWrite,
  isNassajBuildOutputPath,
  resolvePublicPageContentRoot,
  resolvePublicPageOrigin,
  resolvePublicPagePublisher,
} from './public-page-agent-guidance.js';
import { findAppRoot } from '../utils/runtime-paths.js';
import { readPublicSiteAsset } from './public-page-manifest.mjs';
import { buildPublicPagePublishCommand } from '../../shared/publicPageGuidance.js';
import { run as runPublisher } from '../../scripts/public-page-publish.mjs';

const OVERLAY_WORKSPACE = path.join(
  '.git', 'nassaj-session-overlays', 'instances', '64c91bc7', 'workspace',
);
const PUBLISHER = 'scripts/public-page-publish.mjs';
const BUNDLED_PUBLISHER = 'dist-server/UPDATE_RUNTIME_BUNDLE/scripts/public-page-publish.mjs';

/** جذرُ تثبيتٍ وهميّ بشجرةٍ مصغَّرة، يُمسح بانتهاء الاختبار. */
function appRootFixture(t: { after: (fn: () => void) => void }) {
  const base = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'public-page-cage-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const appRoot = path.join(base, 'nassaj-dev');
  for (const dir of ['dist/assets', 'dist-server', 'public', 'src', path.join(OVERLAY_WORKSPACE, 'dist')]) {
    mkdirSync(path.join(appRoot, dir), { recursive: true });
  }
  mkdirSync(path.join(base, 'other-project', 'dist'), { recursive: true });
  return { base, appRoot };
}

const publisher = (appRoot: string, relative: string) => {
  const file = path.join(appRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '// publisher');
  return file;
};

test('writing into the installation build output is refused, however the path is spelled', (t) => {
  const { appRoot } = appRootFixture(t);
  const denied = [
    path.join(appRoot, 'dist', 'index.html'),                 // مطلق
    path.join(appRoot, 'dist-server', 'index.js'),            // المُخرَج الثاني
    'dist/landing/index.html',                                // نسبيّ إلى cwd
    './dist/assets/app.css',
    path.join(appRoot, 'src', '..', 'dist', 'x.html'),        // التفافٌ بـ..
    path.join(appRoot, OVERLAY_WORKSPACE, 'dist', 'x.html'),  // overlay الجلسة
  ];
  for (const candidate of denied) {
    assert.equal(isNassajBuildOutputPath(candidate, { appRoot, cwd: appRoot }), true, candidate);
  }
});

/**
 * الحارسُ ضدّ أخطر شكلٍ للعطب: قفصٌ يمرّ اختباراتِه في شجرة المصدر ثمّ لا يمنع
 * شيئاً على عقدةٍ حقيقية. الخادمُ هناك يعمل من `dist-server/server/services/`،
 * فحسابُ الجذر بصعودين يُنتج `<root>/dist-server` ويقع `<root>/dist` خارجه.
 */
test('the app root is resolved for the PRODUCTION layout, not only the source tree', (t) => {
  const { appRoot } = appRootFixture(t);
  const productionModuleDir = path.join(appRoot, 'dist-server', 'server', 'services');
  mkdirSync(productionModuleDir, { recursive: true });
  const resolved = findAppRoot(productionModuleDir);
  assert.equal(resolved, appRoot, 'الجذر قفز فوق dist-server');
  for (const target of ['dist/landing.html', 'dist-server/server/index.js']) {
    assert.equal(isNassajBuildOutputPath(path.join(appRoot, target), { appRoot: resolved, cwd: appRoot }), true, target);
  }
  // وللمقارنة: الحساب القديم بصعودين كان يُسقط `dist/` من القفص تماماً.
  const naiveRoot = path.resolve(productionModuleDir, '..', '..');
  assert.equal(isNassajBuildOutputPath(path.join(appRoot, 'dist/landing.html'), { appRoot: naiveRoot, cwd: appRoot }), false);
});

test('a symlink is resolved, so it cannot smuggle a write into dist/', (t) => {
  const { appRoot } = appRootFixture(t);
  const link = path.join(appRoot, 'public', 'shortcut');
  symlinkSync(path.join(appRoot, 'dist'), link, 'dir');
  assert.equal(isNassajBuildOutputPath(path.join(link, 'x.html'), { appRoot, cwd: appRoot }), true);
});

test('legitimate Nassaj development is untouched', (t) => {
  const { base, appRoot } = appRootFixture(t);
  const allowed = [
    path.join(appRoot, 'public', 'favicon.svg'),      // ملفّات مصدريّة متتبَّعة
    path.join(appRoot, 'src', 'main.jsx'),
    path.join(appRoot, 'dist'),                       // المجلّد نفسه، لا ملفّاً بداخله
    path.join(base, 'other-project', 'dist', 'x.js'), // dist مشروعٍ آخر
    path.join(base, 'distant', 'x.js'),               // بادئةُ اسمٍ لا مجلّد
    '', null as unknown as string, 42 as unknown as string,
  ];
  for (const candidate of allowed) {
    assert.equal(isNassajBuildOutputPath(candidate, { appRoot, cwd: appRoot }), false, String(candidate));
  }
});

test('a relative path is judged against the run cwd, not the app root', (t) => {
  const { base, appRoot } = appRootFixture(t);
  const cwd = path.join(base, 'other-project');
  assert.equal(isNassajBuildOutputPath('dist/x.js', { appRoot, cwd }), false);
  assert.equal(isNassajBuildOutputPath('dist/x.js', { appRoot, cwd: appRoot }), true);
});

test('the publisher is resolved by existence, source tree first, bundle second', (t) => {
  const { appRoot } = appRootFixture(t);
  assert.equal(resolvePublicPagePublisher({ appRoot, refresh: true }), null, 'لا ناشر ⇒ لا ادّعاء');
  const bundled = publisher(appRoot, BUNDLED_PUBLISHER);
  assert.equal(resolvePublicPagePublisher({ appRoot, refresh: true }), bundled, 'عقدةٌ مثبّتة بلا scripts/');
  const fromSource = publisher(appRoot, PUBLISHER);
  assert.equal(resolvePublicPagePublisher({ appRoot, refresh: true }), fromSource, 'شجرة المصدر أولاً');
  assert.ok(path.isAbsolute(resolvePublicPagePublisher({ appRoot, refresh: true })!), 'مطلقٌ دائماً');
});

test('the guarded editing tools are refused with a runnable absolute command', (t) => {
  const { appRoot } = appRootFixture(t);
  const command = publisher(appRoot, PUBLISHER);
  const target = path.join(appRoot, 'dist', 'landing.html');
  for (const toolName of PUBLIC_PAGE_GUARDED_TOOLS) {
    const input = toolName === 'NotebookEdit' ? { notebook_path: target } : { file_path: target };
    const verdict = evaluatePublicPageWrite(toolName, input, { appRoot, cwd: appRoot, refresh: true });
    assert.equal(verdict.ok, false, toolName);
    assert.ok(verdict.message.includes(toolName));
    assert.ok(verdict.message.includes(`node ${command} publish`), 'الرفض بلا بديل صالحٍ للتنفيذ');
    assert.doesNotMatch(verdict.message, /node scripts\//, 'مسارٌ نسبيّ لا يعمل من cwd الوكيل');
  }
});

test('with no publisher on the host the refusal states the rule and promises no tool', (t) => {
  const { appRoot } = appRootFixture(t);
  const verdict = evaluatePublicPageWrite(
    'Write', { file_path: path.join(appRoot, 'dist', 'x.html') }, { appRoot, cwd: appRoot, refresh: true },
  );
  assert.equal(verdict.ok, false);
  assert.doesNotMatch(verdict.message, /public-page-publish\.mjs/);
  assert.match(verdict.message, /outside the Nassaj installation tree/);
});

test('reading, searching and running are not this cage’s business', (t) => {
  const { appRoot } = appRootFixture(t);
  const input = { file_path: path.join(appRoot, 'dist', 'index.html') };
  for (const toolName of ['Read', 'Glob', 'Grep', 'Bash']) {
    assert.equal(evaluatePublicPageWrite(toolName, input, { appRoot, cwd: appRoot }).ok, true, toolName);
  }
  assert.equal(evaluatePublicPageWrite('Write', {}, { appRoot, cwd: appRoot }).ok, true, 'أداةٌ بلا مسار');
});

/**
 * العطبُ الأخطر في هذه الميزة ليس رفضاً ناقصاً بل نشراً «ناجحاً» لا يُخدَم:
 * الوكيل يعمل في عمليةٍ ابنٍ بـ`HOME` و`XDG_DATA_HOME` مُبدَّلين
 * (`resolve-provider-env.js`)، فلو حلّ الناشرُ الجذرَ من بيئته لكتب حيث لا
 * يقرأ الخادم أبداً. هذا الاختبار يُبدّل البيئة فعلاً ثمّ ينشر **بالأمر
 * المحقون حرفياً** ويقرأ الناتج من جذر الخادم.
 */
test('the injected command publishes where the SERVER reads, under a swapped HOME', async (t) => {
  const { base, appRoot } = appRootFixture(t);
  const serverHome = path.join(base, 'server-home');
  const agentHome = path.join(base, 'agent-home');
  mkdirSync(serverHome, { recursive: true });
  mkdirSync(agentHome, { recursive: true });

  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME, ROOT: process.env.NASSAJ_PUBLIC_CONTENT_ROOT };
  t.after(() => {
    process.env.HOME = saved.HOME; process.env.XDG_DATA_HOME = saved.XDG;
    if (saved.ROOT === undefined) delete process.env.NASSAJ_PUBLIC_CONTENT_ROOT;
    else process.env.NASSAJ_PUBLIC_CONTENT_ROOT = saved.ROOT;
  });

  // 1) الخادم يحلّ جذره من بيئته هو.
  delete process.env.NASSAJ_PUBLIC_CONTENT_ROOT;
  process.env.HOME = serverHome;
  process.env.XDG_DATA_HOME = path.join(serverHome, '.local', 'share');
  const serverRoot = resolvePublicPageContentRoot({ appRoot });
  assert.ok(serverRoot?.startsWith(serverHome), 'جذر الخادم من بيئة الخادم');

  // 2) الأمر يُبنى بجذر الخادم، ثم تُبدَّل بيئةُ الطفل كما يفعل عزل المزوّد.
  const command = buildPublicPagePublishCommand({ publisherPath: path.join(appRoot, PUBLISHER), contentRoot: serverRoot });
  assert.ok(command?.includes(`--root ${serverRoot}`), 'الأمر يحمل جذر الخادم');
  process.env.HOME = agentHome;
  process.env.XDG_DATA_HOME = path.join(agentHome, '.local', 'share');
  assert.notEqual(resolvePublicPageContentRoot({ appRoot }), serverRoot, 'بيئة الطفل تحلّ جذراً آخر فعلاً');

  // 3) يُنفَّذ بوسائط الأمر المحقون نفسها، لا بوسائط مكتوبة يدوياً.
  const source = path.join(base, 'site');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<!doctype html><title>t1804</title>');
  const argv = command.split(' ').slice(2);
  const rootFlag = argv.indexOf('--root');
  await runPublisher(['publish', '--site', 'uqud-t1804', '--dir', source, '--root', argv[rootFlag + 1]]);

  // 4) الخادم يقرؤه من جذره هو.
  const asset = readPublicSiteAsset(serverRoot, 'uqud-t1804', 'index.html');
  assert.match(asset.bytes.toString('utf8'), /t1804/);
});

test('a slug the Nassaj shell owns is refused at publish time, not at read time', async (t) => {
  const { base } = appRootFixture(t);
  const source = path.join(base, 'reserved-site');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<!doctype html><title>x</title>');
  const root = path.join(base, 'content-reserved');
  for (const reserved of ['session', 'scheduled', 'wiki', 'join', 'share', 'api']) {
    await assert.rejects(
      () => runPublisher(['publish', '--site', reserved, '--dir', source, '--root', root]),
      /Nassaj itself serves/, reserved,
    );
  }
});

test('the trusted origin is configuration only — never a request header, never invented', () => {
  const accepted = resolvePublicPageOrigin({ env: { NASSAJ_PUBLIC_ORIGIN: 'https://nassaj.example.com' } });
  assert.equal(accepted, 'https://nassaj.example.com');
  const refused = [
    undefined, '', '   ', 'nassaj.example.com', 'http://nassaj.example.com',   // لا http
    'https://u:p@nassaj.example.com', 'https://nassaj.example.com/base',        // لا اعتماد ولا مسار
    'https://nassaj.example.com/?q=1', 'not a url',
  ];
  for (const value of refused) {
    assert.equal(resolvePublicPageOrigin({ env: { NASSAJ_PUBLIC_ORIGIN: value } }), null, String(value));
  }
});

/**
 * الوكيل الأعمى كتب ملفّاته في `<root>/<site>/` ثمّ نشر منها: غير ضارّ لأنّ
 * القراءة عبر المؤشّرات، لكنّه يترك شجرةً غريبة في الجذر لا يملكها تنظيف.
 * النصُّ يرشده، والناشرُ يرفض — فالإرشادُ وحده لا يكفي.
 */
test('the publisher refuses a --dir that lives inside the content root', async (t) => {
  const { base } = appRootFixture(t);
  const root = path.join(base, 'content-dir-guard');
  mkdirSync(root, { recursive: true });
  const inside = path.join(root, 'bunn-alsabah');
  mkdirSync(inside, { recursive: true });
  writeFileSync(path.join(inside, 'index.html'), '<!doctype html><title>x</title>');
  await assert.rejects(
    () => runPublisher(['publish', '--site', 'bunn-alsabah', '--dir', inside, '--root', root]),
    /--dir must be outside the public content root/,
  );
  // والجذرُ نفسُه مرفوض، لا أبناؤه وحدهم.
  await assert.rejects(
    () => runPublisher(['publish', '--site', 'bunn-alsabah', '--dir', root, '--root', root]),
    /--dir must be outside the public content root/,
  );
});

test('a symlink pointing into the content root does not smuggle the source back in', async (t) => {
  const { base } = appRootFixture(t);
  const root = path.join(base, 'content-symlink-guard');
  const inside = path.join(root, 'site');
  mkdirSync(inside, { recursive: true });
  writeFileSync(path.join(inside, 'index.html'), '<!doctype html><title>x</title>');
  const disguised = path.join(base, 'looks-outside');
  symlinkSync(inside, disguised, 'dir');
  await assert.rejects(
    () => runPublisher(['publish', '--site', 'bunn-alsabah', '--dir', disguised, '--root', root]),
    /--dir must be outside the public content root/,
  );
});

test('a source directory outside the content root still publishes', async (t) => {
  const { base } = appRootFixture(t);
  const root = path.join(base, 'content-ok');
  const source = path.join(base, 'my-project', 'site');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'index.html'), '<!doctype html><title>ok</title>');
  const result = await runPublisher(['publish', '--site', 'bunn-alsabah', '--dir', source, '--root', root]);
  assert.equal(result.action, 'published');
});
