import { getCoordinationDirective, withCoordinationDirective } from './coordinationDirectives.js';
import { PUBLIC_PAGE_TAG, buildPublicPageGuidanceBlock, type PublicPagePlace } from './publicPageGuidance.js';

/**
 * Frozen v1 guidance: contains no credentials, domains or machine paths.
 * Do not edit its bytes after release. A future version must retain this text
 * and its exact wrapper among the canonical history reconstruction variants.
 */
export const DOCUMENT_SHARING_INSTRUCTIONS = [
  'Nassaj document sharing:',
  'Keep files inside the current project. Supported share roots are doc/ and docs/.',
  'Supported formats: pdf, docx, xlsx, txt, md, csv, html, htm, xhtml.',
  'When the user requests a share link for a file you actually created, include a relative Markdown file reference, e.g. [Share this page](docs/page.html).',
  'The chat renders a Share action for that reference; the user confirms audience and expiry, and the server creates the URL in the dialog.',
  'Do not invent a public URL, claim a share already exists, call authenticated APIs using user credentials, or request/copy a client share token into the conversation.',
  'Explain that the Share action creates and copies the link. There is no model-side share-creation tool.',
  'HTML previews are static: scripts, forms, navigation, SVG and external resources are disabled.',
  'Place local CSS, raster images and fonts under the adjacent <basename>.assets/ folder; link them relatively, e.g. page.assets/style.css.',
  'Sharing a page includes only that resource folder, never the whole project. Files remain in place; later saves appear on reload.',
  'For the complete contract read docs/document-sharing.md in Nassaj, when available.',
].join('\n');

const SHARING_BLOCK = `<nassaj_document_sharing>\n${DOCUMENT_SHARING_INSTRUCTIONS}\n</nassaj_document_sharing>`;

/** Wrapper tag of the quick-reply block; the share sanitizer strips it by name (T-2027). */
export const QUICK_REPLY_TAG = 'nassaj_quick_replies';

/**
 * T-2027 / ADR-209 — frozen v1 instruction behind the client's trailing ```choices
 * fence (`src/components/chat/utils/parseChoices.ts`). One line, ≤420 chars, no line
 * starting with ``` and no provider names. Do not edit its bytes after release: the
 * strip below matches the whole block exactly, so a v2 must keep this block among
 * the stripped forms.
 */
export const QUICK_REPLY_GUIDANCE = 'Nassaj quick replies: only in a reply to the user awaiting one pick'
  + ' among 2-5 discrete options, end it with one ```choices fence, one option per line in the'
  + ' user\'s language (max 60 chars, none starting with / or equal to "help"), one question per'
  + ' fence. If you have a tool to ask the user a question, use it instead; never both. Never in'
  + ' subagent reports, files or commits. Wrap any example of this fence in 4 backticks.';

const QUICK_BLOCK = `<${QUICK_REPLY_TAG}>\n${QUICK_REPLY_GUIDANCE}\n</${QUICK_REPLY_TAG}>`;

/** Per-host composition switches, resolved server-side (never part of `PublicPagePlace`). */
export interface RuntimeInstructionOptions {
  /** Quick-reply guidance block; ON unless the operator turned it off. */
  quickReplies?: boolean;
}

/**
 * T-1804: البادئة الصادرة. أُضيفت كتلة نشر الصفحات العامّة هنا لا في كلّ مُشعِل
 * على حدة، لأنّ هذه الوحدة هي قناة التعليمات الوحيدة التي تصل المزوّدات العشرة
 * جميعاً؛ الحقن عند كلّ مُشعِل كان سيُنتج عشر نسخ من نصٍّ واحد.
 *
 * وهي **دالّة لا ثابت**: كتلةُ النشر تحمل مسار الناشر المطلق على هذا الجهاز،
 * وهو يختلف بين تثبيتٍ من المصدر وتثبيتٍ من الحزمة.
 *
 * T-2027: كتلةُ الردود السريعة تُلحق **أخيراً**، بعد كتلة النشر، ما لم تُطفأ.
 *
 * @param place موضع الناشر وجذر المحتوى والأصل، محلولةً خادميّاً.
 * @param options مفاتيح التركيب (`quickReplies` افتراضيّاً مفعّل).
 */
export function runtimeInstructionsPrefix(
  place: PublicPagePlace,
  { quickReplies = true }: RuntimeInstructionOptions = {},
): string {
  const head = `${SHARING_BLOCK}\n\n${buildPublicPageGuidanceBlock(place)}`;
  return quickReplies ? `${head}\n\n${QUICK_BLOCK}` : head;
}

/** الموضع الغائب: كلُّ ركنٍ غير متاح، فلا يُوعَد بأمرٍ ولا برابط مطلق. */
const NO_PLACE: PublicPagePlace = { publisherPath: null, contentRoot: null, origin: null };

/** Compose existing coordination, sharing and public-page guidance in a native channel. */
export function getRuntimeInstructions(
  level: unknown,
  place: PublicPagePlace = NO_PLACE,
  options: RuntimeInstructionOptions = {},
): string {
  return [getCoordinationDirective(level), runtimeInstructionsPrefix(place, options)]
    .filter(Boolean).join('\n\n');
}

/**
 * Wrap only the outbound CLI prompt, after canonical user history is recorded.
 *
 * Anti-double-wrap anchors on the frozen sharing block, not on today's full prefix:
 * that prefix varies with the publisher path and the quick-reply flag, so an
 * exact-prefix check would re-wrap text wrapped before a flag flip or path change.
 * Every prefix Nassaj ever emitted starts with this block, and the strip below
 * already treats a leading sharing block as Nassaj's, so both sides agree.
 */
export function withRuntimeInstructions(
  command: string | null | undefined,
  level: unknown,
  place: PublicPagePlace = NO_PLACE,
  options: RuntimeInstructionOptions = {},
): string {
  const base = typeof command === 'string' ? command : '';
  if (base === SHARING_BLOCK || base.startsWith(`${SHARING_BLOCK}\n\n`)) return base;
  const prefix = runtimeInstructionsPrefix(place, options);
  const coordinated = withCoordinationDirective(base, level);
  return coordinated ? `${prefix}\n\n${coordinated}` : prefix;
}

/**
 * يقصّ بادئةً صادرةً **بنيويّاً** من صدر النصّ: كتلةَ المشاركة الحرفية ثمّ كتلةَ
 * النشر بوسمها، كلٌّ منهما مُرسًى في موضعه من البادئة، ثمّ ما بينهما من فاصل.
 *
 * لماذا بنيويّاً لا بمطابقة نصٍّ كامل: كتلةُ النشر صارت تحمل مسارَ ناشرٍ يختلف
 * بين الأجهزة وبين تثبيتين على الجهاز نفسه، فالرسالةُ المخزّنة قد تحمل مساراً
 * لم يعد قائماً. ومع ذلك **لا يُحذف نصُّ مستخدم**: الوسمان حرفيّان ومُرسَيان في
 * الصدر، والمتبقّي بعدهما يُقارن مطابقةً تامّةً عند المُنادي قبل أيّ استبدال.
 *
 * @returns النصّ بعد قصّ ما وُجد من البادئة (وقد يعود كما هو).
 */
export function stripRuntimeInstructionsPrefix(content: string): string {
  if (content === SHARING_BLOCK) return '';
  // كتلةُ النشر لا تُقصّ إلا مسبوقةً بكتلة المشاركة مباشرةً، وهو ترتيبُها الوحيد
  // في كلّ بادئةٍ أصدرها نسّاج. بلا هذا الشرط تُقصّ كتلةٌ بنفس الوسم كتبها
  // المستخدمُ نفسه في صدر رسالته.
  if (!content.startsWith(`${SHARING_BLOCK}\n\n`)) return content;
  let rest = content.slice(SHARING_BLOCK.length + 2);
  const open = `<${PUBLIC_PAGE_TAG}>\n`;
  const close = `\n</${PUBLIC_PAGE_TAG}>`;
  if (!rest.startsWith(open)) return rest;
  const end = rest.indexOf(close, open.length);
  if (end === -1) return rest;
  const after = rest.slice(end + close.length);
  return after.startsWith('\n\n') ? stripQuickReplyBlock(after.slice(2)) : after;
}

/**
 * T-2027: the quick-reply block is stripped only here, right after the public-page
 * block, and only by exact match of the whole frozen block. It never reads the
 * operator flag: blocks emitted while it was ON still strip after it is turned off.
 */
function stripQuickReplyBlock(body: string): string {
  if (body === QUICK_BLOCK) return '';
  return body.startsWith(`${QUICK_BLOCK}\n\n`) ? body.slice(QUICK_BLOCK.length + 2) : body;
}
