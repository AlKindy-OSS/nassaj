/**
 * TmpfsCapSection — سقف المسارات التي تعيش في الذاكرة (`/tmp` و`/dev/shm`).
 *
 * **لا يطبّق شيئاً، ولا يدّعي أنه يفعل.** ‏`mount -o remount` يحتاج root
 * والخادم يعمل بحساب غير مميّز، فالقسم يقرأ الواقع من `/proc/mounts`، ويحفظ
 * السقف المرغوب، ويُسلّم الأمر الجاهز لينفّذه المالك في طرفيته. زرٌّ يقول
 * «طُبِّق» بينما لم يُطبَّق شيء أسوأ من غياب الزرّ.
 *
 * ولماذا يهمّ السقف أصلاً: بلا `size=` يكون سقف tmpfs **نصف ذاكرة الجهاز**،
 * فأمرٌ واحد يبتلع نصف الصندوق ولا يُستردّ إلا بحذفٍ أو إعادة إقلاع. وقد حجز
 * فعلاً 2.7GB خمساً وأربعين ساعة في 29–31 يوليو 2026.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, Loader2, MemoryStick } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import SegmentedControl from '../SegmentedControl';
import SettingsCard from '../SettingsCard';
import type { SegmentedOption } from '../SegmentedControl';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import StatusBadge from '../StatusBadge';

type TmpfsMount = {
  mount: string;
  hasExplicitCap: boolean;
  capMb: number | null;
  totalMb: number | null;
  usedMb: number | null;
};

type TmpfsPolicy = {
  mounts: TmpfsMount[];
  desiredMb: number | null;
  command: string | null;
  fstabHint: string | null;
  appliesItself: boolean;
};

/**
 * الخيارات المعروضة. `'none'` = بلا سقف (سلوك النظام الافتراضي: نصف الذاكرة).
 *
 * ترتيبها تصاعدي عمداً، وتُعرض مجموعةَ اختيارٍ واحدة (‏`SegmentedControl`) لا
 * أزراراً منفصلة: أربعة أزرار متجاورة تُقرأ كأربعة أفعال مستقلّة، بينما هي
 * قيمةٌ واحدة لها أربع حالات — وواحدة منها فقط سارية.
 *
 * والقيم نصوص لا أرقام لأن `null` لا يصلح قيمةَ خيار في مجموعة اختيار؛ التحويل
 * إلى `number | null` عند الإرسال وحده، فما يُحفظ لم يتغيّر.
 */
const NO_CAP = 'none';

const CHOICES: Array<{ value: string; mb: number | null; label: string | null }> = [
  { value: '512', mb: 512, label: '512MB' },
  { value: '1024', mb: 1024, label: '1GB' },
  { value: '2048', mb: 2048, label: '2GB' },
  { value: NO_CAP, mb: null, label: null }, // ← نصّه من الترجمة (عربي، لا لصيقة لاتينية)
];

const formatMb = (mb: number | null): string => {
  if (mb === null || !Number.isFinite(mb)) return '—';
  return mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`;
};

export default function TmpfsCapSection() {
  const { t } = useTranslation('settings');
  const [policy, setPolicy] = useState<TmpfsPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/system/tmpfs-policy');
      if (!res.ok) throw new Error(String(res.status));
      setPolicy((await res.json()) as TmpfsPolicy);
      setError(null);
    } catch {
      setError(t('tmpfsCap.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (mb: number | null) => {
    setSaving(true);
    try {
      const res = await authenticatedFetch('/api/system/tmpfs-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desiredMb: mb }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await load();
      setError(null);
    } catch (err) {
      // سبب الفشل يغيّر ما يفعله المستخدم: صلاحية ناقصة ≠ عطل خادم.
      const forbidden = err instanceof Error && err.message === '403';
      setError(forbidden ? t('tmpfsCap.saveForbidden') : t('tmpfsCap.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const copyCommand = () => {
    if (!policy?.command) return;
    void navigator.clipboard?.writeText(policy.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // الفارق بين الواقع والمرغوب — هو كل قيمة هذا القسم.
  const drifted =
    policy?.desiredMb != null &&
    policy.mounts.some(m => m.capMb === null || Math.abs(m.capMb - policy.desiredMb!) > 1);

  const desiredValue = policy && policy.desiredMb !== null ? String(policy.desiredMb) : NO_CAP;

  const capOptions: SegmentedOption<string>[] = CHOICES.map(c => ({
    value: c.value,
    label: c.label ?? t('tmpfsCap.uncapped'),
    // «بلا سقف» هي الحالة التي حجزت 2.7GB خمساً وأربعين ساعة — وهي الخيار
    // الوحيد في المجموعة الذي يرفع حاجزاً، فيأخذ نبرة الخطر وحده.
    danger: c.mb === null,
  }));

  return (
    /* `MemoryStick` — القسم يحكم مساراتٍ تعيش في **الذاكرة**، والأيقونة تقول
       ذلك قبل قراءة العنوان. ونبرته محايدة: القسم نفسه إعدادٌ عادي، والخطر
       يسكن حالاته (بلا سقف / انحراف) لا عنوانه. */
    <SettingsSection
      boxed
      icon={MemoryStick}
      title={t('tmpfsCap.title')}
      description={t('tmpfsCap.description')}
    >
      {loading ? (
        /* نمط التحميل الموحَّد: كان أيقونةً دوّارة عارية بلا نصّ — دوّارٌ بلا
           كلمة لا يقول أيّ شيءٍ يُحمَّل. */
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('commandBoardSettings.loading')}
        </div>
      ) : (
        /* `py-2` فوق حشو البطاقة الضيّق (`py-1.5`): هذا القسم ليس قائمة صفوف
           وحدها، فمحتواه يحتاج نَفَساً عن حدّ البطاقة. */
        <div className="space-y-4 py-2">
          {/* الشارة تصريحٌ بنموذج الحفظ: هذا القسم يحفظ فور النقر، بينما يعلوه في
              التبويب نفسه قسمٌ لا يُحفظ إلا بزرّ. نموذجان في شاشة واحدة يجب أن
              يُقالا، لا أن يُستنتجا. */}
          <div className="flex items-center justify-between gap-2">
            <StatusBadge>{t('commandBoardSettings.savesImmediately')}</StatusBadge>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
            )}
          </div>

          {/* الفشل صندوقُ نبرة لا نصّاً أحمر عارياً (الخريطة: `danger` = منع). */}
          {error && (
            <SettingsCard tone="danger">
              <p className="text-[13px] leading-relaxed text-danger" role="alert">
                {error}
              </p>
            </SettingsCard>
          )}

          {/* الواقع الآن ثم السقف المرغوب — قائمة صفوف واحدة (§2.2): الحالة
              المقروءة والقيمة المضبوطة وجهان لإعدادٍ واحد، وفصلُهما كان يجعل
              الفارق بينهما — وهو كلّ قيمة هذا القسم — يُقرأ في مكانين. */}
          <SettingsGroup>
            {policy?.mounts.map(m => (
              <SettingsRow
                key={m.mount}
                label={
                  <bdi dir="ltr" className="block truncate font-mono text-[13px] text-foreground">
                    {m.mount}
                  </bdi>
                }
              >
                <div className="flex items-center gap-2">
                  <bdi dir="ltr" className="text-[13px] tabular-nums text-muted-foreground">
                    {formatMb(m.usedMb)} / {formatMb(m.totalMb)}
                  </bdi>
                  {/* سقفٌ مضبوط = حاجزٌ قائم (`success`)، وبلا سقفٍ = الحاجز
                      مرفوع (`danger`) — وهي الحالة التي حجزت 2.7GB خمساً
                      وأربعين ساعة. كانت الأولى محايدة، فلا يقول شيءٌ إن كانت
                      حالةً سليمة أم مجرّد لصيقة. */}
                  <StatusBadge tone={m.hasExplicitCap ? 'success' : 'danger'}>
                    {m.hasExplicitCap ? t('tmpfsCap.capped') : t('tmpfsCap.uncapped')}
                  </StatusBadge>
                </div>
              </SettingsRow>
            ))}

            {/* السقف المرغوب — قيمةٌ واحدة لها أربع حالات، فمجموعة اختيار لا
                أربعة أزرار تُقرأ أربعة أفعال. `stacked` لأن أربعة خيارات لا
                تتّسع بجانب لصيقتها على شاشة ضيّقة. */}
            <SettingsRow stacked label={t('tmpfsCap.desiredLabel')}>
              <div
                aria-busy={saving}
                className={saving ? 'pointer-events-none opacity-60' : undefined}
              >
                <SegmentedControl
                  options={capOptions}
                  value={desiredValue}
                  onChange={value => {
                    const choice = CHOICES.find(c => c.value === value);
                    if (choice) void choose(choice.mb);
                  }}
                  label={t('tmpfsCap.desiredLabel')}
                  className="flex-wrap"
                />
              </div>
            </SettingsRow>
          </SettingsGroup>

          {/* الأمر — الخادم لا يملك صلاحية تنفيذه، ويقول ذلك.
              الشرح نصٌّ حرّ، والأمر وحده كتلة سطحٍ واحدة: كان صندوقاً مؤطَّراً
              يحوي صندوقاً ثانياً بخلفية أخرى — طبقتان داخل بطاقة. */}
          {policy?.command && (
            <div className="space-y-2">
              {/* «الخادم لا يملك صلاحية التطبيق» تنبيهٌ دائمٌ لا يمنع — وهو
                  بالضبط موضع صندوق النبرة في الأصل: منطقةٌ ليست كبقيّتها. كان
                  نصّاً رمادياً يُقرأ حاشيةً بينما هو شرط عمل القسم كلّه. */}
              <SettingsCard tone="warning">
                <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('tmpfsCap.manualNote')}
                </p>
              </SettingsCard>
              <div className="flex items-center gap-2 rounded-md bg-muted p-3">
                <bdi
                  dir="ltr"
                  className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-foreground"
                >
                  {policy.command}
                </bdi>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="flex-shrink-0 px-3"
                  onClick={copyCommand}
                  aria-label={copied ? t('tmpfsCap.copied') : t('tmpfsCap.copy')}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </Button>
              </div>
              {policy.fstabHint && (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {t('tmpfsCap.fstabNote')}{' '}
                  <bdi dir="ltr" className="font-mono">
                    {policy.fstabHint}
                  </bdi>
                </p>
              )}
            </div>
          )}

          {/* الانحراف بين الواقع والمرغوب — تنبيهٌ لا يمنع، فصندوق `warning`. */}
          {drifted && (
            <SettingsCard tone="warning">
              <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t('tmpfsCap.drift')}
              </p>
            </SettingsCard>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
