/**
 * B-1459 — كل حوار يُفتح من داخل الإعدادات يجب أن يعلو مودال الإعدادات نفسه.
 *
 * مودال الإعدادات يُرسَم عبر portal إلى `body` بطبقة `z-[9999]`، وطبقة
 * `DialogContent` الافتراضية `z-50`. حوار بلا `layerClassName` يُرسَم إذن **خلف**
 * الإعدادات: الزر يعمل والحوار مفتوح فعلاً، لكنه غير مرئي ولا يُنقَر. هكذا تعطّل
 * حوار «تأكيد هويتك» للموصلات — لا رمز CSRF يُسكّ دونه، فبقيت كل أزرار الكتابة
 * في معالج إعداد المشغّل معطّلة.
 *
 * jsdom لا يُصرّف Tailwind ولا يحسب ترتيب الطبقات، فالحارس على الصياغة في
 * المصدر: كل `<DialogContent` تحت الجذور المغطّاة يمرّر `layerClassName` فيه صنف
 * `z-[N]` **غير مشروط** حيث N أكبر من طبقة مودال الإعدادات المقروءة من
 * `Settings.tsx`. صنف مشروط مثل `md:z-[10000]` لا يكفي: على الجوال يبقى `z-50`.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/settings/settingsDialogLayer.guard.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../..');
const SETTINGS_MODAL_FILE = resolve(HERE, 'view/Settings.tsx');

/** مجلد الإعدادات، وما يرسمه المودال من خارجه (ProviderSkills في تبويب الوكلاء). */
const COVERED_ROOTS = ['components/settings', 'components/skills'];

const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;
const DIALOG_CONTENT_OPEN = '<DialogContent';
const MODAL_BACKDROP_LAYER = /modal-backdrop[^"'`]*\bz-\[(\d+)\]/;
const LAYER_CLASS_VALUE = /layerClassName=(?:"([^"]*)"|\{\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)\s*\})/;
const UNPREFIXED_Z_INDEX = /^z-\[(\d+)\]$/;
const QUOTES = ['"', "'", '`'];

/** القطعة التالية من المصدر: ما يُبقى منها، وأين تنتهي، وحالة المحرف النصّي بعدها. */
function readChunk(source: string, index: number, quote: string | null, lineHasCode: boolean) {
  const char = source[index];
  const pair = source.slice(index, index + 2);

  if (quote !== null) {
    if (char === '\\') return { kept: pair, next: index + 2, quote };
    // محرفا ' و" لا يعبران السطر؛ فاصلة عليا في نصّ JSX لا تبتلع بقية الملف.
    const closes = char === quote || (char === '\n' && quote !== '`');
    return { kept: char, next: index + 1, quote: closes ? null : quote };
  }
  if (pair === '/*') {
    const end = source.indexOf('*/', index + 2);
    return { kept: '', next: end === -1 ? source.length : end + 2, quote };
  }
  if (pair === '//' && !lineHasCode) {
    const end = source.indexOf('\n', index);
    return { kept: '', next: end === -1 ? source.length : end, quote };
  }
  return { kept: char, next: index + 1, quote: QUOTES.includes(char) ? char : null };
}

/**
 * يطرح التعليقات (تذكر الأصناف والوسوم نصّاً) دون أن يمسّ المحارف النصّية:
 * `accept="image/*"` ليس بداية تعليق، وحذف ما بعده حتى أول `* /` كان يبتلع وسم
 * `<DialogContent` كاملاً فيمرّ الحارس صامتاً.
 */
function stripComments(source: string): string {
  let code = '';
  let quote: string | null = null;
  let lineHasCode = false;
  let index = 0;

  while (index < source.length) {
    const chunk = readChunk(source, index, quote, lineHasCode);
    code += chunk.kept;
    quote = chunk.quote;
    index = chunk.next;
    lineHasCode = chunk.kept.includes('\n') ? false : lineHasCode || chunk.kept.trim() !== '';
  }
  return code;
}

/** كل ملفات المصدر غير الاختبارية تحت `dir`، تعاودياً. */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

/** وسم الفتح من موضع `start` حتى `>` الذي يغلقه، متجاوزاً ما داخل تعابير `{}`. */
function readOpeningTag(code: string, start: number): string {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const char = code[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return code.slice(start, index + 1);
  }
  return code.slice(start);
}

/** كل وسوم فتح `<DialogContent ...>` في الملف. */
function dialogContentTags(code: string): string[] {
  const tags: string[] = [];
  let from = code.indexOf(DIALOG_CONTENT_OPEN);
  while (from !== -1) {
    tags.push(readOpeningTag(code, from));
    from = code.indexOf(DIALOG_CONTENT_OPEN, from + DIALOG_CONTENT_OPEN.length);
  }
  return tags;
}

/** قيمة `z-[N]` غير المشروطة في `layerClassName` الوسم، أو null إن غابت. */
function layerZIndex(tag: string): number | null {
  const value = tag.match(LAYER_CLASS_VALUE)?.slice(1).find((group) => group !== undefined);
  if (value === undefined) return null;
  const match = value.split(/\s+/).map((name) => name.match(UNPREFIXED_Z_INDEX)).find(Boolean);
  return match ? Number(match[1]) : null;
}

function settingsModalZIndex(): number {
  const match = stripComments(readFileSync(SETTINGS_MODAL_FILE, 'utf8')).match(MODAL_BACKDROP_LAYER);
  if (!match) throw new Error('Settings.tsx: modal-backdrop z-[N] layer not found');
  return Number(match[1]);
}

const DIALOG_FILES = COVERED_ROOTS
  .flatMap((root) => listSourceFiles(resolve(SRC, root)))
  .filter((file) => stripComments(readFileSync(file, 'utf8')).includes(DIALOG_CONTENT_OPEN))
  .map((file) => relative(SRC, file));

describe('B-1459 — حوارات الإعدادات تعلو مودال الإعدادات', () => {
  it('الحارس يجد حوارات في كل جذر مغطّى ويقرأ طبقة المودال', () => {
    for (const root of COVERED_ROOTS) {
      expect(DIALOG_FILES.filter((file) => file.startsWith(`${root}/`)).length).toBeGreaterThan(0);
    }
    expect(settingsModalZIndex()).toBeGreaterThan(0);
  });

  it.each(DIALOG_FILES)('%s يمرّر layerClassName أعلى من مودال الإعدادات', (file) => {
    const code = stripComments(readFileSync(resolve(SRC, file), 'utf8'));
    const modalLayer = settingsModalZIndex();

    for (const tag of dialogContentTags(code)) {
      const layer = layerZIndex(tag);
      expect(layer, `missing unprefixed layerClassName z-[N] in: ${tag}`).not.toBeNull();
      expect(layer).toBeGreaterThan(modalLayer);
    }
  });
});

describe('B-1459 — أدوات الحارس نفسها', () => {
  it('طرح التعليقات لا يبدأ من داخل محرف نصّي', () => {
    const source = [
      '<input accept="image/*" />',
      '<DialogContent className="p-4">',
      '{/* تعليق لاحق */}',
    ].join('\n');

    expect(dialogContentTags(stripComments(source))).toEqual(['<DialogContent className="p-4">']);
  });

  it('طرح التعليقات يزيل تعليقات الكتلة والسطر الفعلية', () => {
    const source = [
      '/* <DialogContent layerClassName="z-[1]"> */',
      '  // <DialogContent>',
      'const url = "https://example.test/*";',
    ].join('\n');

    const code = stripComments(source);
    expect(code).not.toContain(DIALOG_CONTENT_OPEN);
    expect(code).toContain('"https://example.test/*"');
  });

  it('الصنف المشروط بمتغيّر لا يُحتسب طبقة', () => {
    expect(layerZIndex('<DialogContent layerClassName="md:z-[10000]">')).toBeNull();
    expect(layerZIndex('<DialogContent className="z-[10000]">')).toBeNull();
    expect(layerZIndex('<DialogContent layerClassName="z-[10000]">')).toBe(10000);
    expect(layerZIndex("<DialogContent layerClassName={'isolate z-[10000]'}>")).toBe(10000);
  });
});
