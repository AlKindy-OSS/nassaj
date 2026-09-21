import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, Lock, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsGroup from '../../SettingsGroup';
import StatusBadge from '../../StatusBadge';
import { SUBSCRIPTION_TOKEN_PREFIX } from '../../../../../../shared/claudeSubscriptionToken';
import {
  useCompanyKey,
  type CompanySlotResult,
  type CompanySlotStatus,
} from '../../../../provider-auth/hooks/useCompanyKey';
import {
  type Vendor,
  type VendorCompany,
  type VendorCredentialStore,
} from '../../../../../../shared/vendors';

/**
 * CompanyCredentialCard — the credential surface for ONE company, indexed by
 * VENDOR (ADR-085).
 *
 * WHY A VENDOR AND NOT A PROVIDER. A credential belongs to the company that
 * issues it, revokes it and bills for it. The harnesses and endpoints that spend
 * it are consumers, not owners. nassaj had no name for that company — `kimi`
 * meant Moonshot, the Kimi CLI and `api.moonshot.ai` all at once — so the one
 * Moonshot key appeared as two unrelated boxes on two pages, and the operator
 * reasonably read that as a bug. It never was: it is one record with two
 * readers, and the model simply could not say so.
 *
 * THIS IS THE ONLY COMPONENT THAT WRITES A PROVIDER SECRET. The engines panel
 * inside an agent shows capability and links here; it holds no input of its own.
 * That is not tidiness — an input on a pair whose body reads a different file is
 * precisely how B-343 shipped: a key stored, reported configured, and read by
 * nothing.
 *
 * **ONE COMPONENT, ONE PLACEMENT (T-1205 → T-1206 → T-1219).** It began as a
 * standalone `VendorsSettingsTab` listing EVERY company; T-1205 folded it into
 * the agent it concerns; T-1206 kept that and added the tab back for the
 * companies no visible agent claimed. Three arrangements in three days, and each
 * one had to be defended by a rule about WHICH placement applied — a rule spread
 * over three files, whose failure mode is two writers for one record (B-343).
 *
 * T-1219 ends the argument by removing its subject: this card is rendered from
 * the Vendors tab and from nowhere else, for every company, with no condition.
 * An agent's Account page shows a status ROW instead — no input, so nothing to
 * keep in sync.
 *
 * ---
 *
 * **ONE FIELD PER COMPANY (T-1201).** Anthropic used to render THREE inputs for
 * ONE key: a company field, plus a field per slot under "per-place setup", each
 * with its own Save. The operator's objection was exact — «أبغى المستخدم يضيف
 * المفتاح مرة وحدة» — and it was not only about typing. Three boxes for one
 * secret is three chances for them to DISAGREE: paste into two of them and the
 * page can no longer say what the Anthropic key is, only what each box last
 * received. The value is one; the destinations are many. So the value gets one
 * input, and the destinations become what they always were — a choice.
 *
 * **The slot list is CHECKBOXES, not inputs.** Each row still carries its own
 * status, its own kind, its own "used by" line and its own Remove button,
 * because those describe what is STORED THERE and differ per place. Only the
 * entry of a new value is unified, because only the value is shared.
 *
 * **The defaults are a decision, not a shrug.** A slot currently held by a
 * browser login starts UNTICKED. Claude Code reads `settings.json` before its
 * OAuth record, so a key pasted onto a subscribed harness silently turns a Max
 * plan into metered API billing — the server skips such a slot by default
 * (`company-credentials.service.ts`), and a UI that pre-ticked it would be
 * inviting the user to override a guard they never knew existed. Ticking it is
 * allowed, and it costs an explicit red warning first.
 *
 * A company with ONE place shows no checkbox at all — a lone tick box that can
 * only ever be ticked is noise. The one exception is a lone place held by a
 * subscription, which is not noise but the same money-shaped decision as above.
 *
 * ‏`defaultValue` باقٍ عمداً على مفاتيح هذا الملف: المفاتيح موجودة في اللغات
 * التسع (لا نصّ عربي في `defaultValue` هنا)، لكن
 * `provider-auth/vendorKeyEntryVisibility.test.tsx` يزيّف `t` بحيث تُرجع
 * `defaultValue`، فحذفُها يُعمي اختبار انقطاعٍ حقيقي (B-367) عمّا يفحصه.
 */


/**
 * «ولصقتُ المفتاح — ثم ماذا؟» — سؤال المالك (2026-08-03) الذي لم تكن الصفحة
 * تجيبه: حقلٌ وزرُّ حفظ وسطرُ «حُفِظ الاعتماد»، ولا كلمة عن أين ذهب ومتى يسري.
 *
 * الجملة أدناه **مشتقّة من مسار الكود لا من النيّة**، وثلاث حقائق فيها مثبتة:
 *
 *  1. **أين.** `store` في سجلّ المورّدين هو نفسه ما تفرّع عليه الخدمة
 *     (`provider-credentials.service.ts:93-114`). فـ`aes` يعني ملفاً مشفَّراً
 *     (‏AES-256-GCM) لكل مستخدم على حدة، و`cli_file` يعني ملفَ الوكيل نفسه
 *     **بلا تشفير**. ولهذا لا تُقال «مشفَّر» إلا حيث يكون كذلك (B-408).
 *  2. **متى.** لا كاش للقيمة: `getProviderKey` يقرأ الملف من القرص في كل نداء،
 *     و`resolveProviderEnv` يُستدعى داخل كل إطلاق. فالسريان على **الاستدعاء
 *     التالي** بلا إعادة تشغيل — لكن عمليةً انطلقت قبل الحفظ تحمل ما قرأته وقتها.
 *  3. **لمن.** «لحسابك وحدك» تُقال لـ`aes` فقط، لأنها الوحيدة المضمونة per-user.
 *
 * ‏**مرّةً واحدة تحت الحقل الموحَّد** (T-1201): كانت تُطبع تحت كل موضع، فتصير
 * ثلاث نسخ من جواب واحد على سؤال واحد. والمواضع المحسوبة هي **المحدَّدة** لا كل
 * ما تملكه الشركة، فالجملة تصف ما سيحدث فعلاً عند الضغط لا ما قد يحدث.
 */
function DeliveryNote({ stores }: { stores: readonly VendorCredentialStore[] }) {
  const { t } = useTranslation('settings');

  // `vendor_cli` لا يمرّ من هنا أصلاً (لا حقلَ له)، فيُستبعد قبل الحكم.
  const stored = stores.filter((store) => store !== 'vendor_cli');
  if (stored.length === 0) return null;

  const kind = stored.every((store) => store === 'aes')
    ? 'aes'
    : stored.every((store) => store === 'cli_file')
      ? 'cliFile'
      : 'mixed';

  const DEFAULTS: Record<typeof kind, string> = {
    aes:
      'After saving: kept encrypted under your account only, and passed to the process as an '
      + 'environment variable on every launch — so it applies to the next message, not to a run '
      + 'already in flight.',
    cliFile:
      'After saving: written as-is into that agent\'s own settings file on disk (nassaj does not '
      + 'encrypt it), and read by the agent itself on every launch — so it applies to the next '
      + 'message, not to a run already in flight.',
    mixed:
      'After saving: delivered to each place the way that agent expects it — encrypted here, or '
      + 'written into its own settings file — and read on every launch, so it applies to the next '
      + 'message, not to a run already in flight.',
  };

  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">
      {t(`vendors.delivery.${kind}`, { defaultValue: DEFAULTS[kind] })}
    </p>
  );
}


/**
 * سطر الحالة. أيقونةٌ تحمل المعنى مع النصّ فلا يقع التمييز على اللون وحده،
 * ورابط «احصل على مفتاح» مقيَّدٌ بـ`canWrite` (‏B-362: إرسال عضوٍ ليشتري مفتاحاً
 * لن يُسمح له بتخزينه أغلى نصفَي العطل).
 */
function CredentialStatus({
  configured,
  loading,
  keyUrl,
  canWrite,
  /**
   * هل تُعرض قائمةُ المواضع تحت هذا السطر؟ (‏T-1222)
   *
   * حين تُعرض، يقول كلُّ صفٍّ فيها حالةَ موضعه بشارةٍ خاصّة به — فسطرُ الحالة هنا
   * إجمالٌ فوق تفصيلٍ يقول ما يقوله وأدقّ منه. والإجمالُ ليس خاطئاً، لكنه يجعل
   * القارئ يقرأ الحالة مرّتين ليكتشف أن الثانية أغنى، فيسقط الأوّل.
   *
   * ويبقى **رابط «احصل على مفتاح»** في الحالتين: هو فعلٌ لا حالة، ولا تقوله
   * الصفوف.
   */
  detailed,
}: {
  configured: boolean;
  loading: boolean;
  keyUrl?: string;
  canWrite: boolean;
  detailed: boolean;
}) {
  const { t } = useTranslation('settings');

  if (detailed && !(keyUrl && !configured && canWrite)) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-[13px] leading-relaxed text-muted-foreground"
      aria-live="polite"
    >
      {!detailed && (configured ? (
        <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ))}
      {!detailed && (loading
        ? t('vendors.status.checking', { defaultValue: 'Checking…' })
        : configured
          ? t('vendors.status.stored', { defaultValue: 'A key is stored' })
          : t('vendors.status.missing', { defaultValue: 'No key stored' }))}
      {keyUrl && !configured && canWrite && (
        <a
          href={keyUrl}
          target="_blank"
          rel="noreferrer"
          className="ms-1 inline-flex items-center gap-1 rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('vendors.getKey', { defaultValue: 'Get a key' })}
          {/* أيقونة «رابط خارجي» تُعكَس دلالياً في RTL. */}
          <ExternalLink className="h-3 w-3 rtl:-scale-x-100" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/**
 * الحقل وزرّ حفظه — **الحقل الوحيد في البطاقة** بعد T-1201.
 *
 * عرضُه ثابتٌ لا يعلم بالأزرار: كان `flex-1` يقتسم السطر مع «حفظ» و«حذف»، فحقلُ
 * شركةٍ لها مفتاح مخزَّن يضيق بعرض زرٍّ كامل عن حقل جارتها — عمودٌ واحد بعرضين
 * على شاشة واحدة.
 *
 * ‏**ولا حذفَ هنا**: الحذف فعلٌ على ما هو مخزَّن في موضعٍ بعينه، فمكانه صفُّ
 * الموضع حين تُعرض المواضع، وعمودُ الأفعال حين لا تُعرض. وإبقاؤه في هذا المكوّن
 * كان يقتسم عمودَ الحقل مع زرٍّ كامل فيتكسّر عرضُ الحقل عند الصفّ المخزَّن وحده.
 */
function CredentialField({
  inputId,
  ariaLabelSave,
  value,
  onChange,
  onSave,
  storedIn,
  busy,
  canSave,
}: {
  inputId: string;
  ariaLabelSave?: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** أسماءُ المواضع التي فيها مفتاحٌ الآن — فارغةٌ حين لا مفتاح في أيٍّ منها. */
  storedIn: readonly string[];
  busy: boolean;
  canSave: boolean;
}) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* ‏`border-input` لأن هذا حدّ تحكّم لا حدّ سطح؛ و`ring-ring` لأن حلقة
          التركيز مضمونة التباين على `--ring` وحدها (STYLE_LOCK §2.4).
          و`dir="ltr"` + عزل bidi لأن المفتاح قيمة تقنية داخل صفحة عربية. */}
      <input
        id={inputId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        style={{ unicodeBidi: 'isolate' }}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          storedIn.length > 0
            ? t('vendors.placeholderConfigured', { defaultValue: '•••••••• (a key is stored)' })
            : t('vendors.placeholder', { defaultValue: 'Paste API key' })
        }
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] text-foreground placeholder:font-sans placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      />
      <Button
        size="sm"
        onClick={onSave}
        disabled={busy || !canSave || value.trim().length === 0}
        aria-label={ariaLabelSave}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        <span className="ms-1.5">{t('vendors.saveShort', { defaultValue: 'Save' })}</span>
      </Button>
    </div>
  );
}

/**
 * صفُّ موضعٍ واحد: **مربّع اختيار** يقرّر أيذهب المفتاح إلى هنا، ومعه ما يصف ما
 * هو مخزَّن في هذا الموضع الآن.
 *
 * المربّع `<input type="checkbox">` أصيل داخل `<label htmlFor>` حقيقي — لا `div`
 * قابل للنقر: المساحة القابلة للنقر تشمل الاسم والشارات، والحالة تُعلَن لقارئ
 * الشاشة بلا `aria-*` مصنوع باليد.
 *
 * وزرّ الإزالة **يبقى لكل موضع**: التحديد نيّةٌ مستقبلية («اكتب هنا»)، والإزالة
 * فعلٌ على ماضٍ محفوظ («احذف ما هنا»)، فلا يجوز أن يقودهما تحكّم واحد.
 */
/**
 * هل هذا الموضع يُصادَق باشتراكٍ متصفّح؟ **مشتقٌّ من الكتالوج** لا من جواب
 * الخادم: هو ما يحدّد الافتراض (اشتراكٌ ⇒ غير محدَّد)، فلو انتظرناه لبدأ الموضع
 * محدَّداً ثم انقلب — وميضٌ في قرارٍ ماليّ لا يحتمل الوميض.
 */
function isSubscriptionSlot(vendor: Vendor): boolean {
  return vendor.credential === 'subscription_oauth' || vendor.credential === 'both';
}

/**
 * بادئةُ رمز `claude setup-token`. **مرآةٌ لثابتٍ خادميّ**:
 * `OAUTH_SETUP_TOKEN_PREFIX` في
 * `server/modules/providers/list/claude/claude-credentials.writer.ts` — وهو
 * وحده مَن يقرّر وجهةَ القيمة: ما بدأ بها يُكتب في `CLAUDE_CODE_OAUTH_TOKEN`،
 * وما عداه في `ANTHROPIC_API_KEY`. يحرس التطابقَ اختبارٌ يقرأ الملفَّين معاً
 * (`subscriptionTokenWarning.test.tsx`)، لأنّ انحرافَ النسختين هنا لا يُنتج
 * عطلاً مرئياً بل **ادّعاءً مالياً كاذباً** على الشاشة.
 */

/**
 * هل القيمة المكتوبة في الحقل **رمزُ اشتراك** لا مفتاح API؟
 *
 * الفرق مالي لا تصنيفي، وعليه يقوم تحذيرُ هذه البطاقة: مفتاح API على وكيلٍ
 * داخلٍ باشتراكه يُحوّل إنفاقه إلى فوترةٍ بالعدّاد، أمّا رمزُ `setup-token`
 * فهو **الاشتراكُ نفسُه** مكتوباً بصيغةٍ يقرؤها الوكيل — لا فوترةَ API فيه ولا
 * خطّةَ تُلغى. فإطلاقُ التحذير على الاثنين يقول للقارئ إنّه يوشك أن يدفع، وهو
 * لا يوشك؛ والتحذير الذي يكذب مرّةً لا يُصدَّق حين يصدق.
 *
 * والقيمةُ الفارغة **ليست** رمزَ اشتراك عمداً: التحذير الأحمر يجب أن يُقرأ
 * قبل اللصق لا بعده، وربطُه باللصق هو ما أسقط حارساً مالياً في
 * `companyKeySelection.test.tsx` من قبل. فالشرط هنا يضيّق على قيمةٍ **قيست**،
 * ولا يلمس حالةَ الحقل الفارغ.
 */
function isSubscriptionToken(value: string): boolean {
  return value.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX);
}

function SlotChoiceRow({
  vendor,
  status,
  checked,
  onToggle,
  onRemove,
  busy,
}: {
  vendor: Vendor;
  /** غائبة حتى يردّ الخادم: عندها لا تُدّعى حالةُ تخزينٍ لم تُقرأ بعد. */
  status?: CompanySlotStatus;
  checked: boolean;
  onToggle: (next: boolean) => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation('settings');

  const checkboxId = `vendor-slot-${vendor.id}`;
  const configured = status?.configured;

  /**
   * **شارتان لا ثلاث** (شكوى المالك 2026-08-03): صفُّ الموضع الواحد كان يحمل
   * «مفتاح API» + «يُكتب داخل OpenCode» + «لا مفتاح» في سطر واحد.
   *
   * والزائدة منها هي الأولى: رأس البطاقة فوقها يحمل شارة «مفتاح API» أصلاً
   * (شارة «مفتاح API»)، فتكرارُها على كل صفٍّ يقول ما قيل. أمّا موضعٌ يُصادَق
   * **باشتراك** فشارتُه تقول شيئاً آخر لا يقوله الرأس — أن هذا الموضع ليس مفتاحاً
   * اليوم — فتبقى، فالعدّ واحدةٌ أو اثنتان لا ثلاث.
   *
   * وT-1219 أسقط الثالثة نهائياً مع سببها: شارةُ «يُكتب داخل OpenCode» كانت
   * تلزم لأن البطاقة تُصيَّر **في زيارة** داخل صفحة وكيلٍ بعينه، فيلزم تمييز
   * الموضع الغريب عن الأصيل. والبطاقة اليوم في منزلها دائماً — كلُّ موضعٍ فيها
   * يُسمّى باسمه المطلق من `vendor.context` («داخل OpenCode»)، وهو نفس المعلومة
   * في اللصيقة بدل شارةٍ فوقها.
   */
  const kindLabel = vendor.credential === 'api_key'
    ? null
    : t('vendors.kind.subscription', { defaultValue: 'Subscription (browser login)' });

  const slotName = vendor.context
    ? t(vendor.context.labelKey, { defaultValue: vendor.context.labelDefault })
    : vendor.name;

  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-1.5">
      {/* ‏`accent-primary` يلوّن المربّع من الرمز لا من لون خام، و`mt-1` يحاذيه
          مع أول سطر من اللصيقة لا مع وسط الكتلة. */}
      <input
        id={checkboxId}
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={(event) => onToggle(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 rounded-sm border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <label
          htmlFor={checkboxId}
          className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium leading-relaxed text-foreground"
        >
          <span>{slotName}</span>
          {kindLabel && <StatusBadge>{kindLabel}</StatusBadge>}
          {/* نصٌّ مختلف لا لونٌ مختلف: «مخزَّن» و«لا مفتاح» يُقرآن بلا لون
              (‏WCAG 1.4.1)، والنبرة زيادةٌ لا حاملٌ للمعنى. */}
          {status === undefined ? (
            /* مصطلحٌ واحد لحالةٍ واحدة (‏T-1222): كانت هذه «جارٍ التحقّق…»
               وسطرُ الشركة فوقها «جارٍ الفحص…» — كلمتان لشيءٍ واحد في بطاقةٍ
               واحدة تجعلان القارئ يبحث عن الفرق بينهما. */
            <StatusBadge>{t('vendors.status.checking', { defaultValue: 'Checking…' })}</StatusBadge>
          ) : configured ? (
            <StatusBadge tone="success">
              {t('vendors.slots.stored', { defaultValue: 'Key stored' })}
            </StatusBadge>
          ) : (
            <StatusBadge>{t('vendors.slots.missing', { defaultValue: 'No key' })}</StatusBadge>
          )}
        </label>

      </div>

      {configured && (
        <Button
          size="sm"
          variant="outline"
          onClick={onRemove}
          disabled={busy}
          aria-label={t('vendors.removeFrom', {
            slot: slotName,
            defaultValue: 'Remove the stored key from {{slot}}',
          })}
          className="text-danger hover:text-danger"
        >
          <Trash2 className="h-4 w-4" />
          <span className="ms-1.5">{t('vendors.removeShort', { defaultValue: 'Remove' })}</span>
        </Button>
      )}
    </div>
  );
}

/**
 * ONE key for the whole company, delivered by nassaj to every place the operator
 * TICKED (T-1159 for the fan-out, T-1201 for the choice).
 *
 * It REPORTS PER SLOT instead of saying "Saved", because the fan-out can
 * legitimately half-apply: a harness signed in by subscription is skipped (a key
 * written there flips a Max plan to metered API billing — see the server
 * service), and a slot shared across the team is refused for a member. Both are
 * correct outcomes, and both would be a lie under a single success line.
 */
export type CompanyKeyState = { configured: boolean; loading: boolean };

export default function CompanyCredentialCard({
  company,
  onKeyState,
}: {
  company: VendorCompany;
  /**
   * يُبلِّغ الغلافَ بحالة مفتاح هذه الشركة (مخزَّن؟ ما زال يُفحص؟) — وُجد ليقرّر
   * غلافُ تبويب الحساب أيَطوي «طريقَ المفتاح» أم يفتحه، بلا نداءٍ ثانٍ لنفس
   * النقطة: `useCompanyKey` يجلب عند التركيب، وعنصر `<details>` يُركِّب أبناءه
   * وإن كان مطويّاً، فاستدعاء الخطّاف مرّتين كان سيُنتج طلبين لجوابٍ واحد.
   */
  onKeyState?: (state: CompanyKeyState) => void;
}) {
  const { t } = useTranslation('settings');
  const { slots, configured, loading, saving, error, writable, saveKey, deleteKey } =
    useCompanyKey(company.id);

  useEffect(() => {
    onKeyState?.({ configured, loading });
  }, [onKeyState, configured, loading]);
  const [draftKey, setDraftKey] = useState('');
  const [results, setResults] = useState<CompanySlotResult[] | null>(null);
  /**
   * نوعُ القيمة التي أنتجت `results` — يُلتقط لحظةَ الحفظ لأنّ الحقل يُفرَّغ
   * بعده، فقراءةُ `draftKey` عند عرض النتيجة تقرأ فراغاً لا القيمةَ المحفوظة.
   * لا يحمل القيمة نفسها: سرٌّ لا يُحتفظ به لأجل جملةٍ في الشاشة.
   */
  const [savedSubscriptionToken, setSavedSubscriptionToken] = useState(false);
  /**
   * تجاوزات المستخدم فقط — لا الحالة الكاملة. الموضع الغائب عن هذا السجلّ يأخذ
   * **افتراضه المشتقّ** (`!subscription`) لا قيمةً منسوخة.
   *
   * الفرق ليس أسلوبياً: نسخُ الافتراض إلى الحالة داخل `useEffect` يعني إطاراً
   * واحداً على الأقل يكون فيه موضعُ الاشتراك محدَّداً قبل أن يصحّحه الأثر —
   * فيومض التحذيرُ الأحمر ثم يختفي. والأسوأ أن `refresh` بعد الحفظ كان قد يعيد
   * الحساب فيلغي اختيار المستخدم أمام عينيه. الاشتقاق لا يفعل أيّاً منهما.
   */
  const [selection, setSelection] = useState<Record<string, boolean>>({});

  /**
   * هل قائمةُ المواضع مفتوحة؟ (‏T-1223)
   *
   * مطويّةٌ افتراضاً: المواضع قرارٌ يُتّخذ **مرّةً** حين يُلصق أوّلُ مفتاح، ثم لا
   * يُعاد النظر فيه في كل زيارة — بينما الحقلُ وزرُّ الحفظ هما الفعلُ المتكرّر.
   * وعرضُها دائماً كان يجعل كلَّ شركةٍ كتلةً من أربعة أسطر لفعلٍ يسع سطراً.
   */
  const [placesOpen, setPlacesOpen] = useState(false);

  const inputId = `company-api-key-${company.id}`;

  const statusById = useMemo(() => {
    const map = new Map<string, CompanySlotStatus>();
    for (const slot of slots) map.set(slot.vendorId, slot);
    return map;
  }, [slots]);

  /**
   * القيمةُ في الحقل الآن رمزُ اشتراك (‏`sk-ant-oat01-…`) لا مفتاح API.
   * تُقاس من الحقل لا من الشركة: الشركةُ لا تقول ما لُصق فيها. وتُحسب **قبل**
   * `isChosen` لأنّ الافتراض أدناه يقرؤها.
   */
  const draftIsSubscriptionToken = isSubscriptionToken(draftKey);

  /**
   * **الافتراضُ يُمنع حيث تكون الكتابة قراراً، لا حيث تكون مريحة.**
   *
   * القاعدة الأولى (قائمة): موضعُ الاشتراك يبدأ **غير محدَّد** — المفتاح عليه
   * يحوّل الخطة إلى فوترة API، فالتحديد قرارٌ يُتّخذ لا افتراضٌ يُورَث.
   *
   * القاعدة الثانية (‏هذا الإصلاح): حين تكون القيمة **رمزَ اشتراك**، يبدأ
   * الموضعُ الذي لا يقبل إلا مفتاح API غيرَ محدَّد أيضاً. والسبب ليس المال بل
   * **سياسةٌ منصوصة**: الكتالوج يقول عن `anthropic-opencode` حرفياً إنّ تمرير
   * اشتراك Claude الشخصي عبر OpenCode «forbidden outright»، وإنّ هذا الموضع لا
   * يحمل إلا مفتاحاً (‏`shared/vendors.ts` — `credential: 'api_key'`). وكاتبُ
   * OpenCode لا يفحص البادئة، فيبتلع الرمز بصيغة `{type:'api'}` كأنه مفتاح.
   *
   * وبلا هذه القاعدة كان التحذيرُ الأزرق الجديد يصير أسوأ من الأحمر الذي
   * استبدله: يسمّي موضعَ الاشتراك وحده ويقول «لا تنتقل الفوترة» — طمأنةٌ صادقةٌ
   * في موضعها، تُقرأ فوق كتابةٍ محظورةٍ في موضعٍ آخر **محدَّدٍ افتراضاً** لم
   * يسمّه أحد. الطمأنة التي تغطّي فعلاً لم يُذكر عيبٌ في الشاشة لا في النصّ.
   *
   * والمنعُ افتراضٌ لا حَجْر: للقارئ أن يحدّده بنفسه، وعندها يقرأ تحذيراً
   * أحمر يسمّي الموضع — نفس بنية قرار موضع الاشتراك تماماً.
   */
  const isChosen = (vendor: Vendor): boolean => {
    const stated = selection[vendor.id];
    if (stated !== undefined) return stated;
    if (isSubscriptionSlot(vendor)) return false;
    return !draftIsSubscriptionToken;
  };

  /**
   * هل تحتاج هذه الشركة قائمة اختيار أصلاً؟
   *
   * موضعٌ واحد غير مصادَقٍ باشتراك = **لا قائمة**: مربّعُ اختيارٍ لا يملك إلا أن
   * يكون محدَّداً ضجيجٌ خالص. والاستثناء الوحيد موضعٌ وحيدٌ داخلٌ باشتراكه —
   * وذاك ليس ضجيجاً بل نفس القرار المالي: بلا مربّع لن يجد المالك طريقاً إلى
   * تحويل ذلك الموضع إلى مفتاح، ولا الخادم سيكتبه له بلا طلب صريح.
   */
  /**
   * المواضع تُرسم من **الكتالوج المحلي** فوراً، لا من جواب الخادم.
   *
   * كانت مشروطة بـ`statusById.has(...)`، فبقيت الشاشة بلا مربّعات حتى يردّ
   * الخادم — وهو يفحص كل مواضع الشركة فيبطئ. والنتيجة على اللقطة الحيّة: بطاقةٌ
   * فيها حقلٌ وحده، تبدو كأن الميزة غير موجودة. والمواضع ليست معلومةً خادمية
   * أصلاً: الخادم يشتقّها من هذا الكتالوج نفسه، ولا يضيف إلا **الحالة**
   * (مخزَّن/لا) وصلاحية الكتابة.
   *
   * وجواب الخادم يبقى مُضيِّقاً لا مُنشئاً: متى أجاب بقائمة، يسقط ما ليس فيها —
   * فلا يُعرض صفٌّ لموضعٍ لا يستطيع الخادم الكتابة فيه.
   */
  const shownVendors = slots.length > 0
    ? company.vendors.filter((vendor) => statusById.has(vendor.id))
    : company.vendors;

  const needsChoice = shownVendors.length > 1 || shownVendors.some(isSubscriptionSlot);

  const chosenVendors = shownVendors.filter(isChosen);
  const chosenIds = chosenVendors.map((vendor) => vendor.id);

  // موضعٌ محدَّد وهو داخلٌ باشتراكه: هنا وحده يُطلب التجاوز، وهنا وحده يُعرض
  // التحذير الأحمر — فالتحذير يتبع الفعل المُوشك لا احتمالَه.
  const subscriptionSlots = shownVendors.filter(isSubscriptionSlot);
  const overriddenSubscriptions = subscriptionSlots.filter(isChosen);
  const keptSubscriptions = subscriptionSlots.filter((vendor) => !isChosen(vendor));

  /**
   * رمزُ اشتراكٍ مُوجَّهٌ إلى موضعٍ لا يقبل إلا مفتاح API — **بتحديدٍ صريحٍ من
   * القارئ**، لأنّ الافتراض أعلاه يُبقيه غير محدَّد. يُسمّى بالاسم: التحذير
   * الذي لا يسمّي موضعه يطلب من القارئ أن يخمّن أيَّ مربّعٍ يعنيه.
   */
  const tokenIntoKeyOnlySlots = draftIsSubscriptionToken
    ? shownVendors.filter((vendor) => !isSubscriptionSlot(vendor) && isChosen(vendor))
    : [];

  const slotLabel = (vendorId: string): string => {
    const vendor = company.vendors.find((candidate) => candidate.id === vendorId);
    if (!vendor) return vendorId;
    return vendor.context
      ? t(vendor.context.labelKey, { defaultValue: vendor.context.labelDefault })
      : vendor.name;
  };

  /**
   * المواضع التي فيها مفتاحٌ الآن، بأسمائها (‏T-1232).
   *
   * تُقرأ من جواب الخادم لكل موضعٍ على حدة — لا من `configured` المجمَّعة التي
   * تقول «في مكانٍ ما». وهي تبقى فارغةً حتى يردّ الخادم، فلا تُدّعى حالةٌ لم
   * تُقرأ بعد.
   */
  const storedIn = slots.filter((slot) => slot.configured).map((slot) => slotLabel(slot.vendorId));

  const outcomeText = (slot: CompanySlotResult): string => {
    switch (slot.outcome) {
      case 'written':
        return t('vendors.company.outcome.written', { defaultValue: 'saved' });
      case 'skipped_subscription':
        /**
         * **العلّةُ تُذكر فقط حين تكون علّة.** الخادم يتخطّى موضعَ الاشتراك بلا
         * نظرٍ في نوع القيمة (‏`company-credentials.service.ts` — الشرط
         * `includeSubscription` وحده)، فالنتيجة واحدةٌ للقيمتين بينما سببُها
         * ليس واحداً: مفتاحُ API هناك يُحوّل الإنفاق إلى فوترةٍ بالعدّاد، أمّا
         * رمزُ الاشتراك فلا يُحوّل شيئاً — هو الاشتراك نفسه. فتُقال الحقيقة
         * المشتركة (تُرك على اشتراكه) وتُحذف النتيجة المالية التي لا تقع.
         */
        return savedSubscriptionToken
          ? t('vendors.company.outcome.subscriptionToken', {
            defaultValue: 'left on its subscription — it is already signed in',
          })
          : t('vendors.company.outcome.subscription', {
            defaultValue: 'left on its subscription — a key here would switch it to paid API billing',
          });
      case 'forbidden':
        return t('vendors.company.outcome.forbidden', {
          defaultValue: 'shared across the team — an owner or admin must set this one',
        });
      default:
        return slot.error ?? t('vendors.company.outcome.failed', { defaultValue: 'could not be saved' });
    }
  };

  const handleSave = async () => {
    setResults(null);
    const result = await saveKey(draftKey, {
      /**
       * ‏**صريحٌ دائماً** — إصلاحُ عطلٍ نشط لا تجميل (T-1206).
       *
       * كان `needsChoice && slots.length > 0 ? chosenIds : undefined`، والخادم
       * يقرأ `undefined` بمعنى «كل مواضع الشركة»
       * (‏`company-credentials.service.ts` → `selectVendors`). فأيّ بطاقةٍ يسقط
       * عنها شرطُ القائمة — موضعٌ واحد معروض، أو خادمٌ لم يُجب بقائمة — كانت
       * تطلب الكتابة في **كل** المواضع بينما الشاشة تعرض واحداً. الكتابة في
       * ملفّ OpenCode بلا أن يظهر ذلك لأحد أسوأ من عرضِ المربّع ومن إخفائه معاً.
       *
       * ودلالةُ الغياب تبقى كما هي على الخادم: هذا العميل لم يعد يستعملها، لكن
       * عميلاً أقدم قد يفعل، فالتوافق الخلفي لا يُكسر من هذا الطرف.
       */
      vendorIds: chosenIds,
      includeSubscription: overriddenSubscriptions.length > 0,
    });
    if (result.success) {
      setSavedSubscriptionToken(draftIsSubscriptionToken);
      setDraftKey('');
      setResults(result.slots);
    }
  };

  const handleRemove = async (vendorId?: string) => {
    setResults(null);
    const result = await deleteKey(vendorId ? [vendorId] : undefined);
    if (result.success) {
      setResults(null);
    }
  };

  // B-362/B-367: a refusal is STATED, never rendered as a box that 403s on
  // submit. And the test is `=== false`, NOT `!writable`: a server that predates
  // these routes sends no `writable` at all, and reading that silence as a
  // refusal would hide the field from everyone, the owner included.
  if (writable === false) {
    // نبرة `info` لا `danger`: الخريطة تحجز `danger` للمنع الذي يُحدثه القارئ،
    // وهذا **إخبارٌ عمّن يملك الفعل** — «اطلب من المالك» جملةُ إرشاد لا إنذار.
    return (
      <SettingsCard tone="info">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('vendors.company.notWritable', {
            company: company.name,
            defaultValue:
              '{{company}} credentials are shared across the team, so only an owner or admin '
              + 'can set them here. Ask them to add the key — once stored, you can use it.',
          })}
        </p>
      </SettingsCard>
    );
  }

  return (
    /*
      **سطرٌ واحد لكل شركة، لا بطاقة** (‏T-1223، شكوى المالك 2026-08-04: «ما أنا
      فاهم هذي صفحة تعليمية ولا تنفيذية»).

      وهي شكوى عن **الشكل يقول غير الوظيفة**. الشاشة وظيفتُها فعلٌ واحد متكرّر:
      لصقُ مفتاحٍ وحفظُه، ستّ مرّات. والشكل الذي كان يحملها — بطاقةٌ مؤطَّرة لكلٍّ،
      فيها عنوانٌ وسطرُ حالة وحقلٌ ومجموعةُ مربّعاتٍ وصناديقُ نبرة — شكلُ **مقالٍ
      تشرحه**، لا شكلُ جدولٍ تعمل فيه. فالقارئ يقرأ ولا يعمل، ثم يسأل: أهذه صفحةُ
      تعليمٍ أم تنفيذ؟

      فصار السطر: **الاسم · الحقل · حفظ**، وكلُّ ما عداه خلف طيٍّ لا يُفتح إلا
      حين يُطلب. والتفاصيل لم تُحذف — مواضعُ الكتابة وحالةُ كلٍّ منها وزرُّ حذفها
      كما هي — لكنها لم تعد تعترض طريق الفعل الذي جاء المالك ليفعله.
    */
    /* ‏`data-company` مِقبضٌ للاختبارات: كانت تنتقي الصفَّ بصنف تنسيقٍ
       (`div.rounded-lg`)، فكسرها أوّلُ تغييرٍ في الشكل — وهو ما لا يجوز أن يكسر
       اختبارَ سلوك. المِقبض يبقى ما بقيت الشركة صفّاً. */
    <div data-company={company.id} className="space-y-2 py-2.5">
      {/*
        **شبكةٌ بأعمدةٍ ثابتة لا صفٌّ مرن** (مقيس على لقطة `t1223-shots`).

        أوّل صياغةٍ كانت `flex`، فعرضُ الحقل يتبع ما بعده: شركةٌ لها زرُّ مواضعَ
        ورابطُ «احصل على مفتاح» تترك للحقل أقلَّ ممّا تتركه شركةٌ بلا زرّ. فخرجت
        ستّةُ حقولٍ بستّة عروض — والعينُ تقرأ ذلك ستَّ بطاقاتٍ متفاوتة لا جدولاً،
        وهو عينُ ما جيء بالجدول لإصلاحه.

        الأعمدة الثلاثة: اسمٌ ثابت، حقلٌ يأخذ الباقي، وعمودُ روابطَ ثابتُ العرض
        يحجز مكانه حتى حين يخلو — فالحقول تبدأ وتنتهي عند نفس النقطة في كل صفّ.
      */}
      <div className="grid grid-cols-1 items-center gap-x-3 gap-y-2 sm:grid-cols-[7rem_1fr_11rem]">
        <label
          htmlFor={inputId}
          dir="ltr"
          className="truncate text-start text-[15px] font-medium text-foreground"
        >
          {company.name}
        </label>

        <div className="min-w-0">
          <CredentialField
            inputId={inputId}
            ariaLabelSave={t('vendors.save', { vendor: company.name, defaultValue: 'Save {{vendor}} key' })}
            value={draftKey}
            onChange={setDraftKey}
            onSave={handleSave}
            storedIn={storedIn}
            busy={saving || loading}
            // لا حفظ بلا موضعٍ مسمّى: القائمة تُرسل صريحةً دائماً، ومصفوفةٌ فارغة
            // ‏400 عند الخادم لا «كل المواضع».
            canSave={chosenIds.length > 0}
          />
        </div>

        {/* عمودُ الروابط: «احصل على مفتاح» فعلٌ لا حالة ولا يقوله شيءٌ آخر، وزرُّ
            المواضع يفتح ما طُوي. وكلاهما ثانويٌّ بصرياً — الفعلُ الرئيسي هو
            الحقل — فيُحاذَيان إلى نهاية السطر بمقاسٍ أصغر. */}
        <div className="flex items-center justify-end gap-x-3">
          {/* **الحذف في عمود الأفعال لا في عمود الحقل** (مقيس على اللقطة): كان
              داخل `CredentialField`، فصفُّ شركةٍ لها مفتاحٌ مخزَّن يقتسم عمودَه مع
              زرٍّ كامل — فيضيق حقلُه عن حقول جيرانه، ويتكسّر الجدول عند الصفّ
              الوحيد الذي أنجز فيه المالك شيئاً. وهو فعلٌ ثانويٌّ بطبعه كالروابط
              بجانبه: لا يُفعل إلا بعد أن يكون هناك ما يُحذف. */}
          {configured && !needsChoice && shownVendors.length === 1 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleRemove(shownVendors[0].id)}
              disabled={saving || loading}
              aria-label={t('vendors.remove', { vendor: company.name, defaultValue: 'Remove {{vendor}} key' })}
              className="shrink-0 text-danger hover:text-danger"
            >
              <Trash2 className="h-4 w-4" />
              <span className="ms-1.5">{t('vendors.removeShort', { defaultValue: 'Remove' })}</span>
            </Button>
          )}

          <CredentialStatus
            configured={configured}
            loading={loading}
            keyUrl={company.vendors.find((vendor) => vendor.keyUrl)?.keyUrl}
            canWrite
            detailed
          />

          {/* زرُّ الطيّ: يظهر فقط حين يكون خلفه شيء (شركةٌ بموضعٍ واحد بلا اشتراك
              لا مواضعَ تُختار لها، فزرٌّ يفتح على مربّعٍ وحيدٍ محدَّدٍ أبداً ضجيج).

              **وبلا عدّاد.** كان يطبع عددَ المواضع المحدَّدة، فيقرأ المالك «يُكتب
              في · 0» على شركةٍ موضعُها الوحيد اشتراكٌ — رقمٌ صحيحٌ حسابياً ولغزٌ
              على الشاشة: صفرٌ لا يقول أين المشكلة ولا ما العمل. وحين يهمّ الصفرُ
              فعلاً — عند اللصق — تقولها جملةٌ صريحة تحته («حدِّد موضعاً واحداً على
              الأقل»)، وهي جوابٌ لا لغز. */}
          {needsChoice && (
            <button
              type="button"
              onClick={() => setPlacesOpen((open) => !open)}
              aria-expanded={placesOpen}
              aria-controls={`${inputId}-places`}
              className="shrink-0 rounded-sm text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('vendors.slots.legendShort', { defaultValue: 'Written to' })}
            </button>
          )}
        </div>
      </div>

        {draftKey.trim().length > 0 && (
          <DeliveryNote
            stores={(chosenVendors.length > 0 ? chosenVendors : company.vendors).map(
              (vendor) => vendor.store,
            )}
          />
        )}

        {needsChoice && placesOpen && (
          // ‏`fieldset` لأن هذه **مجموعة اختيارات واحدة** لا صفوفٌ متجاورة: قارئ
          // الشاشة يعلن المجموعة مرّةً ثم يعدّ خياراتها، بدل أن يقرأ كل مربّع بلا
          // سياق. و`legend` سقطت لأن الزرَّ الذي فتح المجموعة يحمل اسمها.
          <fieldset id={`${inputId}-places`} className="space-y-1 ps-1 pt-1">
            {/*
              ‏**تسميةُ مجموعةٍ لا تعليماتُ استعمال** (‏T-1222). كانت «أين يذهب هذا
              المفتاح؟ أزِل التحديد عن موضع لتتركه كما هو» — سطرٌ يشرح كيف يعمل
              مربّع الاختيار، مكرّراً تحت كل شركة. ومربّعُ الاختيار لا يحتاج شرحاً،
              والعنوان يبقى لأن قارئ الشاشة يعلن به المجموعة قبل أن يعدّ خياراتها.
            */}
            <SettingsGroup>
              {/* المصدر هو ما **أجاب به الخادم**، مرتَّباً بترتيب السجلّ: صفٌّ
                  لموضعٍ لا يعرفه الخادم لا يستطيع أن يعرض حالةً ولا أن يُحفَظ
                  فيه شيء، فوجوده وعدٌ لا يُوفى. */}
              {shownVendors
                .map((vendor) => {
                  const status = statusById.get(vendor.id);
                  return (
                    <SlotChoiceRow
                      key={vendor.id}
                      vendor={vendor}
                      status={status}
                      checked={isChosen(vendor)}
                      onToggle={(next) =>
                        setSelection((previous) => ({ ...previous, [vendor.id]: next }))
                      }
                      onRemove={() => handleRemove(vendor.id)}
                      busy={saving || loading}
                    />
                  );
                })}
            </SettingsGroup>
          </fieldset>
        )}

        {/*
          **تحذيرٌ عن فعلٍ يوشك أن يقع، لا لافتةٌ دائمة** (‏T-1222، شكوى المالك:
          «التكرار والحشو في صفحة المزوّدين مزعج وبشع جداً»).

          الصندوقان أدناه كانا يُرسمان دائماً، فصندوقٌ أصفر كامل تحت كل شركةٍ لها
          موضعُ اشتراك — وهو حال Anthropic وOpenAI معاً — يشغل من البطاقة مساحةً
          أكبر من محتواها كلِّه. وكلاهما يتكلّم عن **الحفظ**: «سيبقى اشتراكه»،
          «الحفظ يكتب مفتاحاً هناك». وحفظٌ بلا مفتاحٍ في الحقل لا يقع أصلاً — الزرّ
          نفسُه معطَّل — فالتحذير قبل اللصق ينذر من فعلٍ لا يستطيع القارئ فعله.

          فصارا مشروطين بوجود مفتاحٍ في الحقل: يظهران في اللحظة الوحيدة التي
          يستطيعان فيها تغيير القرار، وهي اللحظة التي يُقرآن فيها.

          والأحمر يبقى أحمر: الأثر مالي ولا رجعة فيه بضغطة واحدة.
        */}
        {/*
          ‏**و«المواضع الأخرى» يجب أن تكون موجودة.** الجملة تَعِد بأن المفتاح
          «يذهب إلى المواضع الأخرى فقط»، وهي كاذبة حين لا يكون أيُّ موضعٍ
          محدَّداً — وتلك حالةٌ صارت ممكنةً بعدما صار رمزُ الاشتراك يُلغي
          التحديد الافتراضي عن المواضع المفتاحية. والسطر الذي يلي («حدِّد موضعاً
          واحداً على الأقل») يقول الحقيقة كاملةً وحده.
        */}
        {draftKey.trim().length > 0 && keptSubscriptions.length > 0 && chosenIds.length > 0 && (
          <SettingsCard tone="warning">
            <p className="text-[13px] leading-relaxed text-warning">
              {t('vendors.company.subscriptionNotice', {
                slots: keptSubscriptions.map((vendor) => slotLabel(vendor.id)).join(' · '),
                defaultValue:
                  '{{slots}} is signed in by subscription and will keep it — the key goes to the other places only.',
              })}
            </p>
          </SettingsCard>
        )}

        {/*
          **والأحمر يبقى بلا شرط.** ربطتُه أوّلاً باللصق كأخيه، فأسقط حارساً في
          `companyKeySelection.test.tsx` يفحص وعداً مالياً: «التحذير يُقرأ قبل أن
          يُسلَّم المفتاح». والفرق بين الصندوقين ليس اللون بل مَن يُنشئهما:

           • الأصفر حالةٌ **افتراضية** — موضعُ الاشتراك يبدأ بلا تحديد دائماً، فكان
             يُرسم تحت كل شركةٍ لها اشتراك في كل زيارة، بلا أن يفعل القارئ شيئاً.
           • الأحمر لا يظهر إلّا إن **حدّد القارئ بنفسه** مربّعاً يعرف ما فيه. فهو
             نادرٌ بطبعه، وهو الردّ المباشر على فعلٍ للتوّ وقع.

          فالأول حشوٌ يُخفي الإشارة، والثاني هو الإشارة. وتليينُ حارسٍ ماليّ لأجل
          الشكل ثمنٌ لا يُدفع.
        */}
        {/*
          **والنوعُ يُقاس، لأنّ الجملة تدّعي مالاً.** التحذير أعلاه يقول إنّ
          الحفظ «ينقل الفوترة إلى استهلاك API بالعدّاد»، وهو صادقٌ في مفتاح API
          وكاذبٌ في رمز `claude setup-token`: ذاك الرمز هو الاشتراك نفسُه
          مكتوباً بصيغةٍ يقرؤها الوكيل — يُكتب في `CLAUDE_CODE_OAUTH_TOKEN` لا
          في `ANTHROPIC_API_KEY` (‏`claude-credentials.writer.ts`)، فلا خطّةَ
          تتوقّف ولا عدّادَ يبدأ.

          والشرطُ على **قيمةٍ مقيسة** لا على اللصق: الحقل الفارغ ليس رمز
          اشتراك، فالأحمر يبقى مرسوماً قبل أن يُلصق شيء — وهو ما يحرسه
          `companyKeySelection.test.tsx` أعلاه. ما تغيّر أنّ القارئ الذي لصق
          رمزَ اشتراكه يقرأ الآن ما يقع فعلاً بدل إنذارٍ لا يخصّه.
        */}
        {/*
          **والطمأنةُ لا تُقال فوق موضعٍ محظور.** الأزرق يسمّي موضعَ الاشتراك
          وحده؛ فإن حدّد القارئ معه موضعاً لا يقبل إلا مفتاحاً، لم يعد الأزرق
          يصف الحفظَ كلَّه. فيسبقه أحمرٌ يسمّي ذلك الموضع بالاسم.
        */}
        {tokenIntoKeyOnlySlots.length > 0 && (
          <SettingsCard tone="danger">
            <p className="text-[13px] leading-relaxed text-danger">
              {t('vendors.company.subscriptionTokenIntoKeySlot', {
                slots: tokenIntoKeyOnlySlots.map((vendor) => slotLabel(vendor.id)).join(' · '),
                defaultValue:
                  'You ticked {{slots}}, which only ever holds an API key. Saving writes the '
                  + 'subscription token there as if it were a key — routing a personal subscription '
                  + 'through that place is not allowed. Untick it.',
              })}
            </p>
          </SettingsCard>
        )}

        {overriddenSubscriptions.length > 0 && (
          draftIsSubscriptionToken ? (
            <SettingsCard tone="info">
              <p className="text-[13px] leading-relaxed text-foreground">
                {t('vendors.company.subscriptionTokenOverride', {
                  slots: overriddenSubscriptions.map((vendor) => slotLabel(vendor.id)).join(' · '),
                  defaultValue:
                    'The value in the field is a subscription token, not an API key. Saving it to '
                    + '{{slots}} stores the subscription itself — it does not move billing to metered '
                    + 'API usage.',
                })}
              </p>
            </SettingsCard>
          ) : (
            <SettingsCard tone="danger">
              <p className="text-[13px] leading-relaxed text-danger">
                {t('vendors.company.subscriptionOverride', {
                  slots: overriddenSubscriptions.map((vendor) => slotLabel(vendor.id)).join(' · '),
                  defaultValue:
                    'You ticked {{slots}}, which is signed in by subscription right now. Saving writes '
                    + 'an API key there, and that agent reads the key before the subscription — so the '
                    + 'plan stops being used and billing moves to metered API usage. Untick it to keep '
                    + 'the subscription.',
                })}
              </p>
            </SettingsCard>
          )
        )}

        {draftKey.trim().length > 0 && needsChoice && chosenIds.length === 0 && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('vendors.slots.none', {
              defaultValue: 'Tick at least one place for the key to be saved into.',
            })}
          </p>
        )}

      {/*
        **«مخزَّن» تُسمّي موضعها — حين يكون للشركة أكثر من موضع** (‏T-1232، شكوى
        المالك 2026-08-04: «هل أنت متأكد أن هذا المفتاح المحفوظ حالياً؟»، ومعها
        تناقضُ Z.AI بين هذه الشاشة ولوح المحرّكات).

        الحالة كانت تقول «مخزَّن» متى كان **أيُّ** موضعٍ مخزَّناً، بلا أن تسمّي
        أيَّها. ولـZ.AI موضعان في مكانين مختلفين تماماً: مفتاحٌ في `auth.json`
        يقرؤه OpenCode — **ملفُّ المشغّل، مشترك بين الجميع** — ومفتاحٌ في المتجر
        المشفَّر **لكل مستخدم على حدة** يقرؤه محرّك GLM تحت Claude. فعضوٌ لا يملك
        الثاني يقرأ هنا «مخزَّن»، ثم يقرأ في لوح المحرّكات «ينقصه اعتماد Z.AI» —
        والجملتان صادقتان، والشاشةُ وحدها كاذبة لأنها أخفَت الفرق.

        وموضعُه **تحت الصفّ لا داخل الحقل**: أوّل صياغةٍ وضعته في `placeholder`،
        فبُتر عند حدّ الحقل («‏stored in: DeepSee…») — والاسمُ المبتور أسوأ من
        غيابه. ولا يُقال لشركةٍ بموضعٍ واحد: لا لبسَ يُرفع هناك، والسطر يصير حشواً.
      */}
      {storedIn.length > 0 && shownVendors.length > 1 && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('vendors.storedInLine', {
            places: storedIn.join(t('vendors.listSeparator', { defaultValue: ' · ' })),
            defaultValue: 'Stored in: {{places}}',
          })}
        </p>
      )}

      {/*
        منطقةُ النتيجة **بلا ارتفاعٍ محجوز** (‏T-1223): كانت `min-h-5` تحجز سطراً
        فارغاً تحت كل شركة — ستّةَ أسطر بيضاء في شاشةٍ واحدة — لتمنع قفزَ التخطيط
        عند الحفظ. والقفزُ لم يعد وارداً: الصفوف صارت في قائمةٍ ذاتِ فواصل، وإزاحةُ
        ما تحتها بسطرٍ لحظةَ الحفظ أرخصُ من ستّة فراغاتٍ دائمة. و`aria-live` باقية
        فالنتيجة تُعلَن لقارئ الشاشة كما كانت.
      */}
      {(error || results) && (
        <div className="text-[13px] leading-relaxed" aria-live="polite">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : results ? (
            <ul className="space-y-0.5">
              {results.map((slot) => (
                <li
                  key={`${slot.provider}:${slot.target ?? '-'}`}
                  className={
                    slot.outcome === 'written'
                      ? 'text-success'
                      : slot.outcome === 'failed'
                        ? 'text-danger'
                        : 'text-muted-foreground'
                  }
                >
                  {slotLabel(slot.vendorId)}
                  {': '}
                  {outcomeText(slot)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
