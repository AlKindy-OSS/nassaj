/**
 * Curated "What's new" highlights, one entry per released version.
 *
 * Written for the user in plain language, in both Arabic and English, and
 * shipped with the client. The release-notes step of docs/RELEASING.md adds
 * the entry for each new version. A version without an entry shows no popup.
 */

export interface WhatsNewEntry {
  ar: readonly string[];
  en: readonly string[];
}

export const WHATS_NEW: Readonly<Record<string, WhatsNewEntry>> = {
  '2.3.3.2': {
    ar: [
      'محادثات OpenCode على نموذج محلي صغير تعمل بتعليمات مختصرة تناسب سعته.',
      'المنسّق المحلي بلا جلب ويب، ويفوّض إلى خمسة وكلاء فقط.',
      'وكيل البحث وحده يعمل على نموذج سحابي مجاني، ولا يقرأ ملفات الأسرار.',
      'Codex يعمل على خادم النماذج المحلي الخاص بك، بمفتاح يفعّله المالك أو المدير.',
      'أدوار النماذج المحلية تُحسب بتكلفة صفر.',
      'إعدادات DeepSeek Harness ظاهرة في الإعدادات.',
      'تستطيع أن تكتب في محادثة Claude بدأها زميلك في المشروع نفسه.',
      'يحدّد المالك أكبر حجم للمرفق بين 1 و200 ميغابايت.',
      'لم تعد تعليمات النظام تظهر في سجلّ محادثات Antigravity.',
    ],
    en: [
      'OpenCode chats on a small local model run with compact instructions that fit its context.',
      'The local coordinator has no web fetch and delegates to five agents only.',
      'Only the researcher runs on a free cloud model, and it cannot read secret files.',
      'Codex runs on your own local model server, behind a switch the owner or an admin turns on.',
      'Local model turns are booked at zero cost.',
      'The DeepSeek Harness settings are visible in Settings.',
      'You can write in a Claude conversation a teammate started in the same project.',
      'The owner sets the largest attachment size, between 1 and 200 MB.',
      'System instructions no longer show in Antigravity chat history.',
    ],
  },
  '2.3.3.1': {
    ar: [
      'تغيير جوهري: لم يعد أي عضو يعمل على اشتراك المالك ضمنياً. اربط اشتراكك الخاص أو اطلب منحة من المالك.',
      'السياسة القديمة محفوظة في السجلّ، ولم يُحذف أي مفتاح مزوّد.',
      'أُغلقت ثغرات في إعدادات المشروع وحماية بيانات اعتماد الأعضاء.',
      'قواعد الرفض والسماح في Claude تُطبَّق على OpenCode وDeepSeek Harness.',
      'وكيل DeepSeek Harness الجديد بنسخة معاينة، وتحديثاته تمرّ بزرّ المالك.',
      'يُفحص حجم النموذج قبل تغييره، ويُحذَّر من نموذج أصغر من أن يسع المحادثة.',
      'الرسائل بين أعضاء مختلفين تنتظر موافقة المالك.',
      'خادم النماذج المحلي داخل Claude متاح، ومعطّل افتراضياً.',
      'إصلاحات في OpenCode: ردّ لا يتكرّر، ونموذج صحيح في المنتقي، وتكلفة لا تتضاعف.',
    ],
    en: [
      'Breaking change: no member runs on the owner\'s subscription implicitly any more. Link your own subscription or ask the owner for a grant.',
      'The old policy is kept in the record, and no provider key was deleted.',
      'Gaps in project settings and member credential protection are closed.',
      'Claude\'s deny and ask rules now apply to OpenCode and DeepSeek Harness.',
      'The new DeepSeek Harness agent is in preview, and its updates go through the owner\'s button.',
      'A model\'s size is checked before a switch, with a warning when it is too small for the conversation.',
      'Messages between different members wait for the owner\'s approval.',
      'The local model server inside Claude is available, and off by default.',
      'OpenCode fixes: no duplicate replies, the right model in the picker, and no double-counted cost.',
    ],
  },
  '2.3.3.0': {
    ar: [
      'شريط الوكلاء يعرض كل وكلاء Claude، بما فيها الخلفية والمستأنفة، مع وسم «حالة تقديرية» عند الحالات المُعادة.',
      'تفاصيل الوكيل الأمامي تظهر أثناء تشغيله، والحالة تظهر بالعربية.',
      'بوصلة التوجيه لا تختفي مع بداية الدور، وصور التوجيه تظهر في فقاعتها.',
      'شارة إنفاق الشهر لواجهة Anthropic API في ترويسة المحادثة.',
      'الرسائل بين الجلسات تصل عبر نسّاج، بين جلسات المالك نفسه.',
      'OpenCode وGLM يعملان بأوضاع الصلاحيات نفسها في Claude، مع منتقي الوضع في المؤلِّف.',
      'الجدولة (/loop) تعمل: تبقى الجلسة مفتوحة حتى موعد الإيقاظ.',
      'فتح الملفات المحادثية وحفظها يعملان من تراكب الجلسة.',
      'زرّ المالك يثبّت كل الواجهات، بما فيها Claude وagy، وزرّ لإصلاح ربط فرع الإصدار.',
      'العُقد تجهّز الإصدار الجديد مسبقاً خلال نحو ربع ساعة من صدوره.',
      'ترقيع ثغرتين حرجتين في الاعتماديات.',
    ],
    en: [
      'The agents bar shows every Claude agent, including background and resumed ones, with an "estimated state" badge where the state is reconstructed.',
      'A foreground agent shows its details while it runs, and the run status reads in Arabic.',
      'The steer compass no longer disappears at the start of a turn, and steer images show in their bubble.',
      'A month-to-date Anthropic API spend badge in the chat header.',
      'Messages between your sessions are delivered through Nassaj (same owner and mode).',
      'OpenCode and GLM run with Claude\'s permission modes, with a mode picker in the composer.',
      'Scheduled wake-ups (/loop) work: the session stays open until it fires.',
      'Opening and saving chat files works from the session overlay.',
      'The owner button installs every CLI, including Claude and agy, and a button repairs the release-branch link.',
      'Nodes prepare a new release in advance within about 15 minutes of publication.',
      'Two critical dependency advisories are patched.',
    ],
  },
  '2.3.2.0': {
    ar: [
      'محادثة الفريق صارت داخل المؤلِّف: زرّ «الفريق» يرسل ما تكتبه إلى الفريق بدل النموذج.',
      'رسائل الفريق تظهر داخل المحادثة بترتيبها الزمني.',
      'المالك يثبّت واجهتي codex وopencode الناقصتين بزرّ من الإعدادات.',
      'تقدّم الوكلاء يعرض النتيجة الحقيقية: ناجح أو فاشل أو موقوف أو غير معروف.',
      'نافذة «ما الجديد» تظهر مرة واحدة لكل مستخدم.',
    ],
    en: [
      'Team chat now lives in the composer: the Team button sends what you type to the team, not the model.',
      'Team messages appear inline in the conversation, in time order.',
      'The owner can install the missing codex and opencode CLIs with a button in settings.',
      'Agent progress shows the real outcome: succeeded, failed, stopped or unknown.',
      "The \"What's new\" popup shows once per user.",
    ],
  },
  '2.3.1.11': {
    ar: [
      'شريط أدوات المؤلِّف صار أرتب وأوضح.',
      'المقبض الجانبي متاح الآن في كل الصفحات، لا في المحادثة وحدها.',
      'نافذة التحديث أبسط: رقم المرحلة ونسبة تقدّم واحدة.',
      'تلميح البحث في منتقي المزوّد صار نصاً مقروءاً.',
      'نافذة «ما الجديد» هذه تعرض أبرز التغييرات بعد كل تحديث.',
    ],
    en: [
      'A tidier, clearer composer toolbar.',
      'The side handle is now on every page, not only in chat.',
      'A cleaner update dialog: the step number and a single progress percentage.',
      'The provider picker search hint now shows readable text.',
      "This \"What's new\" popup shows the main changes after every update.",
    ],
  },
  '2.3.1.10': {
    ar: [
      'لا يُطلب مفتاح المرور بعد الدخول الموحّد.',
      'دخول مباشر بين العقد بهويتك الموحّدة.',
      'تسجيل الخروج لم يعد يعلق.',
      'قائمة الأوامر تُغلق بزرّ أو بالنقر خارجها، ولها أيقونة «/» مميّزة.',
      'شعارات الوكلاء موزّعة على عرض الشاشة كاملاً.',
      'محادثة الفريق بين الأعضاء مفعّلة، مع إدارة الأعضاء.',
      'تبديل الحسابات متاح على العقد التي لا تستخدم الدخول الموحّد.',
    ],
    en: [
      'No passkey prompt after unified sign-in.',
      'Direct sign-in across nodes with your unified identity.',
      'Signing out no longer gets stuck.',
      'The commands menu can be closed and has a distinct "/" icon.',
      'Agent logos are spread across the full width.',
      'Team chat between members is on, with member management.',
      'Account switching is available on nodes without unified sign-in.',
    ],
  },
};

/** The highlights for `version` in the UI language, or null when none were curated. */
export function getWhatsNew(version: string | null | undefined, language: string): readonly string[] | null {
  if (!version) return null;
  const entry = Object.prototype.hasOwnProperty.call(WHATS_NEW, version) ? WHATS_NEW[version] : undefined;
  if (!entry) return null;
  const items = language.toLowerCase().startsWith('ar') ? entry.ar : entry.en;
  return items.length > 0 ? items : null;
}
