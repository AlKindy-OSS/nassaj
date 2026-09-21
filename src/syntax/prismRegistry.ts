/**
 * prismRegistry — مُلوِّن واحد (`PrismLight`) وسِجلّ لغات ينمو عند الطلب.
 *
 * ## لماذا `PrismLight` لا `Prism`
 *
 * `import { Prism } from 'react-syntax-highlighter'` يجرّ `refractor` الكامل:
 * 277 وحدة لغة (871 كيلوبايت خام على القرص) تدخل **حزمة البدء** كلها، ويدفع
 * ثمنها كل من فتح الصفحة ولو لم يرَ كتلة شيفرة واحدة. `PrismLight` يجرّ
 * `refractor/core` فقط (‏markup + css + clike + javascript مُسجَّلة سلفاً)
 * ويترك بقية اللغات لتُسجَّل يدوياً.
 *
 * ## لماذا مكوِّن واحد لكل المستويات
 *
 * كان الأسهل مكوِّناً لكل مستوى (‏`PrismLight` للخفيف، `Prism` للكامل) — لكن
 * تبديل **نوع** المكوِّن يُعيد تركيب الشجرة (unmount/mount)، فتُومض كل كتلة
 * شيفرة في المحادثة عند تغيير الإعداد. هنا المكوِّن ثابت أبداً، والمتغيّر هو
 * محتوى سِجلّ `refractor` وحده — فالانتقال إعادة رسم صامتة لا أكثر.
 *
 * ## سلوك لغة غير مُسجَّلة
 *
 * `react-syntax-highlighter/dist/esm/highlight.js` يلفّ `astGenerator.highlight`
 * بـ`try/catch` ويسقط إلى `defaultCodeValue` (النصّ الخام) عند أي استثناء —
 * و`refractor` يرمي `Unknown language: …` بالضبط. فالكتلة غير المدعومة تُعرَض
 * نصّاً سليماً بنفس الإطار والحشو والخلفية، قابلاً للتحديد والنسخ. لا نتحقّق من
 * اللغة مُسبقاً كي لا نُكرِّر منطق البدائل (js/ts/py/yml…) الذي يملكه refractor.
 *
 * ## التسجيل تراكمي — ولا تنزيل عكسي
 *
 * `refractor` لا يوفّر إلغاء تسجيل. رفع المستوى يسري فوراً بلا إعادة تحميل؛
 * أما خفضه فيمنع أي تنزيل لاحق ويسري كاملاً عند إعادة التحميل التالية. هذا
 * مقصود: الضمان المهم (ألّا تدخل اللغات حزمة البدء) لا يمسّه شيء.
 */
// المستوى الأول تسجيل ساكن — هذه الوحدات وحدها في حزمة البدء.
// javascript / css / markup مُسجَّلة داخل refractor/core فلا تُستورَد هنا.
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

import {
  CODE_HIGHLIGHT_SCOPE_RANK,
  DEFAULT_CODE_HIGHLIGHT_SCOPE,
  LANGUAGE_ALIASES,
  type CodeHighlightScope,
} from './codeHighlightScope';

type PrismGrammar = ((prism: unknown) => void) & { displayName?: string };

/** المكوِّن المشترك — مرجع ثابت طوال عمر الصفحة (انظر «مكوِّن واحد» أعلاه). */
export const CodeHighlighter = PrismLight;

/* ─────────────────────────── سِجلّ الاشتراكات ─────────────────────────── */

const listeners = new Set<() => void>();
let registryVersion = 0;
/** أعلى مستوى اكتمل تسجيله فعلاً (لا مجرّد بدء تحميله). */
let loadedScope: CodeHighlightScope = DEFAULT_CODE_HIGHLIGHT_SCOPE;
/** وعود جارية لكل مستوى — تمنع تنزيل نفس الحزمة مرّتين مع عشرات الكتل. */
const inFlight = new Map<CodeHighlightScope, Promise<void>>();

function bumpVersion(): void {
  registryVersion += 1;
  for (const listener of listeners) listener();
}

/** يشترك في تغيّرات السِجلّ (‏`useSyncExternalStore`). */
export function subscribeToRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** لقطة السِجلّ — عدد صحيح يتغيّر كلما اتّسع، فيُعيد رسم الكتل المعروضة. */
export function getRegistryVersion(): number {
  return registryVersion;
}

/** المستوى المُسجَّل فعلياً الآن (للاختبارات والتشخيص). */
export function getLoadedScope(): CodeHighlightScope {
  return loadedScope;
}

/* ─────────────────────────── التسجيل ─────────────────────────── */

function register(id: string, grammar: unknown): void {
  if (typeof grammar !== 'function') return;
  try {
    CodeHighlighter.registerLanguage(id, grammar as PrismGrammar);
  } catch {
    // لغة واحدة معطوبة لا تُسقِط الدفعة كلها.
  }
}

/**
 * يطبّق الأسماء البديلة على لغة سُجِّلت للتوّ.
 * `refractor.alias` يفشل إن لم تكن اللغة مُسجَّلة، فالترتيب هنا مقصود.
 */
function applyAliases(id: string): void {
  const aliases = LANGUAGE_ALIASES[id];
  if (!aliases?.length) return;
  try {
    CodeHighlighter.alias(id, [...aliases]);
  } catch {
    // بديل مرفوض لا يُعطِّل اللغة نفسها.
  }
}

// تسجيل المستوى الأول — يُنفَّذ مرّة عند تحميل الوحدة.
register('bash', bash);
register('json', json);
register('markdown', markdown);
register('python', python);
register('rust', rust);
register('typescript', typescript);
register('yaml', yaml);
applyAliases('bash');
applyAliases('markdown');

/* ─────────────────────── المستويان الثاني والثالث ─────────────────────── */

/**
 * المستوى الثاني: عشر لغات شائعة، كل واحدة `import()` مستقلّ.
 *
 * `Promise.all` على عشرة استيرادات يجعلها طلبات متوازية، والتسجيل بعد اكتمالها
 * جميعاً حتى لا تُعاد الكتل رسماً عشر مرّات متتابعة.
 */
async function loadExtended(): Promise<void> {
  const modules = await Promise.all([
    import('react-syntax-highlighter/dist/esm/languages/prism/jsx'),
    import('react-syntax-highlighter/dist/esm/languages/prism/tsx'),
    import('react-syntax-highlighter/dist/esm/languages/prism/go'),
    import('react-syntax-highlighter/dist/esm/languages/prism/java'),
    import('react-syntax-highlighter/dist/esm/languages/prism/cpp'),
    import('react-syntax-highlighter/dist/esm/languages/prism/csharp'),
    import('react-syntax-highlighter/dist/esm/languages/prism/php'),
    import('react-syntax-highlighter/dist/esm/languages/prism/ruby'),
    import('react-syntax-highlighter/dist/esm/languages/prism/sql'),
    import('react-syntax-highlighter/dist/esm/languages/prism/docker'),
  ]);

  const ids = ['jsx', 'tsx', 'go', 'java', 'cpp', 'csharp', 'php', 'ruby', 'sql', 'docker'];
  modules.forEach((module, index) => {
    register(ids[index], (module as { default?: unknown }).default);
  });
  applyAliases('docker');
}

/**
 * المستوى الثالث: فهرس اللغات الكامل عبر `import()` واحد.
 *
 * الاستيراد الديناميكي هو الشرط الحاسم — استيراده ساكناً (ولو داخل شرط) يُعيد
 * الـ871 كيلوبايت إلى حزمة البدء ويُبطل الميزة كلها بصمت.
 */
async function loadFull(): Promise<void> {
  const all = await import('react-syntax-highlighter/dist/esm/languages/prism');
  for (const [id, grammar] of Object.entries(all as Record<string, unknown>)) {
    register(id, grammar);
  }
  for (const id of Object.keys(LANGUAGE_ALIASES)) applyAliases(id);
}

/**
 * يضمن تسجيل كل لغات `scope`. آمن للاستدعاء من كل كتلة شيفرة في الصفحة:
 * المستوى المُحمَّل سلفاً يعود فوراً، والجاري يُشارك نفس الوعد.
 */
export function ensureScope(scope: CodeHighlightScope): Promise<void> {
  if (CODE_HIGHLIGHT_SCOPE_RANK[scope] <= CODE_HIGHLIGHT_SCOPE_RANK[loadedScope]) {
    return Promise.resolve();
  }

  const existing = inFlight.get(scope);
  if (existing) return existing;

  const loader = scope === 'full' ? loadFull() : loadExtended();
  const promise = loader
    .then(() => {
      // الفحص ثانيةً: قد يكون مستوىً أعلى سبق واكتمل أثناء التنزيل.
      if (CODE_HIGHLIGHT_SCOPE_RANK[scope] > CODE_HIGHLIGHT_SCOPE_RANK[loadedScope]) {
        loadedScope = scope;
      }
      bumpVersion();
    })
    .catch(() => {
      // فشل الشبكة يُبقي المستوى الحالي عاملاً؛ اللغات غير المُسجَّلة تبقى نصّاً.
      inFlight.delete(scope);
    });

  inFlight.set(scope, promise);
  return promise;
}
