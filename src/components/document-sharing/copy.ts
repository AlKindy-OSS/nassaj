import { useTranslation } from 'react-i18next';

const ar = {
  share: 'مشاركة المستند', loading: 'جارٍ التحقق من الرابط…', loadingDetail: 'نراجع إمكانية الوصول إلى المستند بأمان.',
  unavailable: 'هذا الرابط غير متاح', unavailableDetail: 'تحقّق من الرابط أو اطلب من مرسله رابطًا صالحًا.',
  login: 'سجّل الدخول للمتابعة', loginDetail: 'سنُعيدك إلى المستند بعد تسجيل الدخول.', signIn: 'تسجيل الدخول',
  denied: 'لا يمكنك الوصول بهذا الحساب', deniedDetail: 'جرّب حسابًا آخر أو تواصل مع مرسل الرابط.', switchAccount: 'استخدام حساب آخر',
  temporary: 'تعذّر فتح المستند مؤقتًا', temporaryDetail: 'تحقّق من اتصالك ثم أعد المحاولة. قد يكون المستند قيد الحفظ.',
  retry: 'إعادة المحاولة', home: 'الانتقال إلى نسّاج', ready: 'المستند جاهز', download: 'تنزيل المستند', downloading: 'جارٍ التنزيل…',
  latest: 'تظهر أحدث نسخة محفوظة عند فتح الرابط أو تحديث الصفحة.', updated: 'آخر تعديل', empty: 'هذا المستند فارغ حاليًا.',
  audience: 'من يستطيع الوصول؟', members: 'أعضاء المشروع', client: 'كل من يحمل الرابط', expires: 'انتهاء الصلاحية (اختياري)',
  create: 'إنشاء الرابط ونسخه', creating: 'جارٍ إنشاء الرابط…', copy: 'نسخ الرابط', copied: 'نُسخ الرابط', created: 'رابط المشاركة جاهز',
  copyFailed: 'أُنشئ الرابط، لكن تعذّر نسخه تلقائيًا. انسخه من الحقل أدناه.',
  uncertain: 'تعذّر تأكيد نتيجة الإنشاء. قد تكون المشاركة أُنشئت؛ راجع المشاركات الحالية قبل إنشاء رابط آخر.',
  preview: 'معاينة آمنة للصفحة', previewLimit: 'عرض ثابت دون JavaScript أو موارد خارجية.',
  previewWarning: 'حُذفت عناصر أو موارد غير مدعومة من المعاينة الآمنة.',
  previewFailed: 'تعذّر تحميل المعاينة. أعد المحاولة أو نزّل المستند.',
  assetScope: 'تتضمن المشاركة الموارد المشار إليها داخل هذا المجلد فقط',
  warning: 'سيتيح الرابط التعديلات المستقبلية المحفوظة أيضًا، بما فيها استبدال الملف في المسار نفسه.',
  bearer: 'يمكن إعادة إرسال رابط العميل. الإلغاء يمنع الطلبات التالية ولا يسترجع النسخ التي سبق تنزيلها.',
  existing: 'مشاركات المشروع الحالية', none: 'لم تُنشأ مشاركات للمشروع بعد.', revoke: 'إلغاء المشاركة', revoked: 'أُلغيت المشاركة',
  expired: 'منتهية', active: 'فعّالة', noExpiry: 'دون انتهاء', save: 'حفظ التغييرات', saving: 'جارٍ الحفظ…', edit: 'تعديل الارتباط',
  path: 'مسار المستند داخل المشروع', pathHint: 'ملف داخل doc أو docs؛ يبقى الرابط نفسه عند تحديث الارتباط.',
  invalid: 'اختر مستندًا مدعومًا داخل doc أو docs، وتاريخ انتهاء مستقبليًا أو اتركه فارغًا.',
  oneTime: 'انسخ رابط العميل الآن؛ لا يمكن استرجاع رمزه بعد إغلاق هذه النافذة.', close: 'إغلاق',
  size: 'الحد الأقصى 25 ميغابايت. الصيغ: PDF وWord وExcel والنصوص وMarkdown وCSV وHTML وHTM وXHTML.',
  failed: 'تعذّر إكمال العملية. تحقّق من الصلاحية والملف ثم أعد المحاولة.', membersHint: 'منشئ المشروع وأعضاؤه المضافون صراحة، والمالك والمشرف.',
};
const en: typeof ar = {
  share: 'Share document', loading: 'Checking this link…', loadingDetail: 'Securely checking access to this document.',
  unavailable: 'This link is unavailable', unavailableDetail: 'Check the link or ask its sender for a valid one.',
  login: 'Sign in to continue', loginDetail: 'We will return you to the document after you sign in.', signIn: 'Sign in',
  denied: 'This account cannot access the document', deniedDetail: 'Try another account or contact the sender.', switchAccount: 'Use another account',
  temporary: 'The document is temporarily unavailable', temporaryDetail: 'Check your connection and try again. The document may be saving.',
  retry: 'Try again', home: 'Go to Nassaj', ready: 'Your document is ready', download: 'Download document', downloading: 'Downloading…',
  latest: 'Open or refresh this page to access the latest saved content.', updated: 'Last updated', empty: 'This document is currently empty.',
  audience: 'Who can access?', members: 'Project members', client: 'Anyone with the link', expires: 'Expires at (optional)',
  create: 'Create and copy link', creating: 'Creating link…', copy: 'Copy link', copied: 'Link copied', created: 'Your share link is ready',
  copyFailed: 'The link was created but automatic copying failed. Copy it from the field below.',
  uncertain: 'The creation result could not be confirmed. A share may exist; review current shares before creating another.',
  preview: 'Safe page preview', previewLimit: 'Static display without JavaScript or external resources.',
  previewWarning: 'Unsupported elements or resources were removed from the safe preview.',
  previewFailed: 'Unable to load the preview. Retry or download the document.',
  assetScope: 'Sharing includes referenced resources only within this directory',
  warning: 'The link also grants access to future saved changes, including a replacement file at the same path.',
  bearer: 'Client links can be forwarded. Revocation blocks subsequent requests; it cannot retrieve downloaded copies.',
  existing: 'Current project shares', none: 'This project has no shares yet.', revoke: 'Revoke share', revoked: 'Revoked',
  expired: 'Expired', active: 'Active', noExpiry: 'No expiry', save: 'Save changes', saving: 'Saving…', edit: 'Edit link target',
  path: 'Document path within the project', pathHint: 'A file in doc or docs. Relinking preserves the share URL.',
  invalid: 'Choose a supported document in doc or docs and a future expiry, or leave expiry blank.',
  oneTime: 'Copy the client link now. Its secret cannot be retrieved after closing this dialog.', close: 'Close',
  size: 'Maximum 25 MiB. Formats: PDF, Word, Excel, text, Markdown, CSV, HTML, HTM and XHTML.',
  failed: 'Unable to complete the operation. Check access and the file, then try again.', membersHint: 'The project creator, explicitly added project members, owners and administrators.',
};

/** Reuse the current app language and identity without introducing a second theme. */
export function useSharingCopy() {
  const { i18n } = useTranslation();
  return i18n.language.startsWith('ar') ? ar : en;
}
