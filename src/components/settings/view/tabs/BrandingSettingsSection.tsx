import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageIcon, Loader2 } from 'lucide-react';

import { useAuth } from '../../../auth';
import { useBranding } from '../../../../contexts/BrandingContext';
import { api } from '../../../../utils/api';
import { DEFAULT_PAGE_BRAND } from '../../../../utils/pageTitleNotification';
import { Button, Input } from '../../../../shared/view/ui';
import SegmentedControl from '../SegmentedControl';
import SettingsCard from '../SettingsCard';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

// 48 KB raw → ≤ 64 KB as base64 data-URI (base64 adds ~33% overhead).
const NODE_ICON_MAX_BYTES = 49152;
const NODE_ICON_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

// نفس سقف الخادم (`BRANDING_TITLE_MAX_LENGTH` في server/routes/settings.js):
// يُقصّ عند الكتابة بدل انتظار 400 بعد الحفظ.
const APP_TITLE_MAX_LENGTH = 60;

type Feedback = { kind: 'success' | 'error'; message: string } | null;

/**
 * Owner-only branding section inside the Appearance settings tab.
 *
 * Lets the server owner set the app-wide brand name (shown in the browser tab
 * title, the sidebar header, the PWA manifest and push notifications) and
 * upload a small "node icon" shown next to the nassaj logo in the sidebar —
 * useful for distinguishing different server instances. Both live in app_config: the name as
 * `branding.title`, the icon as a base64 data-URI, so no new static route or
 * server/index.js change is required.
 */
export default function BrandingSettingsSection() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const { title, nodeIconDataUri, nodeIconPosition, nodeIconHref, refresh } = useBranding();

  // All hooks must be declared before any conditional return (rules-of-hooks).
  // Local brand-name override. null = inherit from context (no change pending).
  const [localTitle, setLocalTitle] = useState<string | null>(null);
  // Pending new icon (not yet saved). null = no change.
  const [pendingDataUri, setPendingDataUri] = useState<string | null>(null);
  // Local position override. null = inherit from context (no change pending).
  const [localPosition, setLocalPosition] = useState<'start' | 'end' | null>(null);
  // Local link override. null = inherit from context (no change pending).
  const [localHref, setLocalHref] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSaving, setIsSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFeedback(null);

    if (!NODE_ICON_ALLOWED_TYPES.includes(file.type)) {
      setFeedback({ kind: 'error', message: t('appearanceSettings.branding.nodeIcon.errors.unsupported') });
      event.target.value = '';
      return;
    }

    if (file.size > NODE_ICON_MAX_BYTES) {
      setFeedback({ kind: 'error', message: t('appearanceSettings.branding.nodeIcon.errors.tooBig') });
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setPendingDataUri(reader.result as string);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }, [t]);

  // تغيّرٌ في حقول الأيقونة وحدها — يفصل طلب الأيقونة عن طلب الاسم.
  const hasIconChanges = pendingDataUri !== null || localPosition !== null || localHref !== null;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      // كلُّ حقلٍ يُرسَل عند تغيّره وحده: الخادم يكتب ما يصله فقط، فإرسال ما لم
      // يُمَسّ يُسجّل تعديلاً في سجلّ التدقيق بلا تغيير فعلي.
      if (localTitle !== null) {
        // فارغٌ = مسحُ الاسم المخصّص والعودة إلى الاسم الافتراضي (سلوك الخادم).
        const resp = await api.branding.updateTitle(localTitle.trim());
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? 'Failed to save');
        }
      }

      if (hasIconChanges) {
        const dataUri = pendingDataUri ?? nodeIconDataUri;
        const effectivePosition = localPosition ?? nodeIconPosition;
        const effectiveHref = (localHref ?? nodeIconHref ?? '').trim();
        const resp = await api.branding.updateNodeIcon(dataUri, effectivePosition, effectiveHref);
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? 'Failed to save');
        }
      }

      await refresh();
      setLocalTitle(null);
      setPendingDataUri(null);
      setLocalPosition(null);
      setLocalHref(null);
      setFeedback({ kind: 'success', message: t('appearanceSettings.branding.saved') });
    } catch (error) {
      // A malformed link is rejected with a 400 whose message names the actual
      // problem — show it instead of the generic failure text, so the owner
      // knows which of the two fields to fix.
      const detail = error instanceof Error ? error.message : '';
      setFeedback({
        kind: 'error',
        message: detail && detail !== 'Failed to save'
          ? detail
          : t('appearanceSettings.branding.nodeIcon.errors.saveFailed'),
      });
    } finally {
      setIsSaving(false);
    }
  }, [localTitle, hasIconChanges, pendingDataUri, nodeIconDataUri, localPosition, nodeIconPosition, localHref, nodeIconHref, refresh, t]);

  const handleClear = useCallback(async () => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const resp = await api.branding.clearNodeIcon();
      if (!resp.ok) throw new Error();
      await refresh();
      setPendingDataUri(null);
      // Position is intentionally NOT reset — remembered for re-upload.
      setFeedback({ kind: 'success', message: t('appearanceSettings.branding.nodeIcon.cleared') });
    } catch {
      setFeedback({ kind: 'error', message: t('appearanceSettings.branding.nodeIcon.errors.saveFailed') });
    } finally {
      setIsSaving(false);
    }
  }, [refresh, t]);

  // Only owners can manage server-level branding.
  if (user?.role !== 'owner') {
    return null;
  }

  const effectivePosition = localPosition ?? nodeIconPosition;
  const previewUri = pendingDataUri ?? nodeIconDataUri;
  const effectiveHref = localHref ?? nodeIconHref ?? '';
  const effectiveTitle = localTitle ?? title ?? '';
  const hasChanges = hasIconChanges || localTitle !== null;

  return (
    <SettingsSection
      boxed
      icon={ImageIcon}
      title={t('appearanceSettings.branding.title')}
      description={t('appearanceSettings.branding.description')}
    >
      {/* لوحٌ داخلي: القسم صفوفٌ **ثم** حصيلةٌ وفعل، وأبناء البطاقة المباشرون
          بلا فجوة بينهم. */}
      <div className="space-y-3 py-2">
      <SettingsGroup>
        {/* اسم العلامة: أوّل الصفوف لأنه أوسعها أثراً — عنوان تبويب المتصفح
            ورأس الشريط الجانبي وبيان التطبيق وإشعارات الدفع. فارغٌ = العودة
            إلى الاسم الافتراضي، ولذلك كان النائبُ هو `DEFAULT_PAGE_BRAND` نفسه
            لا نصّاً مترجَماً: الحقل الفارغ يعني تلك القيمة حرفياً في التبويب. */}
        <SettingsRow
          stacked
          label={
            <label htmlFor="branding-app-title">
              {t('appearanceSettings.branding.appTitle.label')}
            </label>
          }
          description={t('appearanceSettings.branding.appTitle.description')}
        >
          <Input
            id="branding-app-title"
            type="text"
            maxLength={APP_TITLE_MAX_LENGTH}
            spellCheck={false}
            placeholder={DEFAULT_PAGE_BRAND}
            value={effectiveTitle}
            onChange={(event) => setLocalTitle(event.target.value)}
            disabled={isSaving}
          />
        </SettingsRow>

        {/* Icon upload row */}
        <SettingsRow
          stacked
          label={t('appearanceSettings.branding.nodeIcon.label')}
          description={t('appearanceSettings.branding.nodeIcon.description')}
        >
          <div className="flex items-center gap-3">
            {/* Preview box */}
            {previewUri && (
              /* سطحٌ بلا حدّ (§1): الحدّ هنا كان يكرّر حدّ البطاقة الحاوية بنفس
                 الرمز — إطارٌ داخل إطار لا يضيف بكسلاً في الوضع الداكن حيث
                 `--border` و`--muted` متطابقان. والألفا سقطت عن السطح. */
              <div
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-muted"
                aria-hidden="true"
              >
                <img
                  src={previewUri}
                  alt={t('appearanceSettings.branding.nodeIcon.preview')}
                  className="h-7 w-7 rounded-sm object-contain"
                />
              </div>
            )}

            {/* Hidden file input triggered by Upload button */}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={handleFileChange}
              className="sr-only"
              aria-label={t('appearanceSettings.branding.nodeIcon.upload')}
              tabIndex={-1}
            />

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={isSaving}
            >
              {previewUri
                ? t('appearanceSettings.branding.nodeIcon.change')
                : t('appearanceSettings.branding.nodeIcon.upload')}
            </Button>

            {previewUri && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={isSaving}
                className="text-danger hover:bg-destructive/10 hover:text-danger"
              >
                {isSaving
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : t('appearanceSettings.branding.nodeIcon.clear')}
              </Button>
            )}
          </div>
        </SettingsRow>

        {/* Position selector — قيمةٌ واحدة لها حالتان مسمّاتان، فمنتقٍ مجزّأ لا
            زرّا اختيارٍ خامّان كانا يُقرآن فعلين مستقلّين. */}
        <SettingsRow
          label={t('appearanceSettings.branding.nodeIcon.position.label')}
        >
          <SegmentedControl
            options={(['start', 'end'] as const).map((pos) => ({
              value: pos,
              label: t(`appearanceSettings.branding.nodeIcon.position.${pos}`),
            }))}
            value={effectivePosition}
            onChange={setLocalPosition}
            label={t('appearanceSettings.branding.nodeIcon.position.label')}
          />
        </SettingsRow>

        {/* Optional link opened when the icon is clicked */}
        <SettingsRow
          stacked
          label={
            <label htmlFor="node-icon-href">
              {t('appearanceSettings.branding.nodeIcon.link.label')}
            </label>
          }
          description={t('appearanceSettings.branding.nodeIcon.link.description')}
        >
          <Input
            id="node-icon-href"
            type="url"
            inputMode="url"
            dir="ltr"
            spellCheck={false}
            placeholder={t('appearanceSettings.branding.nodeIcon.link.placeholder')}
            value={effectiveHref}
            onChange={(event) => setLocalHref(event.target.value)}
            disabled={isSaving}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* الحصيلة والفعل خارج قائمة الصفوف: كلاهما يخصّ القسم كلّه لا صفّاً
          بعينه، ووضعهما داخل القائمة كان يجعل الفاصل الشعري يفصل نصّاً عن فعلٍ
          يتبعه. */}
      <div className="space-y-3">
        {/* الحصيلة صندوقُ نبرة لا نصّاً ملوّناً عارياً: الرموز `--success`
            و`--danger` صارت في `src/index.css` (‏B-399)، فالصندوق المُنبَّر متاح
            وهو ما يفعله الأصل — نجاحٌ أو فشلٌ يقع خارج تدفّق الصفوف يحتاج سطحاً
            يفصله عنها لا لوناً يُلتقط بالعين وحدها (‏WCAG 1.4.1). */}
        {feedback && (
          <SettingsCard tone={feedback.kind === 'success' ? 'success' : 'danger'}>
            <p
              role="status"
              className={
                feedback.kind === 'success'
                  ? 'text-[13px] leading-relaxed text-success'
                  : 'text-[13px] leading-relaxed text-danger'
              }
            >
              {feedback.message}
            </p>
          </SettingsCard>
        )}

        {/* Save button — only visible when there are pending changes */}
        {hasChanges && (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {isSaving
                ? t('appearanceSettings.branding.nodeIcon.saving')
                : t('appearanceSettings.branding.nodeIcon.save')}
            </Button>
          </div>
        )}
      </div>
      </div>
    </SettingsSection>
  );
}
