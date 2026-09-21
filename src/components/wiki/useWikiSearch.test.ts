/**
 * Unit tests for wiki search logic (normalizeArabic, stripMarkdown, searchWikiPages).
 * No DOM/React needed — pure functions only.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  normalizeArabic,
  stripMarkdown,
  buildSnippet,
  searchWikiPages,
} from './useWikiSearch';

// ---------------------------------------------------------------------------
// normalizeArabic
// ---------------------------------------------------------------------------

describe('normalizeArabic', () => {
  it('removes tashkeel from Arabic text', () => {
    expect(normalizeArabic('مُهِمَّة')).toBe('مهمه');
  });

  it('normalizes Alef variants to plain Alef', () => {
    expect(normalizeArabic('أحمد')).toBe('احمد');
    expect(normalizeArabic('أحمد')).toBe('احمد');
    expect(normalizeArabic('آمال')).toBe('امال');
  });

  it('normalizes Taa marbuta to Haa so "مهمة" matches "مهمه"', () => {
    const a = normalizeArabic('مهمة');
    const b = normalizeArabic('مهمه');
    expect(a).toBe(b);
  });

  it('normalizes Yaa variants', () => {
    expect(normalizeArabic('يمنى')).toBe('يمني');
  });

  it('lowercases Latin characters', () => {
    expect(normalizeArabic('Claude Code')).toBe('claude code');
  });

  it('strips shadda (part of tashkeel range) so "نسّاج" matches "نساج"', () => {
    // U+0651 (shadda) is within the tashkeel range 064B–065F and is intentionally removed
    // so that a user typing without shadda still finds results.
    expect(normalizeArabic('نسّاج')).toBe('نساج');
    expect(normalizeArabic('نساج')).toBe('نساج');
  });
});

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

describe('stripMarkdown', () => {
  it('removes heading markers', () => {
    const result = stripMarkdown('## عنوان\nنص عادي');
    expect(result).not.toContain('##');
    expect(result).toContain('عنوان');
    expect(result).toContain('نص عادي');
  });

  it('removes bold/italic markers', () => {
    const result = stripMarkdown('**مهم** و*تنبيه*');
    expect(result).not.toContain('*');
    expect(result).toContain('مهم');
  });

  it('removes link syntax but keeps link text', () => {
    const result = stripMarkdown('[نسّاج](https://example.com)');
    expect(result).toContain('نسّاج');
    expect(result).not.toContain('https://example.com');
  });

  it('removes fenced code blocks', () => {
    const md = '```js\nconsole.log("hello");\n```';
    const result = stripMarkdown(md);
    expect(result).not.toContain('console.log');
  });

  it('removes blockquote markers', () => {
    const result = stripMarkdown('> ملاحظة مهمة');
    expect(result).toContain('ملاحظة مهمة');
    expect(result).not.toContain('>');
  });

  it('removes inline SVG diagrams whole', () => {
    const md = [
      'قبل المخطّط.',
      '<svg viewBox="0 0 720 500">',
      '  <rect x="1" y="1" width="200" height="60" fill="hsl(var(--card))" />',
      '  <text x="10" y="20" font-size="13" fill="hsl(var(--foreground))">حصة كافية</text>',
      '</svg>',
      'بعد المخطّط.',
    ].join('\n');
    const result = stripMarkdown(md);
    expect(result).toContain('قبل المخطّط.');
    expect(result).toContain('بعد المخطّط.');
    expect(result).not.toContain('font-size');
    expect(result).not.toContain('viewBox');
    expect(result).not.toContain('<');
  });

  it('leaves an <svg> shown inside a code fence from eating the prose after it', () => {
    // The SVG rule runs after the fence rule for this reason: an unbalanced or
    // illustrative `<svg` in a sample must not swallow the rest of the page.
    const md = '```html\n<svg><text>مثال</text></svg>\n```\nالنص التالي.';
    expect(stripMarkdown(md)).toContain('النص التالي.');
  });
});

// ---------------------------------------------------------------------------
// stripMarkdown against the pages that actually ship
// ---------------------------------------------------------------------------

describe('stripMarkdown on the shipped diagram pages', () => {
  // Read the real files rather than a hand-made fixture: the defect was that a
  // synthetic corpus has no 400-line hand-written SVG in it, so the indexer
  // looked correct in tests while search results showed readers raw markup.
  const here = dirname(fileURLToPath(import.meta.url));
  const WIKI_DIR = resolve(here, '../../../docs/team-wiki');
  const DIAGRAM_PAGES = ['30-coordinator-agents.md', '31-task-journey.md'];

  it.each(DIAGRAM_PAGES)('%s indexes no markup', (file) => {
    const raw = readFileSync(resolve(WIKI_DIR, file), 'utf8');
    expect(raw).toContain('<svg'); // the fixture is only meaningful if it has one
    const plain = stripMarkdown(raw);
    for (const marker of ['<svg', '<text', 'font-size=', 'fill=', 'viewBox', '</']) {
      expect(plain, `"${marker}" survived into the indexed text of ${file}`).not.toContain(
        marker,
      );
    }
  });

  it.each(DIAGRAM_PAGES)('%s still indexes its prose', (file) => {
    const raw = readFileSync(resolve(WIKI_DIR, file), 'utf8');
    const plain = stripMarkdown(raw);
    // The body text around the diagrams has to survive, or the fix would have
    // traded a bad snippet for an unfindable page.
    expect(plain.length).toBeGreaterThan(1000);
    expect(plain).toContain('المنسّق');
  });

  it('builds a snippet with no markup in it', () => {
    const raw = readFileSync(resolve(WIKI_DIR, '31-task-journey.md'), 'utf8');
    const plain = stripMarkdown(raw);
    const normalized = normalizeArabic(plain);
    const term = normalizeArabic('المنسّق');
    const snippet = buildSnippet(plain, normalized, term);
    expect(snippet).toBeTruthy();
    expect(snippet).not.toContain('<');
    expect(snippet).not.toContain('font-');
  });
});

// ---------------------------------------------------------------------------
// buildSnippet
// ---------------------------------------------------------------------------

describe('buildSnippet', () => {
  it('returns a snippet containing the matched term', () => {
    const text = 'هذا نص طويل يحتوي على كلمة مهمة في المنتصف وبعدها نص آخر';
    const normalized = normalizeArabic(text);
    const query = 'مهمه'; // normalized form of مهمة
    const snippet = buildSnippet(text, normalized, query);
    expect(snippet).toBeDefined();
    expect(snippet).toContain('مهم');
  });

  it('returns undefined when term not found', () => {
    const text = 'نص بسيط';
    const normalized = normalizeArabic(text);
    const snippet = buildSnippet(text, normalized, 'غائب');
    expect(snippet).toBeUndefined();
  });

  it('adds ellipsis when context is truncated', () => {
    const long = 'أ'.repeat(200) + 'هدف' + 'ب'.repeat(200);
    const normalized = normalizeArabic(long);
    const snippet = buildSnippet(long, normalized, 'هدف');
    expect(snippet).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// searchWikiPages
// ---------------------------------------------------------------------------

describe('searchWikiPages', () => {
  const pages = [
    { file: 'page1.md', title: 'مقدمة عن نسّاج' },
    { file: 'page2.md', title: 'الأسئلة الشائعة' },
    { file: 'page3.md', title: 'المسرد' },
  ];

  const rawContents: Record<string, string> = {
    'page1.md': '## نسّاج\nهذا شرح المشروع وأهدافه.',
    'page2.md': '## أسئلة\n**ما هو Claude؟** هو نموذج ذكاء اصطناعي.',
    'page3.md': '## مفاهيم\nالمنسّق هو الوكيل المنسِّق.',
  };

  it('returns empty array for empty query', () => {
    expect(searchWikiPages('', pages, rawContents)).toHaveLength(0);
  });

  it('returns empty array for whitespace query', () => {
    expect(searchWikiPages('   ', pages, rawContents)).toHaveLength(0);
  });

  it('finds match by title', () => {
    const results = searchWikiPages('الأسئلة', pages, rawContents);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('page2.md');
  });

  it('finds match in body content', () => {
    const results = searchWikiPages('ذكاء اصطناعي', pages, rawContents);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe('page2.md');
    expect(results[0].snippet).toBeDefined();
  });

  it('applies Arabic normalization — query أهداف matches أهدافه', () => {
    // "أهداف" normalized = "اهداف", "أهدافه" normalized contains "اهداف"
    const results = searchWikiPages('أهداف', pages, rawContents);
    expect(results.some((r) => r.file === 'page1.md')).toBe(true);
  });

  it('applies Taa marbuta normalization — query مهمه matches مهمة', () => {
    const pages2 = [{ file: 'p.md', title: 'تفاصيل' }];
    const raw2 = { 'p.md': 'هذه المهمة مهمة جداً.' };
    const results = searchWikiPages('مهمه', pages2, raw2);
    expect(results).toHaveLength(1);
  });

  it('is case-insensitive for Latin characters', () => {
    const pgs = [{ file: 'p.md', title: 'Claude Code' }];
    const raw = { 'p.md': 'Welcome to claude code integration.' };
    const results = searchWikiPages('CLAUDE', pgs, raw);
    expect(results).toHaveLength(1);
  });

  it('returns multiple matches when query appears in multiple pages', () => {
    // "نسّاج" appears in page1 title and page1 body
    const results = searchWikiPages('نسّاج', pages, rawContents);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.file === 'page1.md')).toBe(true);
  });

  it('includes matchedTerm in results', () => {
    const results = searchWikiPages('المسرد', pages, rawContents);
    expect(results[0].matchedTerm).toBe('المسرد');
  });

  // ── Multi-term matching ───────────────────────────────────────────────────
  // Phrase-only matching used to return nothing for any query whose words are
  // not adjacent in the source — which is how people actually search.

  it('matches terms that are scattered across the page, not just adjacent', () => {
    const pgs = [{ file: 'p.md', title: 'حلّ المشاكل' }];
    const raw = { 'p.md': 'الجلسة لا تستجيب أحياناً.\n\nالمحادثة تبدو معلّقة بلا ردّ.' };
    // "الجلسة معلقة" appears nowhere as a phrase; both words appear separately.
    const results = searchWikiPages('الجلسة معلقة', pgs, raw);
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBeDefined();
  });

  it('requires every term — a page missing one of them does not match', () => {
    const pgs = [{ file: 'p.md', title: 'صفحة' }];
    const raw = { 'p.md': 'الجلسة تعمل بشكل طبيعي.' };
    expect(searchWikiPages('الجلسة معلقة', pgs, raw)).toHaveLength(0);
  });

  it('matches against summary and keywords from the index', () => {
    const pgs = [
      {
        file: 'p.md',
        title: 'صفحة',
        summary: 'كل شيء عن التصدير',
        keywords: ['pdf', 'طباعة'],
      },
    ];
    const raw = { 'p.md': 'نصّ لا يذكر الكلمة المطلوبة.' };
    expect(searchWikiPages('طباعة', pgs, raw)).toHaveLength(1);
    expect(searchWikiPages('PDF', pgs, raw)).toHaveLength(1);
  });

  it('ranks a title match above a body-only match', () => {
    const pgs = [
      { file: 'body.md', title: 'صفحة أخرى' },
      { file: 'title.md', title: 'الحصة ونافذة السياق' },
    ];
    const raw = {
      'body.md': 'نذكر الحصة مرة واحدة هنا في المتن.',
      'title.md': 'محتوى لا يذكر الكلمة إطلاقاً.',
    };
    const results = searchWikiPages('الحصة', pgs, raw);
    expect(results).toHaveLength(2);
    expect(results[0].file).toBe('title.md');
  });

  it('ranks a keyword hit above a page that only mentions the words in passing', () => {
    // Observed live: searching "الجلسة معلقة" put an unrelated page first,
    // because "all terms in the keywords" was false for both and the tie fell
    // back to index order. One term in the keywords must outweigh none.
    const pgs = [
      { file: 'unrelated.md', title: 'دورة البناء' },
      { file: 'answer.md', title: 'عندي مشكلة', keywords: ['معلقة', 'عالقة'] },
    ];
    const raw = {
      'unrelated.md': 'تعمل الجلسة كل عشر دقائق وقد تبدو معلقة أثناء البناء.',
      'answer.md': 'إذا توقّفت الجلسة عن الردّ فابدأ من هنا.',
    };
    const results = searchWikiPages('الجلسة معلقة', pgs, raw);
    expect(results).toHaveLength(2);
    expect(results[0].file).toBe('answer.md');
  });

  it('carries the section label through to the result', () => {
    const pgs = [{ file: 'p.md', title: 'صفحة', section: 'حلّ المشاكل' }];
    const raw = { 'p.md': 'محتوى.' };
    expect(searchWikiPages('صفحة', pgs, raw)[0].section).toBe('حلّ المشاكل');
  });
});
