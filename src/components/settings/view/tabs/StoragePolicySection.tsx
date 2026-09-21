/**
 * StoragePolicySection — عمر المحادثة وحدود صورها، في مكان واحد.
 *
 * لماذا الثلاثة معاً: في ذهن المالك سؤالٌ واحد — «كم أحتفظ، وبأي حجم؟». وفصلُ
 * عمر المحادثة عن حدود صورها يجعل نصف الجواب في شاشة ونصفه في أخرى.
 *
 * **يطبّق فعلاً، بخلاف قسم tmpfs الذي يعلوه.** عمر المحادثة يُكتب في
 * `cleanupPeriodDays` بطبقة حاكمية Claude، فيكنس المحرّك نصوصه بنفسه ويزيل
 * watcher نسّاج صفوفها — لا كانس موازٍ. لذلك التغيير هنا **يُتلف بيانات لاحقاً**،
 * وهذا ما تقوله البطاقة التحذيرية صراحةً بدل نصّ محايد.
 *
 * القياس الذي أنشأ هذا القسم (2026-08-04): `cleanupPeriodDays` لم يكن مضبوطاً
 * في أي طبقة، فكان السائد افتراض المحرّك (30 يوماً) لا الستّين التي ظنّها المالك
 * سارية. احتفاظٌ يعيش في الذاكرة وحدها ليس سياسة.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, HardDrive, Loader2, Trash2 } from 'lucide-react';

import { api, authenticatedFetch } from '../../../../utils/api';
import { SESSION_BUCKET_KEYS } from '../../../../../shared/sessionBuckets';
import type { Project, ProjectSession } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import SettingsCard from '../SettingsCard';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import StatusBadge from '../StatusBadge';

type StoragePolicy = {
  retentionDays: number;
  retentionDaysIsDefault: boolean;
  imageMaxMb: number;
  imageMaxMbIsDefault: boolean;
  imageMaxCount: number;
  imageMaxCountIsDefault: boolean;
};

/**
 * نفس صنف المنسدلات في تبويب المظهر (`UiFontPicker`, `AppearanceSettingsTab`)
 * — سطحُ تحكّمٍ واحد عبر الإعدادات كلّها لا ثلاثة أشكال لثلاث شاشات.
 */
const SELECT_CLASS =
  'w-full touch-manipulation rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** مدى مدّة الاحتفاظ بالأيام؛ يطابق تقييد الخادم في `/api/system/storage-policy`. */
const RETENTION_MIN_DAYS = 7;
const RETENTION_MAX_DAYS = 365;
const IMAGE_MB_CHOICES = [2, 5, 10, 25];
const IMAGE_COUNT_CHOICES = [5, 15, 30, 50];

/**
 * ينفّذ الاحتفاظ الآن عبر المسارين الحيّين القائمين: قائمة جلسات كل مشروع ثم
 * الحذف الجماعي النهائي. لا مسار خادمي جديد: خطّ نشر الخادم محجوز (B-1030)،
 * والمسارات القائمة تمرّ بالبوابة نفسها (الملف والصف معاً، وحقّ الكتابة).
 * المنجَّمة تُستثنى لأن النجمة تصويتٌ بالإبقاء.
 */
async function purgeExpiredSessions(retentionDays: number): Promise<{ deleted: number; skippedStarred: number }> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const projectsRes = await api.projects();
  if (!projectsRes.ok) throw new Error(String(projectsRes.status));
  const projects = (await projectsRes.json()) as Project[];
  const expired: string[] = [];
  let skippedStarred = 0;
  for (const project of projects) {
    for (const session of await listAllProjectSessions(project.projectId)) {
      const last = Date.parse(session.lastActivity ?? '');
      if (!Number.isFinite(last) || last >= cutoff) continue;
      if (session.isStarred) skippedStarred += 1;
      else expired.push(session.id);
    }
  }
  let deleted = 0;
  for (let i = 0; i < expired.length; i += BULK_CHUNK) {
    const chunk = expired.slice(i, i + BULK_CHUNK);
    const res = await api.bulkSessions(chunk, 'delete_permanently');
    if (!res.ok) throw new Error(String(res.status));
    deleted += chunk.length;
  }
  return { deleted, skippedStarred };
}

/** يجمع كل جلسات المشروع عبر الصفحات، من كل دلاء المزوّدات. */
async function listAllProjectSessions(projectId: string): Promise<ProjectSession[]> {
  const out: ProjectSession[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await api.projectSessions(projectId, { limit: PAGE_SIZE, offset });
    if (!res.ok) throw new Error(String(res.status));
    const page = (await res.json()) as Partial<Record<string, ProjectSession[]>> & { sessionMeta?: { hasMore?: boolean } };
    for (const key of SESSION_BUCKET_KEYS) out.push(...(page[key] ?? []));
    if (!page.sessionMeta?.hasMore) return out;
  }
}

const PAGE_SIZE = 100;
/** سقف المسار الجماعي الحيّ (`/api/providers/sessions/bulk`). */
const BULK_CHUNK = 100;

export default function StoragePolicySection() {
  const { t } = useTranslation('settings');
  const [policy, setPolicy] = useState<StoragePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** مسودّة حقل الأيام؛ تُحفظ عند مغادرة الحقل أو Enter لا مع كل ضغطة. */
  const [retentionDraft, setRetentionDraft] = useState('');
  const [purging, setPurging] = useState(false);
  const [purgeResult, setPurgeResult] = useState<{ deleted: number; skippedStarred: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/system/storage-policy');
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as StoragePolicy;
      setPolicy(next);
      setRetentionDraft(String(next.retentionDays));
      setError(null);
    } catch {
      setError(t('storagePolicy.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<Record<keyof StoragePolicy, number>>) => {
    setSaving(true);
    try {
      const res = await authenticatedFetch('/api/system/storage-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as StoragePolicy;
      setPolicy(next);
      setRetentionDraft(String(next.retentionDays));
      setError(null);
    } catch (err) {
      // سبب الفشل يغيّر ما يفعله المستخدم: صلاحية ناقصة ≠ عطل خادم.
      const forbidden = err instanceof Error && err.message === '403';
      setError(
        forbidden
          ? t('storagePolicy.saveForbidden')
          : t('storagePolicy.saveFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  /** يحفظ مسودّة الأيام ثم يطبّق السياسة السارية فوراً بعد تأكيد صريح. */
  const saveAndPurge = async () => {
    commitRetention();
    if (!window.confirm(t('storagePolicy.purgeConfirm'))) return;
    setPurging(true);
    setPurgeResult(null);
    try {
      setPurgeResult(await purgeExpiredSessions(policy?.retentionDays ?? 30));
      setError(null);
    } catch (err) {
      const forbidden = err instanceof Error && err.message === '403';
      setError(forbidden ? t('storagePolicy.saveForbidden') : t('storagePolicy.purgeFailed'));
    } finally {
      setPurging(false);
    }
  };

  /** يقصّ القيمة إلى المدى المسموح ويحفظها إن تغيّرت، وإلا يعيد المسودّة للقيمة المحفوظة. */
  const commitRetention = () => {
    const current = policy?.retentionDays ?? 30;
    const parsed = Number.parseInt(retentionDraft, 10);
    if (!Number.isFinite(parsed)) {
      setRetentionDraft(String(current));
      return;
    }
    const clamped = Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, parsed));
    setRetentionDraft(String(clamped));
    if (clamped !== current) void save({ retentionDays: clamped });
  };


  return (
    <SettingsSection
      boxed
      icon={HardDrive}
      title={t('storagePolicy.title')}
      description={t('storagePolicy.description')}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] leading-relaxed text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('commandBoardSettings.loading')}
        </div>
      ) : (
        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <StatusBadge>{t('commandBoardSettings.savesImmediately')}</StatusBadge>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
            )}
          </div>

          {error && (
            <SettingsCard tone="danger">
              <p className="text-[13px] leading-relaxed text-danger" role="alert">
                {error}
              </p>
            </SettingsCard>
          )}

          {/* التحذير قبل المنتقي لا بعده: القيمة تُطبَّق فور النقر، والحذف الذي
              تسبّبه لا رجعة فيه — فيُقرأ الأثر قبل أن يُصنع. */}
          <SettingsCard tone="warning">
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
              <span>
                {t('storagePolicy.warning')}
              </span>
            </p>
          </SettingsCard>

          <SettingsGroup>
            <SettingsRow
              label={t('storagePolicy.retentionLabel')}
              description={t('storagePolicy.retentionHint')}
            >
              <input
                type="number"
                inputMode="numeric"
                min={RETENTION_MIN_DAYS}
                max={RETENTION_MAX_DAYS}
                step={1}
                value={retentionDraft}
                onChange={(event) => setRetentionDraft(event.target.value)}
                onBlur={commitRetention}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                aria-label={t('storagePolicy.retentionLabel')}
                disabled={saving}
                className={cn(SELECT_CLASS, 'sm:w-56')}
              />
            </SettingsRow>

            <SettingsRow
              label={t('storagePolicy.purgeLabel')}
              description={t('storagePolicy.purgeHint')}
            >
              <div className="flex flex-col gap-2 sm:items-end">
                <button
                  type="button"
                  onClick={() => void saveAndPurge()}
                  disabled={saving || purging || !policy}
                  className="inline-flex touch-manipulation items-center justify-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm text-danger hover:bg-destructive/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:w-56"
                >
                  {purging ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                  {t('storagePolicy.purgeButton')}
                </button>
                {purgeResult && (
                  <p className="text-[13px] text-muted-foreground" role="status">
                    {t('storagePolicy.purgeResult', purgeResult)}
                  </p>
                )}
              </div>
            </SettingsRow>

            <SettingsRow
              label={t('storagePolicy.imageMbLabel')}
            >
              <select
                value={policy?.imageMaxMb ?? 5}
                onChange={(event) => void save({ imageMaxMb: Number(event.target.value) })}
                aria-label={t('storagePolicy.imageMbLabel')}
                disabled={saving}
                className={cn(SELECT_CLASS, 'sm:w-56')}
              >
                {IMAGE_MB_CHOICES.map((option) => (
                  <option key={option} value={option}>
                    {`${option}MB`}
                  </option>
                ))}
              </select>
            </SettingsRow>

            <SettingsRow
              label={t('storagePolicy.imageCountLabel')}
              description={t('storagePolicy.imageCountHint')}
            >
              <select
                value={policy?.imageMaxCount ?? 15}
                onChange={(event) => void save({ imageMaxCount: Number(event.target.value) })}
                aria-label={t('storagePolicy.imageCountLabel')}
                disabled={saving}
                className={cn(SELECT_CLASS, 'sm:w-56')}
              >
                {IMAGE_COUNT_CHOICES.map((option) => (
                  <option key={option} value={option}>
                    {t('storagePolicy.imagesCount', { count: option })}
                  </option>
                ))}
              </select>
            </SettingsRow>
          </SettingsGroup>
        </div>
      )}
    </SettingsSection>
  );
}
