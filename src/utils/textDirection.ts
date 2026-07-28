/**
 * Base text direction for mixed Arabic/Latin content.
 *
 * WHY NOT `dir="auto"` (this is the whole point of the module)
 * ------------------------------------------------------------------
 * HTML's `dir=auto` is a *first strong character* heuristic. Two properties of
 * that heuristic make it actively harmful for Arabic technical prose:
 *
 *  1. Arabic technical writing very often OPENS with a Latin identifier —
 *     `` `ZITADEL_PORT` لا يقيّد عنوان الربط `` — so the first strong character
 *     is `Z` and the whole block resolves to LTR. The Unicode bidi algorithm
 *     then lays every Arabic run and every neutral (parentheses, dashes,
 *     digits, em dash) out against an LTR base: `(~200MB على ذاكرة 2GB)`
 *     renders as `(GBعلى ذاكرة 2 ~200MB)`, trailing segments jump lines, and an
 *     `<li>` puts its marker in the left gutter while its text reads
 *     right-to-left.
 *  2. The scan SKIPS any descendant that carries its own `dir` attribute. A
 *     wrapper whose children are all `dir="auto"` therefore finds no strong
 *     character at all and silently falls back to LTR — which is how an
 *     all-Arabic message container ends up computing `direction: ltr`.
 *
 * CSS cannot rescue either case: `unicode-bidi: isolate` on `<code>` is a
 * layout-level property and has no influence on the DOM-level `dir=auto`
 * algorithm. And `unicode-bidi: plaintext` makes it worse, not better — it
 * discards the box's `direction` and re-derives the paragraph base per UBA
 * P2/P3 (which *does* skip isolates), so the text can order RTL while the box
 * (list marker, `text-align: start`) stays LTR. Alignment and order then
 * disagree, which is the "correct alignment + scrambled order" signature.
 *
 * THE RULE HERE — TWO LEVELS, NOT ONE
 * ------------------------------------------------------------------
 * A single message-wide character majority is NOT enough, and gets it wrong in
 * a way that is worse than the original bug. Character counts are structurally
 * biased towards Latin: ~5.2 letters per English word against ~4.2 per Arabic
 * word, on top of English paragraphs simply running longer. Measured on real
 * session text, two short Arabic paragraphs (19 words, 85 strong characters)
 * against ONE English paragraph (22 words, 127 strong characters) tipped the
 * whole message to LTR — scrambling *every* Arabic paragraph at once.
 *
 * So direction is resolved at two levels:
 *
 *  1. PER BLOCK, by majority — never by first-strong. An Arabic paragraph that
 *     opens with `ZITADEL_PORT` stays RTL because its majority is Arabic. This
 *     is what killed the original bug; the bug was first-strong, not per-block.
 *  2. PER CONTAINER, by a vote of the blocks — one block, one vote. Paragraph
 *     length then stops deciding the message, so the bias above disappears.
 *
 * A block only carries an explicit `dir` when it DISAGREES with the container,
 * and then only under a conservative guard: it must contain zero strong
 * characters in the container's direction (a genuinely monolingual paragraph).
 * Anything mixed inherits. That guard is what keeps a short heading such as
 * `**T-975 — Login V1 أم V2؟**` (7 Latin letters against 2 Arabic) from
 * flipping to LTR just because Latin happens to outnumber Arabic in it.
 */

export type TextDirection = 'rtl' | 'ltr';

/**
 * Strong right-to-left scripts: Hebrew, Arabic (+ supplement / extended-A /
 * extended-B), Syriac, Thaana, N'Ko, Samaritan, Mandaic, and both Arabic
 * presentation-form blocks. Written as escapes on purpose — literal RTL glyphs
 * inside a regex are unreviewable in a diff.
 */
const RTL_STRONG =
  /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࠀ-࠿ࡀ-࡟ࡠ-࡯ࢠ-ࣿיִ-ﭏﭐ-﷿ﹰ-ﻼ]/g;

/** Strong left-to-right letters: Latin (+ extensions), Greek, Cyrillic. */
const LTR_STRONG = /[A-Za-zÀ-ʯͰ-ϿЀ-ӿ]/g;

/**
 * Drop everything that is Latin by construction rather than by language:
 * fenced code, inline code, link targets, bare URLs, e-mails and raw HTML.
 * Link *text* is kept — it is prose.
 */
function proseOnly(source: string): string {
  return source
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/<\/?[A-Za-z][^>\n]{0,200}>/g, ' ');
}

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** Number of strong characters in `text` that point in direction `dir`. */
export function countStrong(text: string, dir: TextDirection): number {
  return count(proseOnly(text), dir === 'rtl' ? RTL_STRONG : LTR_STRONG);
}

/**
 * LEVEL 1 — the base direction of a single block, by majority.
 *
 * Returns `null` when the content carries no strong characters at all (pure
 * digits/punctuation). Callers should then omit `dir` entirely so the element
 * inherits its container instead of guessing.
 */
export function resolveTextDirection(source: string | null | undefined): TextDirection | null {
  if (!source || typeof source !== 'string') return null;

  const prose = proseOnly(source);
  let rtl = count(prose, RTL_STRONG);
  let ltr = count(prose, LTR_STRONG);

  if (rtl === 0 && ltr === 0) {
    // No prose left — fall back to the raw text so a message made entirely of
    // code fences still gets a sane direction instead of none.
    rtl = count(source, RTL_STRONG);
    ltr = count(source, LTR_STRONG);
    if (rtl === 0 && ltr === 0) return null;
    return rtl > ltr ? 'rtl' : 'ltr';
  }

  if (rtl !== ltr) return rtl > ltr ? 'rtl' : 'ltr';

  // Exact tie (vanishingly rare): fall back to first-strong over the prose.
  const firstRtl = prose.search(RTL_STRONG);
  const firstLtr = prose.search(LTR_STRONG);
  if (firstRtl === -1) return 'ltr';
  if (firstLtr === -1) return 'rtl';
  return firstRtl < firstLtr ? 'rtl' : 'ltr';
}

/** بداية سطر تُعلن كتلةً مستقلة: عنصر قائمة، عنوان، اقتباس، صفّ جدول. */
const BLOCK_LINE_START = /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|>\s?|\|)/;

/**
 * تقطيع مصدر الماركداون إلى كتل — لأغراض التصويت فقط.
 *
 * الأسطر الفارغة تفصل الفقرات، وكل عنصر قائمة/عنوان/صفّ جدول كتلةٌ بنفسه حتى لو
 * لصق بجيرانه بلا سطر فارغ. سطر التكملة (مثل السطر الثاني من عنصر قائمة طويل)
 * يتبع كتلته. كتل الشيفرة تُحذف: هي لاتينية بحكم البناء ولا تُصوِّت.
 */
export function splitMarkdownBlocks(source: string | null | undefined): string[] {
  if (!source || typeof source !== 'string') return [];
  const withoutFences = source
    .replace(/```[\s\S]*?(?:```|$)/g, '\n\n')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n\n');

  const blocks: string[] = [];
  for (const chunk of withoutFences.split(/\n\s*\n/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    let current = '';
    for (const line of trimmed.split('\n')) {
      if (BLOCK_LINE_START.test(line)) {
        if (current.trim()) blocks.push(current.trim());
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current.trim()) blocks.push(current.trim());
  }
  return blocks;
}

/**
 * أقلّ عدد حروف قوية يُسمح بعده بحسم اتجاه رسالة **قيد البثّ**.
 *
 * دون هذه العتبة يُعاد `null` (لا سِمة ⇒ وراثة المستند) بدل تخمين يُبنى على
 * نصف كلمة. 40 قيمة مقيسة لا مختارة: هي وإسقاط الكتلة النامية معاً خفّضتا أحداث
 * الانقلاب من 28.1 إلى 15.1 لكل 100 رسالة (−46%) بثمن 0.19% فقط.
 */
const STREAMING_MIN_STRONG = 40;

export type ContainerDirectionOptions = {
  /**
   * الرسالة ما تزال تُبَثّ (نصّها ينمو ~10 مرات/ثانية).
   *
   * تُفعِّل حارسين، وكلاهما مطفأ تماماً للرسالة المكتملة:
   *   D — الكتلة الأخيرة لا تصوّت ما دامت هناك كتلة مكتملة واحدة على الأقل.
   *       (كتلة واحدة يتيمة تصوّت رغم نموّها، وإلا فقدت الرسالة اتجاهها كلياً.)
   *   B — لا حسم قبل `STREAMING_MIN_STRONG` حرفاً قوياً.
   *
   * الهستيريزيس (تثبيت الاتجاه بعد أول حسم) مرفوضة عمداً: قياسها 2.79% ثمناً،
   * وهي تنقل الانقلاب إلى لحظة الإنهاء وتُدخل حالةً قابلة للتعفّن في دالة نقيّة.
   */
  streaming?: boolean;
};

/**
 * LEVEL 2 — اتجاه الحاوية بتصويت الكتل: كتلة واحدة = صوت واحد.
 *
 * عدّ الحروف على مستوى الرسالة منحاز بنيوياً للاتينية (انظر رأس الملف)، فالتصويت
 * يُسقط الانحياز: فقرة إنجليزية واحدة وسط فقرتين عربيتين تخسر 1–2 مهما طالت.
 *
 * الدالة نقيّة: لا ذاكرة بين النداءات، ونفس المدخل يعطي نفس المخرَج دائماً.
 */
export function resolveContainerDirection(
  source: string | null | undefined,
  options: ContainerDirectionOptions = {}
): TextDirection | null {
  const streaming = options.streaming === true;
  const all = splitMarkdownBlocks(source);
  // D — الكتلة الأخيرة قيد الكتابة: نصف جملة تصوّت كأنها فقرة كاملة، فتقلب
  // الحاوية ثم تتراجع حين تكتمل. تُسقَط ما دام يبقى مَن يصوّت غيرها.
  const blocks = streaming && all.length > 1 ? all.slice(0, -1) : all;

  // B — عتبة الحسم: تُحسب على الكتل المصوِّتة وحدها، لا على النصّ الخام.
  if (streaming) {
    const strong = blocks.reduce(
      (total, block) => total + countStrong(block, 'rtl') + countStrong(block, 'ltr'),
      0
    );
    if (strong < STREAMING_MIN_STRONG) return null;
  }

  let rtl = 0;
  let ltr = 0;
  let firstVoter: TextDirection | null = null;

  for (const block of blocks) {
    const dir = resolveTextDirection(block);
    if (!dir) continue;
    firstVoter ??= dir;
    if (dir === 'rtl') rtl += 1;
    else ltr += 1;
  }

  if (rtl === 0 && ltr === 0) {
    // أثناء البثّ لا نعود إلى النصّ الخام: ذلك يُعيد الكتلة النامية إلى القرار
    // من الباب الخلفي، وهو بالضبط ما تمنعه D.
    return streaming ? null : resolveTextDirection(source ?? '');
  }
  if (rtl !== ltr) return rtl > ltr ? 'rtl' : 'ltr';
  return firstVoter; // تعادل ⇒ اتجاه أول كتلة مصوِّتة
}

/**
 * LEVEL 3 — هل تستحق هذه الكتلة سِمة `dir` صريحة تخالف الحاوية؟
 *
 * الشرط تحفّظي عمداً: الكتلة تُمنح اتجاهاً مخالفاً فقط إذا خلت **تماماً** من
 * حروف قوية باتجاه الحاوية — أي فقرة أحادية اللغة فعلاً. أي كتلة مختلطة ترث
 * اتجاه الحاوية، فلا ينقلب عنوان مثل `T-975 — Login V1 أم V2؟` لمجرد أن
 * اللاتينية تفوقت عددياً فيه.
 *
 * `undefined` تعني: لا سِمة أصلاً ⇒ وراثة.
 */
export function resolveBlockDirection(
  blockText: string | null | undefined,
  containerDir: TextDirection | null | undefined
): TextDirection | undefined {
  if (!containerDir || !blockText) return undefined;
  const own = resolveTextDirection(blockText);
  if (!own || own === containerDir) return undefined;
  if (countStrong(blockText, containerDir) > 0) return undefined;
  return own;
}
