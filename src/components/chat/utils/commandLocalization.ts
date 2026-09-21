import type { LLMProvider } from '../../../types/app';

export type CommandViewModel = {
  /** Canonical, executable slash spelling supplied by the provider. */
  canonicalName: string;
  /** Localized human-facing title; absent for dynamic commands without a catalog entry. */
  title?: string;
  /** Localized description when one is deliberately maintained. */
  description?: string;
  /** Localized spellings accepted by the composer, never sent to a provider. */
  aliases: string[];
  /** Terms used only by the client-side command-menu search. */
  searchTerms: string[];
};

type CatalogEntry = { title: string; description: string; aliases?: string[] };

const ARABIC_CODEX_CATALOG: Record<string, CatalogEntry> = {
  '/help': { title: 'مساعدة', description: 'اعرض أوامر Codex ومعلومات الاستخدام.' },
  '/models': { title: 'النماذج', description: 'اعرض النماذج المتاحة في جلسة Codex.' },
  '/model': { title: 'النموذج', description: 'اعرض النموذج الحالي أو غيّره.' },
  '/cost': { title: 'التكلفة', description: 'اعرض استهلاك الجلسة وتكلفتها.' },
  '/status': { title: 'الحالة', description: 'اعرض حالة النظام والجلسة.' },
  '/compact': { title: 'ضغط', description: 'اضغط سياق Codex الحالي.', aliases: ['/ضغط'] },
  '/usage': { title: 'الاستخدام', description: 'اعرض حدود الاستخدام المتاحة.' },
  '/mcp': { title: 'اتصال MCP', description: 'اعرض تكاملات MCP المتاحة.' },
  '/skills': { title: 'المهارات', description: 'اعرض مهارات Codex المتاحة.' },
  '/hooks': { title: 'الخطافات', description: 'اعرض الخطافات المهيأة.' },
  '/apps': { title: 'التطبيقات', description: 'اعرض التطبيقات المتصلة.' },
  '/rename': { title: 'إعادة التسمية', description: 'غيّر اسم المحادثة الحالية.' },
  '/goal': { title: 'الهدف', description: 'اعرض هدف المحادثة أو حدّثه.' },
  '/side': {
    title: 'سؤال جانبي',
    description: 'اطرح سؤالاً جانبياً ضمن سياق جلسة Codex الحالية.',
    aliases: ['/جانبي', '/بالمناسبة'],
  },
  '/btw': {
    title: 'بالمناسبة',
    description: 'اطرح سؤالاً جانبياً ضمن سياق جلسة Codex الحالية.',
    aliases: ['/جانبي', '/بالمناسبة'],
  },
};

const isArabic = (language: string | undefined) => language?.toLowerCase().startsWith('ar') === true;

/**
 * Builds the display/search-only command data without changing its canonical
 * executable name. Unknown dynamic skills intentionally retain provider text.
 */
export function createCommandViewModel(
  name: string,
  description: string | undefined,
  provider: LLMProvider,
  language: string | undefined,
  kind: string | undefined = 'built-in',
): CommandViewModel {
  const entry = isArabic(language) && provider === 'codex' && (kind === 'built-in' || kind === 'btw')
    ? ARABIC_CODEX_CATALOG[name]
    : undefined;
  const aliases = entry?.aliases ?? [];
  return {
    canonicalName: name,
    title: entry?.title,
    description: entry?.description ?? description,
    aliases,
    searchTerms: [name, description, entry?.title, entry?.description, ...aliases]
      .filter((term): term is string => Boolean(term?.trim()))
      .map((term) => term.toLocaleLowerCase()),
  };
}

/**
 * Converts only an Arabic UI alias in the first slash token to its canonical
 * command. The remainder is untouched, so it can safely carry a side question.
 */
export function normalizeArabicSlashCommand(
  input: string,
  provider: LLMProvider | string,
  language: string | undefined,
): string {
  if (!isArabic(language) || typeof input !== 'string') return input;
  const match = input.match(/^(\s*)(\/\S+)([\s\S]*)$/u);
  if (!match) return input;

  const [, leading, token, remainder] = match;
  let canonical: string | undefined;
  if (provider === 'codex' && token === '/ضغط') canonical = '/compact';
  if (provider === 'codex' && (token === '/جانبي' || token === '/بالمناسبة')) canonical = '/side';
  return canonical ? `${leading}${canonical}${remainder}` : input;
}

/** Returns whether an input starts with a reserved Arabic Codex side alias. */
export function isArabicCodexSideAlias(input: string, provider: LLMProvider | string, language: string | undefined): boolean {
  return isArabic(language) && provider === 'codex' && /^\s*\/(?:جانبي|بالمناسبة)(?=\s|$)/u.test(input);
}
