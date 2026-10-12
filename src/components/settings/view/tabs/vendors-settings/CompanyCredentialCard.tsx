import { useEffect, useMemo } from 'react';
import { Check, ExternalLink, Info, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Tooltip } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import { useSettingsNavigation } from '../../SettingsNavigationContext';
import {
  useCompanyKey,
  type CompanySlotResult,
} from '../../../../provider-auth/hooks/useCompanyKey';
import { type VendorCompany, type VendorCredentialStore } from '../../../../../../shared/vendors';

import MigrationConflictBlock from './MigrationConflictBlock';
import VendorFeedsRow from './VendorFeedsRow';
import { DeleteVendorKeyDialog, ReplaceForeignDialog } from './VendorKeyDialogs';
import { describeFailure, useVendorCardActions } from './useVendorCardActions';
import { buildFeedItems, foreignItems, isEnginePinVendor } from './vendorFeeds';

/**
 * CompanyCredentialCard — the credential surface for ONE vendor (ADR-085,
 * ADR-200 S9). The vendor owns a single key; nassaj fans it out to every
 * harness that vendor feeds, so the card holds:
 *
 *   name + terms tooltip · one key field · Save · Delete (vendor-wide)
 *   «يغذّي:» one badge per harness, saying what happened to that copy
 *
 * There is no per-place choice any more. The checkboxes, «يُكتب في» and the
 * red/amber subscription notices are gone: whether a harness takes a key is
 * decided by its link mode (the account page), and the badge row says so in
 * words, so nobody learns about a billing change from the invoice.
 *
 * THIS IS THE ONLY COMPONENT THAT WRITES A PROVIDER SECRET (B-343): the
 * engines panel and the account pages show state and link here.
 *
 * ‏`defaultValue` باقٍ عمداً على مفاتيح هذا الملف: `vendorKeyEntryVisibility.test.tsx`
 * يزيّف `t` بحيث تُرجع `defaultValue`، فحذفُها يُعمي اختبار انقطاعٍ حقيقي (B-367).
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
 * الحقل وزرّ حفظه — **الحقل الوحيد في البطاقة**. عرضُه ثابتٌ لا يعلم بالأزرار،
 * والحذف في عمود الأفعال لا هنا: مفتاحٌ مخزَّن لا يضيّق حقلَ شركته عن جاراتها.
 */
function CredentialField({
  inputId,
  ariaLabelSave,
  value,
  onChange,
  onSave,
  stored,
  busy,
  canSave,
}: {
  inputId: string;
  ariaLabelSave?: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** فيه مفتاحٌ مخزَّن الآن؟ — يغيّر نصَّ الحقل لا غير. */
  stored: boolean;
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
          stored
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
 * إفصاحٌ ثنائي اللغة + مربّع موافقة، لشركة Alibaba Cloud وحدها (T-1906، قرار
 * المالك 2026-09-28).
 *
 * لماذا هذه الشركة وحدها تحمل هذا: مفتاح Alibaba Coding Plan هو اشتراكٌ شخصي
 * يُمرَّر عبر حامل OpenCode لا عبر وكيلٍ أصيلٍ له، وأربعُ حقائق فيه لا تصدق على
 * بقية الشركات: (1) الاستخدام شخصيٌّ وتفاعليٌّ فقط — لا أتمتة ولا تشغيلٌ خلفي؛
 * (2) Alibaba تملك تعليق المفتاح أو إبطاله من طرفها؛ (3) النموذج نفسه يرى
 * المفتاح أثناء الجلسة — فإبطالُه من لوحة Alibaba هو الإجراء عند الشكّ لا حذفُه
 * من هنا فقط؛ (4) الشفرة تُرسَل إلى منطقة Alibaba الدولية.
 *
 * ولا تُقال «مشاركة مع الفريق» ولا «الخلفية» في أيّ صياغة: هذا مفتاحٌ شخصي
 * لاستخدامٍ تفاعلي شخصي، لا موردٌ مشترك.
 *
 * الموافقة **تُرسَل صراحةً** (`consent: true`) في نداء الحفظ، ولا تُفترض من
 * مجرّد فتح الشاشة — الخادم يرفض بلا 400 حين تغيب (شرطٌ خادميّ منفصل).
 */
function AlibabaConsentDisclosure({
  checked,
  onToggle,
  disabled,
}: {
  checked: boolean;
  onToggle: (next: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('settings');
  const checkboxId = 'alibaba-cloud-key-consent';

  return (
    <SettingsCard tone="info">
      <div className="space-y-2">
        <p className="text-[13px] leading-relaxed text-foreground">
          {t('vendors.consent.alibaba.intro', {
            defaultValue:
              'This links your personal Alibaba Coding Plan subscription for your own interactive '
              + 'use through OpenCode — not a shared team credential.',
          })}
        </p>
        <ul className="list-disc space-y-1 ps-4 text-[13px] leading-relaxed text-muted-foreground">
          <li>
            {t('vendors.consent.alibaba.personalInteractive', {
              defaultValue:
                'For your personal, interactive use only — not for automation or background runs.',
            })}
          </li>
          <li>
            {t('vendors.consent.alibaba.suspend', {
              defaultValue: 'Alibaba may suspend or revoke this key at any time, on their side.',
            })}
          </li>
          <li>
            {t('vendors.consent.alibaba.modelSeesKey', {
              defaultValue:
                'The AI model can see this key during a session. If you suspect it leaked, revoke it '
                + 'from the Alibaba console — not only by removing it here.',
            })}
          </li>
          <li>
            {t('vendors.consent.alibaba.internationalRegion', {
              defaultValue: 'Your code is sent to Alibaba’s international region.',
            })}
          </li>
        </ul>
        <label htmlFor={checkboxId} className="flex cursor-pointer items-start gap-2 pt-1">
          <input
            id={checkboxId}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onToggle(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span className="text-[13px] leading-relaxed text-foreground">
            {t('vendors.consent.alibaba.checkbox', {
              defaultValue: 'I understand and accept these terms for my personal key.',
            })}
          </span>
        </label>
      </div>
    </SettingsCard>
  );
}

/** رابط «احصل على مفتاح» — فعلٌ لا حالة (B-362: لا يُعرض لمن لن يُسمح له بالتخزين). */
function GetKeyLink({ keyUrl }: { keyUrl: string }) {
  const { t } = useTranslation('settings');
  return (
    <a
      href={keyUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-sm text-[13px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t('vendors.getKey', { defaultValue: 'Get a key' })}
      {/* أيقونة «رابط خارجي» تُعكَس دلالياً في RTL. */}
      <ExternalLink className="h-3 w-3 rtl:-scale-x-100" aria-hidden="true" />
    </a>
  );
}

/** One generic terms line per vendor, behind an info button named for the vendor. */
function TermsTooltip({ company }: { company: string }) {
  const { t } = useTranslation('settings');
  return (
    <Tooltip content={t('vendors.link.terms')} position="bottom" multiline tapToToggle>
      <button
        type="button"
        aria-label={t('vendors.link.infoLabel', { company })}
        className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** Kept/failed notes after a Delete. `removed` and `absent` are silent (brief §2). */
function DeleteNotes({ results }: { results: readonly CompanySlotResult[] }) {
  const { t } = useTranslation('settings');
  const notes = results.flatMap((slot) => {
    if (slot.outcome === 'adopted_credential' || slot.outcome === 'foreign_credential') {
      return [{ slot, key: 'kept' }];
    }
    return slot.outcome === 'failed' ? [{ slot, key: 'retry' }] : [];
  });
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-[13px] leading-relaxed text-muted-foreground" aria-live="polite">
      {notes.map(({ slot, key }) => (
        <li key={slot.vendorId}>{t(`vendors.link.deleteNote.${key}`)}</li>
      ))}
    </ul>
  );
}

export type CompanyKeyState = { configured: boolean; loading: boolean };

/** B-362/B-367: a refusal is STATED (`=== false`: silence is not a refusal), never a box that 403s. */
function NotWritableNotice({ company }: { company: string }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsCard tone="info">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t('vendors.company.notWritable', {
          company,
          defaultValue:
            '{{company}} credentials are shared across the team, so only an owner or admin '
            + 'can set them here. Ask them to add the key — once stored, you can use it.',
        })}
      </p>
    </SettingsCard>
  );
}

export default function CompanyCredentialCard({
  company,
  onKeyState,
}: {
  company: VendorCompany;
  /** يُبلِّغ الغلافَ بحالة مفتاح هذه الشركة بلا نداءٍ ثانٍ لنفس النقطة. */
  onKeyState?: (state: CompanyKeyState) => void;
}) {
  const { t } = useTranslation('settings');
  const navigation = useSettingsNavigation();
  const companyKey = useCompanyKey(company.id);
  const { slots, projections, migrationConflict, configured, loading, saving, failure, writable } = companyKey;
  const isAlibaba = company.id === 'alibaba-cloud';
  const actions = useVendorCardActions(companyKey, isAlibaba);

  useEffect(() => {
    onKeyState?.({ configured, loading });
  }, [onKeyState, configured, loading]);

  // The server's list only narrows what the catalogue offers; it never adds a row.
  const shownVendors = slots.length > 0
    ? company.vendors.filter((vendor) => slots.some((slot) => slot.vendorId === vendor.id))
    : company.vendors;
  const feedItems = useMemo(
    () => buildFeedItems({ vendors: shownVendors, slots, projections, saveResults: actions.saveResults }),
    [shownVendors, slots, projections, actions.saveResults],
  );
  const foreign = foreignItems(feedItems);
  const replaceable = foreign.filter((item) => item.state === 'foreign_credential');
  const enginePin = shownVendors.some(isEnginePinVendor);
  const enginePinSaved = Boolean(actions.saveResults?.some((slot) => slot.outcome === 'linked'
    && shownVendors.some((vendor) => vendor.id === slot.vendorId && isEnginePinVendor(vendor))));
  const draftFilled = actions.draftKey.trim().length > 0;
  const busy = saving || loading;
  const inputId = `company-api-key-${company.id}`;

  if (writable === false) return <NotWritableNotice company={company.name} />;

  return (
    <div data-company={company.id} className="space-y-2 py-2.5">
      {migrationConflict && (
        <MigrationConflictBlock
          company={company.name}
          sources={migrationConflict.sources}
          busy={busy}
          onChoose={(source) => { void companyKey.resolveConflict(source); }}
        />
      )}

      <div className="grid grid-cols-1 items-center gap-x-3 gap-y-2 sm:grid-cols-[8.5rem_1fr_11rem]">
        <div className="flex min-w-0 items-center gap-1">
          <label
            htmlFor={inputId}
            dir="ltr"
            className="truncate text-start text-[15px] font-medium text-foreground"
          >
            {company.name}
          </label>
          <TermsTooltip company={company.name} />
        </div>

        <div className="min-w-0">
          <CredentialField
            inputId={inputId}
            ariaLabelSave={t('vendors.save', { vendor: company.name, defaultValue: 'Save {{vendor}} key' })}
            value={actions.draftKey}
            onChange={actions.setDraftKey}
            onSave={() => { void actions.save(false); }}
            stored={configured}
            busy={busy}
            canSave={!isAlibaba || actions.consent}
          />
        </div>

        <div className="flex items-center justify-end gap-x-3">
          {(configured || feedItems.length > 0) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => actions.setDialog('delete')}
              disabled={busy}
              aria-label={t('vendors.remove', { vendor: company.name, defaultValue: 'Remove {{vendor}} key' })}
              className="shrink-0 text-danger hover:text-danger"
            >
              <Trash2 className="h-4 w-4" />
              <span className="ms-1.5">{t('vendors.removeShort', { defaultValue: 'Remove' })}</span>
            </Button>
          )}
          {!configured && company.vendors.some((vendor) => vendor.keyUrl) && (
            <GetKeyLink keyUrl={company.vendors.find((vendor) => vendor.keyUrl)?.keyUrl ?? ''} />
          )}
        </div>
      </div>

      {slots.some((slot) => slot.status === 'incompatible_profile') && (
        <SettingsCard tone="warning">
          <p className="text-[13px] leading-relaxed text-warning">
            {t('vendors.company.incompatibleProfile', {
              defaultValue:
                'The key saved here is not compatible with the current Coding Plan setup — '
                + 're-enter a Coding Plan key to use it.',
            })}
          </p>
        </SettingsCard>
      )}

      {isAlibaba && (
        <AlibabaConsentDisclosure checked={actions.consent} onToggle={actions.setConsent} disabled={busy} />
      )}

      {draftFilled && <DeliveryNote stores={company.vendors.map((vendor) => vendor.store)} />}

      <VendorFeedsRow
        items={feedItems}
        enginePin={enginePin}
        onReplace={replaceable.length > 0 ? () => actions.setDialog('replace') : null}
        canReplace={draftFilled && !busy}
        onOpenAccount={navigation ? (provider) => navigation.openAgentAccount(provider as 'claude' | 'codex') : null}
      />

      {enginePinSaved && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('vendors.link.enginePin.tooltip')}</p>
      )}

      {failure && (
        <p role="alert" className="text-[13px] leading-relaxed text-danger">
          {describeFailure(failure, actions.tokenDraft, t)}
        </p>
      )}
      {actions.deleteResults && <DeleteNotes results={actions.deleteResults} />}

      {actions.dialog === 'delete' && (
        <DeleteVendorKeyDialog
          company={company.name}
          items={feedItems}
          foreign={foreign}
          hasUnifiedKey={enginePin}
          busy={busy}
          onConfirm={(removeForeignKey) => { void actions.remove(removeForeignKey); }}
          onCancel={() => actions.setDialog(null)}
        />
      )}
      {actions.dialog === 'replace' && (
        <ReplaceForeignDialog
          company={company.name}
          harnesses={replaceable.map((item) => item.harness)}
          busy={busy}
          onConfirm={() => { void actions.save(true); }}
          onCancel={() => actions.setDialog(null)}
        />
      )}
    </div>
  );
}
