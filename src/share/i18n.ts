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
  member: string;
  redaction: Record<'secret' | 'path' | 'network' | 'image' | 'system' | 'truncated' | 'generic', string>;
  live: {
    badgeLive: string;
    badgeEnded: string;
    readOnlyNote: string;
    working: string;
    stale: string;
    retrying: string;
    rateLimitedNotice: string;
    loadOlder: string;
    loadingOlder: string;
    olderFailed: string;
    newMessages: (count: number) => string;
    endedTitle: string;
    ended: string;
    empty: string;
    conversationLabel: string;
  };
  attachment: { imageAlt: string; gone: string; tooLarge: string; download: string; unavailableImage: string; unavailableFile: string };
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
  owner: 'المالك',
  member: 'عضو',
  assistant: 'المساعد',
  redaction: {
    secret: 'محتوى سرّي محذوف',
    path: 'مسار محذوف',
    network: 'عنوان شبكة محذوف',
    image: 'صورة محذوفة',
    system: 'محتوى نظامي محذوف',
    truncated: 'اقتُطع باقي الرسالة لطولها',
    generic: 'محتوى محذوف',
  },
  live: {
    badgeLive: 'مباشر',
    badgeEnded: 'انتهى',
    readOnlyNote: 'عرض مباشر للقراءة فقط لمحادثة نسّاج',
    working: 'المساعد يعمل الآن…',
    stale: 'قد لا تكون أحدث الرسائل ظاهرة. نحاول التحديث.',
    retrying: 'تعذّر التحديث مؤقتاً. نعيد المحاولة تلقائياً.',
    rateLimitedNotice: 'طلبات كثيرة. سنعاود التحديث بعد قليل.',
    loadOlder: 'تحميل رسائل أقدم',
    loadingOlder: 'جارٍ تحميل رسائل أقدم…',
    olderFailed: 'تعذّر تحميل الرسائل الأقدم.',
    newMessages: (count) => {
      const form = new Intl.PluralRules('ar').select(count);
      if (form === 'one') return 'رسالة جديدة';
      if (form === 'two') return 'رسالتان جديدتان';
      return form === 'few' ? `${count} رسائل جديدة` : `${count} رسالة جديدة`;
    },
    endedTitle: 'انتهت هذه المشاركة',
    ended: 'لم يعد هذا الرابط فعّالاً. ما سبق عرضه يبقى ظاهراً لكن لن تصل رسائل جديدة.',
    empty: 'لا رسائل بعد.',
    conversationLabel: 'المحادثة',
  },
  attachment: {
    imageAlt: 'صورة مرفقة',
    gone: 'المرفق لم يعد متاحاً',
    tooLarge: 'المرفق كبير جداً للعرض',
    download: 'تنزيل المرفق',
    unavailableImage: 'صورة غير متاحة',
    unavailableFile: 'ملف غير متاح',
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
  owner: 'Owner',
  member: 'Member',
  assistant: 'Assistant',
  redaction: {
    secret: 'Secret removed',
    path: 'Path removed',
    network: 'Network address removed',
    image: 'Image removed',
    system: 'System content removed',
    truncated: 'The rest of this message was cut for length',
    generic: 'Content removed',
  },
  live: {
    badgeLive: 'Live',
    badgeEnded: 'Ended',
    readOnlyNote: 'Live read-only view of a Nassaj conversation',
    working: 'The assistant is working…',
    stale: 'The latest messages may not be showing. Trying to refresh.',
    retrying: 'Temporarily unable to refresh. Retrying automatically.',
    rateLimitedNotice: 'Too many requests. Refreshing again shortly.',
    loadOlder: 'Load older messages',
    loadingOlder: 'Loading older messages…',
    olderFailed: 'Older messages could not be loaded.',
    newMessages: (count) => (count === 1 ? '1 new message' : `${count} new messages`),
    endedTitle: 'This share has ended',
    ended: 'This link is no longer active. What was shown stays visible, but no new messages will arrive.',
    empty: 'No messages yet.',
    conversationLabel: 'Conversation',
  },
  attachment: {
    imageAlt: 'Attached image',
    gone: 'Attachment no longer available',
    tooLarge: 'Attachment too large to show',
    download: 'Download attachment',
    unavailableImage: 'Image unavailable',
    unavailableFile: 'File unavailable',
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
