/** Viewer strings. Local to the share page: it must not import app i18n. */
export type ViewerLocale = 'ar' | 'en';

export interface ViewerStrings {
  lang: ViewerLocale;
  dir: 'rtl' | 'ltr';
  defaultTitle: string;
  loading: string;
  unavailableTitle: string;
  unavailable: string;
  rateLimitedTitle: string;
  rateLimited: string;
  networkTitle: string;
  network: string;
  retry: string;
  readOnlyNote: string;
  createdOn: (date: string) => string;
  expiresOn: (date: string) => string;
  messagesHeading: string;
  owner: string;
  assistant: string;
  toolsUsed: (count: number) => string;
  redaction: Record<'secret' | 'path' | 'network' | 'image' | 'system' | 'generic', string>;
}

const AR: ViewerStrings = {
  lang: 'ar',
  dir: 'rtl',
  defaultTitle: 'محادثة مشتركة',
  loading: 'جارٍ التحميل…',
  unavailableTitle: 'المحادثة غير متاحة',
  unavailable: 'تعذّر عرض هذه المحادثة. قد يكون الرابط غير صحيح أو منتهياً أو أُلغيت مشاركته.',
  rateLimitedTitle: 'طلبات كثيرة',
  rateLimited: 'تجاوزت عدد المحاولات المسموح. انتظر نحو دقيقة ثم أعد المحاولة.',
  networkTitle: 'تعذّر الاتصال',
  network: 'لم نتمكن من تحميل المحادثة. تحقّق من اتصالك ثم أعد المحاولة.',
  retry: 'إعادة المحاولة',
  readOnlyNote: 'نسخة للقراءة فقط من محادثة نسّاج',
  createdOn: (date) => `أُنشئت ${date}`,
  expiresOn: (date) => `ينتهي الرابط ${date}`,
  messagesHeading: 'الرسائل',
  owner: 'صاحب المحادثة',
  assistant: 'المساعد',
  toolsUsed: (count) => {
    const form = new Intl.PluralRules('ar').select(count);
    if (form === 'one') return 'استُخدمت أداة واحدة';
    if (form === 'two') return 'استُخدمت أداتان';
    return form === 'few' ? `استُخدمت ${count} أدوات` : `استُخدمت ${count} أداة`;
  },
  redaction: {
    secret: 'محتوى سرّي محذوف',
    path: 'مسار محذوف',
    network: 'عنوان شبكة محذوف',
    image: 'صورة محذوفة',
    system: 'محتوى نظامي محذوف',
    generic: 'محتوى محذوف',
  },
};

const EN: ViewerStrings = {
  lang: 'en',
  dir: 'ltr',
  defaultTitle: 'Shared conversation',
  loading: 'Loading…',
  unavailableTitle: 'Conversation unavailable',
  unavailable: 'This conversation cannot be shown. The link may be wrong, expired, or no longer shared.',
  rateLimitedTitle: 'Too many requests',
  rateLimited: 'Too many attempts. Wait about a minute, then try again.',
  networkTitle: 'Connection problem',
  network: 'The conversation could not be loaded. Check your connection and try again.',
  retry: 'Try again',
  readOnlyNote: 'Read-only snapshot of a Nassaj conversation',
  createdOn: (date) => `Created ${date}`,
  expiresOn: (date) => `Link expires ${date}`,
  messagesHeading: 'Messages',
  owner: 'Conversation owner',
  assistant: 'Assistant',
  toolsUsed: (count) => (count === 1 ? '1 tool used' : `${count} tools used`),
  redaction: {
    secret: 'Secret removed',
    path: 'Path removed',
    network: 'Network address removed',
    image: 'Image removed',
    system: 'System content removed',
    generic: 'Content removed',
  },
};

/** Arabic is the default; English only when the browser asks for it explicitly. */
export function pickLocale(language: string | undefined): ViewerStrings {
  return /^en(?:[-_]|$)/i.test(language ?? '') ? EN : AR;
}

/** The server's English default title is replaced by the viewer's localized one. */
export function displayTitle(title: string, strings: ViewerStrings): string {
  const trimmed = title.trim();
  return !trimmed || trimmed === EN.defaultTitle ? strings.defaultTitle : trimmed;
}

export function formatDate(iso: string | undefined, strings: ViewerStrings, withTime: boolean): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(strings.lang, { dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' } : {}) }).format(date);
}
