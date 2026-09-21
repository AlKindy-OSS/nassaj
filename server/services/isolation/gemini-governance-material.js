/**
 * gemini-governance-material — واجهة رفيعة تربط بدائيات الحوكمة العامة
 * (`vendor-cli-governance-material.js`) بما يبتلعه agy فعلاً: ‏`$HOME/.gemini/GEMINI.md`.
 *
 * لماذا هذا الملف بالذات (‏T-1185/B-390، مقيس 2026-08-01 لا مستنتَج):
 *
 *   استُخرج من ثنائية agy 1.1.9 أنّ لها نظام rules بمواضع محددة —
 *   «Location: "rules/" (relative to the customization root) or standalone
 *   "GEMINI.md"/"AGENTS.md" files» — ثم أُثبت الابتلاع بفحص canary حيّ: جلسة
 *   `agy -p` في دليل منفصل استرجعت من قواعدها المحمّلة ADR-018 وT-1150 وB-95
 *   وعنوان آخر قسم في `GEMINI.md`، بلا استعمال أي أداة. أما ملفات مساحة العمل
 *   (‏GEMINI.md وAGENTS.md و`.agents/rules/*.md` في cwd) فلم تُبتلع في الفحص
 *   نفسه — فالقناة الفعّالة هي البيت لا المشروع.
 *
 * الفجوة التي يسدّها: تحت العزل يضبط `resolveProviderEnv` المتغيّر `HOME` إلى
 * شجرة المستخدم، بينما `provisionUserDirs` كان يزرع في `.gemini` الجلسات
 * والرمز والدماغ **دون مادة حوكمة** — فأي رفع لعلم عزل agy كان يُطلق كل جلسة
 * بلا حوكمة نسّاج بتاتاً، بصمت. وهذا انكشاف fail-open كامن لا خلل شارة فقط.
 *
 * نسخة لا رابط — بنفس حجّة Codex حرفياً: يُشغَّل agy بـ
 * `--dangerously-skip-permissions` (‏agy-cli.js:665)، فرابطٌ إلى المصدر المشترك
 * يمكن أن يُكتب **من خلاله** فيُفسد حوكمة كل مستخدم على العقدة. أقصى ما تبلغه
 * جلسة معادية بالنسخة هو إتلاف نسختها هي، ويكشفه فحص البصمة عند الإطلاق التالي.
 *
 * المصدر: ‏`~/.gemini/GEMINI.md` — وهو على عقد الأسطول رابط إلى `GEMINI.md`
 * المولَّد في مستودع الحوكمة (مخرَج build-agents لمنصّة Gemini، أي النسخة
 * المحايدة من معايير نسّاج بلا آليات Claude الخاصة).
 */

import os from 'node:os';
import path from 'node:path';

import {
  governanceMatchesSource as matchesSource,
  hasUsableSource,
  materializeGovernanceCopy as materializeCopy,
  readNeutralSource,
} from './vendor-cli-governance-material.js';

/** اسم ملف الحوكمة الذي يبتلعه agy من بيته. */
export const GEMINI_GOVERNANCE_FILENAME = 'GEMINI.md';

/** دليل agy/gemini داخل أي بيت (المشغّل أو المستخدم المعزول). */
export const GEMINI_HOME_SUBDIR = '.gemini';

/**
 * المصدر المحايد: ‏`~/.gemini/GEMINI.md` في بيت المشغّل.
 * دالة لا ثابت، لأن `os.homedir()` يُقرأ وقت النداء (الاختبارات تبدّله).
 *
 * @returns {string}
 */
export function geminiGovernanceSource() {
  return path.join(os.homedir(), GEMINI_HOME_SUBDIR, GEMINI_GOVERNANCE_FILENAME);
}

/** هل المصدر صالح للاستعمال (موجود وغير فارغ)؟ */
export function hasGeminiGovernanceSource() {
  return hasUsableSource(geminiGovernanceSource());
}

/** محتوى المصدر المحايد، أو `null` إن تعذّر. */
export function readGeminiGovernance() {
  return readNeutralSource(geminiGovernanceSource());
}

/**
 * هل نسخة المستخدم **مطابقة هوية** للمصدر؟ (ملف حقيقي غير فارغ ولا رابط،
 * بصمة sha256 تساوي بصمة المصدر). قراءة محضة — لا تُصلح ولا تكتب.
 *
 * @param {string} geminiMdPath مسار النسخة المراد التحقّق منها
 */
export function geminiGovernanceMatchesSource(geminiMdPath) {
  return matchesSource(geminiMdPath, geminiGovernanceSource());
}

/**
 * يُرسي `GEMINI.md` نسخةً 0444 داخل بيت gemini المعطى (إن لزم).
 * أفضل-جهد لا fail-closed: agy غير محكوم بحارس إطلاق حاجب بعد (قرار المالك
 * في T-1186)، فالفشل يُسجَّل ولا يُسقط الإطلاق.
 *
 * @param {string} geminiHome الدليل `<userRoot>/.gemini`
 * @param {{ onError?: (err: unknown) => void }} [options]
 */
export function materializeGeminiGovernance(geminiHome, options = {}) {
  return materializeCopy(
    geminiHome,
    GEMINI_GOVERNANCE_FILENAME,
    geminiGovernanceSource(),
    options,
  );
}
