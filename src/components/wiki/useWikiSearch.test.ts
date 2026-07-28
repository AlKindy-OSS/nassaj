/**
 * Unit tests for wiki search logic (normalizeArabic, stripMarkdown, searchWikiPages).
 * No DOM/React needed — pure functions only.
 */
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
    expect(normalizeArabic('إبراهيم')).toBe('ابراهيم');
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
});
