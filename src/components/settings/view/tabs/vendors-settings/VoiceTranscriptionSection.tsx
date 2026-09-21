/**
 * VoiceTranscriptionSection — «التفريغ الصوتي الدقيق» (ADR-103 / T-1247).
 *
 * ## لماذا هنا، في تبويب «المورّدون والاعتمادات»، لا في تبويب جديد
 *
 * لهذا التبويب قاعدةٌ مكتوبة بلا استثناء (`VendorsSettingsTab`، T-1219):
 *
 *   > كلُّ حقل إدخال مفتاحٍ في نسّاج يُصيَّر من هنا. ولا حقلَ في أي سطحٍ آخر.
 *
 * ومفتاح التفريغ مفتاحُ مورّدٍ **خارج**: يُرسَل إلى نقطةٍ متوافقة مع OpenAI
 * (‏Groq مثلاً) ويُدفع ثمنُه لتلك الشركة — وهو بالضبط جنسُ ما يسكن هذه الصفحة،
 * ونقيضُ تبويب «الوصول البرمجي» الذي مفاتيحُه تدخل إلى نسّاج. فتبويبٌ ثالث كان
 * سيُنشئ حقلَ سرٍّ في سطحٍ آخر، أي أوّلَ فرعٍ في قاعدةٍ وُجدت بلا فروع بعد أن
 * كلّف الفرعُ السابق عطلاً حيّاً (B-343: كاتبان لسجلٍّ واحد).
 *
 * وهو **قسمٌ لا صفٌّ في قائمة الشركات**: تلك القائمة مولَّدة من كتالوج المورّدين
 * (`shared/vendors`)، وهذا الإعداد ليس مورّداً في الكتالوج بل ميزةٌ لها علمُ
 * تشغيل ونقطةُ نهاية وسقفُ حجم — ثلاثةُ أشياء لا يعرفها صفُّ الشركة.
 *
 * ## ولماذا لا يَعِد بما يرفضه الخادم
 *
 * لكل فعلٍ هنا حاكمٌ مختلف عند الخادم (`voice.routes.ts`)، فتُحسب الصلاحية لكلٍّ
 * على حدة بدل مفتاحٍ واحد يقرّر عن الجميع:
 *
 *   • العلمُ والنقطةُ والسقف → `canManage` من الخادم (مالك، وخارج وضع المنصّة).
 *   • مفتاحُ **كامل التثبيت** → مالك أو مشرف.
 *   • مفتاحُ **حسابي وحدي** → أيُّ عضو، لنفسه.
 *
 * ومع ذلك تُعرض رسالةُ الخادم عند الرفض بدل ابتلاعها: وضعُ المنصّة
 * (`PLATFORM_MODE_WRITE_REFUSED`) وتحقّقُ القيم (`INVALID_BASE_URL`) حالتان لا
 * يستطيع العميل توقّعهما، وإخفاؤهما خلف «تعذّر الحفظ» هو نصفُ العطل في B-367.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Mic, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../shared/view/ui';
import { useOptionalAuth } from '../../../../auth/context/AuthContext';
import {
  useVoiceTranscription,
  type TranscriptionKeyScope,
} from '../../../hooks/useVoiceTranscription';
import SegmentedControl, { type SegmentedOption } from '../../SegmentedControl';
import SettingsCard from '../../SettingsCard';
import SettingsGroup from '../../SettingsGroup';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';
import StatusBadge from '../../StatusBadge';

/**
 * سقفُ حجم التسجيل الصلب. **مكرَّرٌ عمداً** من
 * `voice-transcription.service.ts:HARD_MAX_MB` لأن ذاك ملفُّ خادم لا يُستورد في
 * الحزمة العميلية — وهو معروضٌ للقارئ لا مفروضٌ عليه: الخادم يرفض ما فوقه
 * برمز `INVALID_MAX_MB`، وهذا الرقم يشرح الرفضَ قبل وقوعه لا يمنعه.
 */
const HARD_MAX_MB = 25;

/** النطاقان، بترتيبِ الأقلّ أثراً أوّلاً في الافتراض ولا في العرض. */
const KEY_SCOPES: readonly TranscriptionKeyScope[] = ['system', 'user'];

export default function VoiceTranscriptionSection() {
  const { t } = useTranslation('settings');
  /**
   * ‏`useOptionalAuth` لا `useAuth`: بلا مزوّدٍ في الشجرة يرمي الثاني ويُسقط
   * التبويب كلَّه — قسمٌ إضافي لا يجوز أن يكون سببَ سقوط جيرانه. والغياب هنا
   * يُقرأ **دوراً مجهولاً**، أي أقلَّ الصلاحيات، وهو الاتجاه الآمن للانحدار.
   */
  const auth = useOptionalAuth();
  const user = auth?.user;
  const {
    state,
    loading,
    loadFailed,
    saving,
    error,
    updateSettings,
    saveKey,
    deleteKey,
  } = useVoiceTranscription();

  const role = user?.role;
  /**
   * مفتاحُ التثبيت يُنفقه كلُّ عضو، فحاكمُه أوسع من حاكم بقيّة الإعدادات: الخادم
   * يقبله من مالكٍ أو مشرف (`resolveKeyScope`)، بينما العلمُ للمالك وحده.
   */
  const canManageSystemKey = role === 'owner' || role === 'admin';

  const [draftKey, setDraftKey] = useState('');
  /**
   * الافتراض «حسابي وحدي» لا «كامل التثبيت»، ولو كان القارئ مالكاً: حفظٌ في
   * نطاق التثبيت يجعل كلَّ عضوٍ ينفق هذا الاعتماد، وهو قرارٌ يُتّخذ لا افتراضٌ
   * يُورَث — نفسُ منطق مربّع الاشتراك في بطاقة الشركة.
   */
  const [scope, setScope] = useState<TranscriptionKeyScope>('user');
  const [savedScope, setSavedScope] = useState<TranscriptionKeyScope | null>(null);

  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftMaxMb, setDraftMaxMb] = useState('');

  // القيم المعروضة تتبع ما أجاب به الخادم — عند أول قراءة وبعد كل حفظ ناجح،
  // فلو قصّ الخادمُ قيمةً ظهر المقصوصُ لا ما كُتب في الحقل.
  useEffect(() => {
    setDraftBaseUrl(state.baseUrl);
    setDraftModel(state.model);
    setDraftMaxMb(state.maxMb > 0 ? String(state.maxMb) : '');
  }, [state.baseUrl, state.model, state.maxMb]);

  const scopeOptions: SegmentedOption<TranscriptionKeyScope>[] = useMemo(
    () => [
      {
        value: 'system',
        label: t('voiceTranscription.scope.system'),
        // الخيارُ الممنوع يبقى مرئياً ويقول سببَه — لا يُخفى ولا يُترك ليفشل عند النقر.
        blockedReason: canManageSystemKey ? null : t('voiceTranscription.scope.systemBlocked'),
      },
      { value: 'user', label: t('voiceTranscription.scope.user') },
    ],
    [canManageSystemKey, t],
  );

  const handleToggle = (next: boolean) => {
    setSavedScope(null);
    void updateSettings({ enabled: next }, t('voiceTranscription.saveFailed'));
  };

  const handleSaveKey = async () => {
    setSavedScope(null);
    const result = await saveKey(draftKey, scope, t('voiceTranscription.key.saveFailed'));
    if (result.ok) {
      // السرّ لا يبقى في الحالة بعد نجاح الحفظ: يُفرَّغ الحقل، ولا نسخةَ له في
      // أي مكان آخر — الخطّاف لم يحتفظ به أصلاً.
      setDraftKey('');
      setSavedScope(scope);
    }
  };

  const handleDeleteKey = (target: TranscriptionKeyScope) => {
    setSavedScope(null);
    void deleteKey(target, t('voiceTranscription.key.deleteFailed'));
  };

  const handleSaveConfig = () => {
    setSavedScope(null);
    const parsedMaxMb = Number(draftMaxMb);
    void updateSettings(
      {
        baseUrl: draftBaseUrl.trim(),
        model: draftModel.trim(),
        // قيمةٌ غير رقمية لا تُرسَل: الخادم سيردّها برمز `INVALID_MAX_MB`، وطلبٌ
        // نعرف سلفاً أنه مرفوض ضجيجٌ على السجلّ لا معلومةٌ للقارئ.
        ...(Number.isFinite(parsedMaxMb) && parsedMaxMb > 0 ? { maxMb: parsedMaxMb } : {}),
      },
      t('voiceTranscription.saveFailed'),
    );
  };

  const busy = saving || loading;

  return (
    <SettingsSection
      boxed
      icon={Mic}
      title={t('voiceTranscription.title')}
      description={t('voiceTranscription.description')}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('voiceTranscription.loading')}
        </div>
      ) : (
        <div className="space-y-4 py-2">
          {/* اختيار المحرّك قرارُ لغة قبل أن يكون قرار كلفة — وهو ما لا يخطر
              للمُشغّل قبل أن يجرّب ويخيب. المحرّك المحلي مقيسٌ ممتازاً في
              الإنجليزية وضعيفاً في العربية على معالج بلا كرت رسوم، فقولُه هنا
              يوفّر على من يُملي بالعربية جولةَ تجربةٍ فاشلة كاملة. */}
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('voiceTranscription.languageNote')}
          </p>

          {/* فشلُ القراءة يُقال ولا يُترجَم إلى «مطفأة»: الحالة مقفلة فعلاً
              (لا تحكّم يعمل)، لكن الشاشة لا تدّعي علماً بما لم تقرأه. */}
          {loadFailed && (
            <SettingsCard tone="danger">
              <p role="alert" className="text-[13px] leading-relaxed text-danger">
                {t('voiceTranscription.loadFailed')}
              </p>
            </SettingsCard>
          )}

          <SettingsRow
            label={t('voiceTranscription.toggleLabel')}
            description={
              state.enabled ? t('voiceTranscription.stateOn') : t('voiceTranscription.stateOff')
            }
          >
            <div className="flex min-h-10 shrink-0 items-center gap-2">
              {saving && (
                <Loader2
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <SettingsToggle
                checked={state.enabled}
                onChange={handleToggle}
                disabled={!state.canManage || busy || loadFailed}
                ariaLabel={t('voiceTranscription.toggleLabel')}
              />
            </div>
          </SettingsRow>

          {/* مفتاحٌ ميّت بلا سبب أسوأ من غيابه (نمط `externalApi.ownerOnly`). */}
          {!state.canManage && !loadFailed && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('voiceTranscription.ownerOnly')}
            </p>
          )}

          {error && (
            <SettingsCard tone="danger">
              <p role="alert" className="text-[13px] leading-relaxed text-danger">
                {error}
              </p>
            </SettingsCard>
          )}

          {/* نقاطُ المفتاح كلها خلف بوابة العلم عند الخادم (‏404 حين يكون مطفأً)،
              فحقلٌ يُعرض تحت علمٍ مطفأ وعدٌ لا يُوفى. */}
          {state.enabled && (
            <SettingsGroup>
              <SettingsRow
                stacked
                label={t('voiceTranscription.key.label')}
                description={t('voiceTranscription.key.hint')}
              >
                <div className="space-y-3">
                  <SegmentedControl
                    value={scope}
                    options={scopeOptions}
                    label={t('voiceTranscription.scope.label')}
                    onChange={setScope}
                  />

                  <div className="flex flex-wrap items-center gap-2">
                    {/* قيمةٌ تقنية داخل صفحة عربية: جزيرةُ `ltr` بعزل bidi، كما
                        في `CredentialField`. و`type=password` فلا يُقرأ السرّ من
                        فوق الكتف ولا يلتقطه مُكمِّل المتصفح. */}
                    <input
                      id="voice-transcription-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      dir="ltr"
                      style={{ unicodeBidi: 'isolate' }}
                      value={draftKey}
                      disabled={busy}
                      onChange={(event) => setDraftKey(event.target.value)}
                      placeholder={
                        state.key[scope]
                          ? t('voiceTranscription.key.placeholderStored')
                          : t('voiceTranscription.key.placeholder')
                      }
                      className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] text-foreground placeholder:font-sans placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <Button
                      size="sm"
                      onClick={() => void handleSaveKey()}
                      disabled={
                        busy
                        || draftKey.trim().length === 0
                        || (scope === 'system' && !canManageSystemKey)
                      }
                      aria-label={t('voiceTranscription.key.saveAria')}
                    >
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Check className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span className="ms-1.5">{t('voiceTranscription.key.save')}</span>
                    </Button>
                  </div>

                  {/* التحذير يتبع الفعلَ المُوشك لا احتمالَه: لا يظهر إلا ومفتاحٌ
                      في الحقل ونطاقُ التثبيت مختار. */}
                  {scope === 'system' && canManageSystemKey && draftKey.trim().length > 0 && (
                    <SettingsCard tone="warning">
                      <p className="text-[13px] leading-relaxed text-warning">
                        {t('voiceTranscription.scope.systemNotice')}
                      </p>
                    </SettingsCard>
                  )}

                  {savedScope && (
                    <p
                      className="text-[13px] leading-relaxed text-success"
                      aria-live="polite"
                    >
                      {t('voiceTranscription.key.saved', {
                        scope: t(`voiceTranscription.scope.${savedScope}`),
                      })}
                    </p>
                  )}

                  {/* حالةُ كلِّ نطاق على حدة وحذفٌ مستقلّ لكلٍّ: «مخزَّن» مجمَّعة
                      تقول «في مكانٍ ما» — وهو عينُ اللبس الذي أصلحه T-1232. */}
                  <ul className="space-y-1.5">
                    {KEY_SCOPES.map((entry) => {
                      const configured = state.key[entry];
                      const mayDelete = entry === 'user' || canManageSystemKey;
                      return (
                        <li
                          key={entry}
                          data-scope={entry}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-relaxed text-muted-foreground"
                        >
                          <span className="text-foreground">
                            {t(`voiceTranscription.scope.${entry}`)}
                          </span>
                          {configured ? (
                            <StatusBadge tone="success">
                              {t('voiceTranscription.key.stored')}
                            </StatusBadge>
                          ) : (
                            <StatusBadge>{t('voiceTranscription.key.missing')}</StatusBadge>
                          )}
                          {configured && mayDelete && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleDeleteKey(entry)}
                              disabled={busy}
                              aria-label={t('voiceTranscription.key.deleteAria', {
                                scope: t(`voiceTranscription.scope.${entry}`),
                              })}
                              className="ms-auto text-danger hover:text-danger"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                              <span className="ms-1.5">{t('voiceTranscription.key.delete')}</span>
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  {!state.available && (
                    <p className="text-[13px] leading-relaxed text-muted-foreground">
                      {t('voiceTranscription.key.noneNotice')}
                    </p>
                  )}
                </div>
              </SettingsRow>

              {state.canManage ? (
                <SettingsRow
                  stacked
                  label={t('voiceTranscription.endpoint.label')}
                  description={t('voiceTranscription.endpoint.hint')}
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor="voice-transcription-base-url">
                        {t('voiceTranscription.endpoint.label')}
                      </label>
                      <input
                        id="voice-transcription-base-url"
                        type="url"
                        dir="ltr"
                        style={{ unicodeBidi: 'isolate' }}
                        spellCheck={false}
                        value={draftBaseUrl}
                        disabled={busy}
                        onChange={(event) => setDraftBaseUrl(event.target.value)}
                        className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor="voice-transcription-model">
                        {t('voiceTranscription.model.label')}
                      </label>
                      <input
                        id="voice-transcription-model"
                        type="text"
                        dir="ltr"
                        style={{ unicodeBidi: 'isolate' }}
                        spellCheck={false}
                        value={draftModel}
                        disabled={busy}
                        onChange={(event) => setDraftModel(event.target.value)}
                        placeholder={t('voiceTranscription.model.label')}
                        className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] text-foreground placeholder:font-sans placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        className="text-[13px] leading-relaxed text-muted-foreground"
                        htmlFor="voice-transcription-max-mb"
                      >
                        {t('voiceTranscription.maxMb.label')}
                      </label>
                      <input
                        id="voice-transcription-max-mb"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={HARD_MAX_MB}
                        dir="ltr"
                        style={{ unicodeBidi: 'isolate' }}
                        value={draftMaxMb}
                        disabled={busy}
                        onChange={(event) => setDraftMaxMb(event.target.value)}
                        className="w-24 rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <Button
                        size="sm"
                        onClick={handleSaveConfig}
                        disabled={busy}
                        aria-label={t('voiceTranscription.endpoint.saveAria')}
                      >
                        {saving ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        )}
                        <span className="ms-1.5">{t('voiceTranscription.endpoint.save')}</span>
                      </Button>
                    </div>

                    {/* السقفُ الصلب يُقال، ولا يُعتمد عليه: الرفض يقع عند الخادم
                        ورسالتُه هي ما يُعرض حين يقع. */}
                    <p className="text-[13px] leading-relaxed text-muted-foreground">
                      {t('voiceTranscription.maxMb.hint', { max: HARD_MAX_MB })}
                    </p>
                  </div>
                </SettingsRow>
              ) : (
                // العضو يرى الوجهةَ التي سيُرسَل إليها مفتاحُه — وهي ليست سرّاً،
                // وإخفاؤها يجعله يسلّم اعتماداً إلى نقطةٍ لا يعرفها.
                <SettingsRow
                  stacked
                  label={t('voiceTranscription.endpoint.label')}
                  description={t('voiceTranscription.endpoint.readOnly')}
                >
                  <p
                    dir="ltr"
                    style={{ unicodeBidi: 'isolate' }}
                    className="font-mono text-[13px] leading-relaxed text-foreground"
                  >
                    {state.baseUrl}
                    {' · '}
                    {state.model}
                    {' · '}
                    {state.maxMb}
                    MB
                  </p>
                </SettingsRow>
              )}
            </SettingsGroup>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
