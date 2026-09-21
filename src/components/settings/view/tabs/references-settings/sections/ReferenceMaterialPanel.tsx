import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../../../lib/utils';
import { Button, Input } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';
import SettingsGroup from '../../../SettingsGroup';
import SettingsRow from '../../../SettingsRow';
import StatusBadge from '../../../StatusBadge';
import { REFERENCE_SCOPE_ORDER } from '../types';
import type { ReferenceItem, ReferenceScope, ReferenceScopeFilter } from '../types';

/**
 * نصّ تقني (مسار/أمر) داخل واجهة عربية: عزل ثنائي الاتجاه + أحادي المسافة.
 *
 * **‏`inline-block` لا `block` — والفرق مقيسٌ على لقطة لا مُستنتَج.** جزيرةُ
 * `dir="ltr"` من نوع `block` تحمل محاذاتَها الخاصّة (يسار)، فكان اسمُ الملفّ
 * يلتصق بالحافّة اليسرى للعمود بينما يلتصق سطرُه العربي التالي بالحافّة اليمنى
 * — سطران في صفٍّ واحد يبدآن من طرفين متقابلين. و`inline-block` يترك الوضعَ
 * لمحاذاة الأب (‏`text-start` = يمين في RTL) ويُبقي ترتيبَ المحارف داخلياً
 * لاتينياً، فيُحلّ الأمران معاً بلا خاصيّةٍ فيزيائية.
 */
function TechnicalText({ value, className }: { value: string; className?: string }) {
  return (
    <span
      dir="ltr"
      style={{ unicodeBidi: 'isolate' }}
      className={cn(
        'inline-block max-w-full break-all font-mono text-[13px] leading-relaxed',
        className,
      )}
    >
      {value}
    </span>
  );
}

const SCOPE_BADGE_TONE: Record<ReferenceScope, 'neutral' | 'info' | 'warning'> = {
  global: 'warning',
  project: 'info',
  mine: 'neutral',
  unknown: 'warning',
  // محايدة عمداً: «لا ملفَّ لهذا المحرّك» حدُّ محرّكٍ لا عطلٌ ولا خطر، ولا فعلَ
  // للقارئ فيه — فصبغُها إنذاراً يَعِد بإصلاحٍ لا وجود له.
  'no-channel': 'neutral',
};

type ReferenceMaterialPanelProps = {
  items: ReferenceItem[];
  isLoading: boolean;
  /** تعذّرت القراءة كلياً. **القائمة لا تُخفى** — الإخفاء يُقرأ «لا شيء هنا» (§6). */
  failed: boolean;
  failureCode?: string | null;
  onRetry: () => void;
  /** اسم المادة — يدخل في نصّ الخطأ والفراغ فلا تكون الجملة عامّةً لأربع موادّ. */
  materialLabel: string;
  scopeFilter: ReferenceScopeFilter;
  canManage: boolean;
  canCreate: boolean;
  saving: boolean;
  saveFailed: boolean;
  onSelect: (id: string) => void;
  onSave: (id: string, content: string) => void;
  onCreate: (name: string, content: string, provider?: string) => void;
  createProviderOptions?: Array<{ value: string; label: string }>;
};

/**
 * لوحُ المادة — **يُصمَّم مرّةً ويُعاد لأربع موادّ** (§4.2/§6).
 *
 * قائمةٌ مجمَّعةٌ بالنطاق ← لوحُ تفصيلٍ = رأسٌ + شريطُ نطاقٍ + حقول + جسمُ نصّ.
 * وحالاتُ الفراغ والتحميل والخطأ والامتلاء معرَّفةٌ هنا مرّةً واحدة، فلا تُعاد
 * صياغتُها أربع مرّات بأربع نبرات.
 *
 * **عرضُ النطاق هو الحاجز ضدّ «ظننته ملفي»** (§4.3) وهو أخطر ما في هذا السطح:
 * هذه الملفات مشتركةٌ بين كل الأعضاء، وتعديلُ عضوٍ يصيب الجميع في اللحظة نفسها.
 * فالنطاق يُقال ثلاث مرّات متراكبة: عنوانُ مجموعةٍ في القائمة، وشارةٌ في كل صفّ،
 * وشريطُ نبرةٍ في رأس التفاصيل. الشارة تجيب «ما هذا؟» والشريطُ يجيب «ماذا يقع إن
 * مسسته؟» — سؤالان بوزنين، ولذلك لا يُكتفى بأحدهما.
 */
export default function ReferenceMaterialPanel({
  items,
  isLoading,
  failed,
  failureCode,
  onRetry,
  materialLabel,
  scopeFilter,
  canManage,
  canCreate,
  saving,
  saveFailed,
  onSelect,
  onSave,
  onCreate,
  createProviderOptions = [],
}: ReferenceMaterialPanelProps) {
  const { t } = useTranslation('settings');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newProvider, setNewProvider] = useState(createProviderOptions[0]?.value ?? '');
  const wasSavingRef = useRef(false);

  useEffect(() => {
    if (wasSavingRef.current && !saving && !saveFailed) {
      setEditing(false);
      setCreating(false);
      setNewName('');
      setNewContent('');
    }
    wasSavingRef.current = saving;
  }, [saveFailed, saving]);

  /**
   * البحث يظهر فوق ~١٥ صفّاً (§6، سابقة `skills.search`) ولا يظهر دونها.
   *
   * ليس احتياطاً: قائمةُ المهارات **مئةٌ وخمسةٌ وثلاثون صفّاً** مقيسةً على هذه
   * العقدة (‏٤ محرّكات × مجلّداتها)، وعمودٌ عرضُه 15rem بلا بحثٍ يجعل بلوغَ صفٍّ
   * بعينه تمريراً أعمى. وإظهارُه على قائمةٍ من خمسة صفوف ضجيجٌ بلا مكسب.
   */
  const searchable = items.length > 15;

  const visible = useMemo(() => {
    const byScope =
      scopeFilter === 'all' ? items : items.filter((item) => item.scope === scopeFilter);
    const needle = query.trim().toLowerCase();
    if (!needle) return byScope;
    return byScope.filter((item) =>
      [item.title, item.summary, item.tag]
        .filter((part): part is string => Boolean(part))
        .some((part) => part.toLowerCase().includes(needle)));
  }, [items, scopeFilter, query]);

  // اختيارٌ سقط من القائمة (بدّل المرشِّح أو وصلت قراءةٌ جديدة) لا يبقى معروضاً.
  useEffect(() => {
    if (selectedId && !visible.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [visible, selectedId]);

  const groups = useMemo(
    () =>
      REFERENCE_SCOPE_ORDER.map((scope) => ({
        scope,
        items: visible.filter((item) => item.scope === scope),
      })).filter((group) => group.items.length > 0),
    [visible],
  );

  const selected = visible.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    setEditing(false);
    setDraft(selected?.body ?? '');
  }, [selected?.id, selected?.body]);

  useEffect(() => {
    if (!newProvider && createProviderOptions[0]) {
      setNewProvider(createProviderOptions[0].value);
    }
  }, [createProviderOptions, newProvider]);

  const scopeLabel = (scope: ReferenceScope, projectName?: string): string =>
    scope === 'project' && projectName
      ? t('references.scope.projectNamed', { name: projectName })
      : t(`references.scope.${scope}`);

  const scopeShortLabel = (scope: ReferenceScope): string =>
    t(`references.scope.short.${scope}`);

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      {/* ── القائمة ───────────────────────────────────────────────────────── */}
      <div className="min-w-0 space-y-4">
        {canManage && canCreate && (
          <div className="flex justify-end">
            <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
              {t('references.actions.add')}
            </Button>
          </div>
        )}
        {creating && (
          <SettingsCard tone="info">
            <div className="space-y-3">
              {createProviderOptions.length > 0 && (
                <select
                  value={newProvider}
                  onChange={(event) => setNewProvider(event.target.value)}
                  aria-label={t('references.fields.engine')}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {createProviderOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t('references.actions.namePlaceholder')}
                aria-label={t('references.actions.name')}
              />
              <textarea
                value={newContent}
                onChange={(event) => setNewContent(event.target.value)}
                aria-label={t('references.content.title')}
                className="min-h-48 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                dir="ltr"
              />
              <p className="text-[13px] leading-relaxed text-warning">
                {t('references.scope.banner.operatorHome')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || !newName.trim() || (createProviderOptions.length > 0 && !newProvider)}
                  onClick={() => onCreate(newName.trim(), newContent, newProvider || undefined)}
                >
                  {saving ? t('references.actions.saving') : t('references.actions.create')}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setCreating(false)}>
                  {t('references.actions.cancel')}
                </Button>
              </div>
            </div>
          </SettingsCard>
        )}
        {searchable && (
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('references.search.placeholder')}
            aria-label={t('references.search.label', { material: materialLabel })}
          />
        )}

        {failed && (
          <div role="alert" className="space-y-2">
            <p className="text-[13px] leading-relaxed text-danger">
              {failureCode === 'REFERENCE_MATERIAL_ROOT_UNAVAILABLE'
                ? t('references.error.rootUnavailable')
                : failureCode === 'REFERENCE_MATERIAL_PROVIDER_UNAVAILABLE'
                  ? t('references.error.providerUnavailable')
                  : t('references.error.list', { material: materialLabel })}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {t('references.error.retry')}
            </Button>
          </div>
        )}

        {isLoading && (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              // design-ok: هيكلٌ عظميٌّ أثناء التحميل — سطحٌ محايد يحفظ مكان
              // القائمة، لا وعاءُ تجميع. القائمة قد تطول والفراغُ المفاجئ يُقرأ عطلاً.
              <div key={row} className="h-11 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        )}

        {!isLoading && !failed && visible.length === 0 && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {query.trim()
              ? t('references.empty.noMatch')
              : t('references.empty.none', { material: materialLabel })}
          </p>
        )}

        {groups.map((group) => (
          <section key={group.scope} className="min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <StatusBadge tone={SCOPE_BADGE_TONE[group.scope]}>
                {scopeLabel(group.scope)}
              </StatusBadge>
              <span className="text-[13px] leading-relaxed text-muted-foreground">
                {group.items.length}
              </span>
            </div>

            <ul className="space-y-1">
              {group.items.map((item) => {
                const isSelected = item.id === selectedId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(item.id);
                        onSelect(item.id);
                      }}
                      className={cn(
                        // design-ok: صفٌّ قابلٌ للاختيار **تحكّمٌ** لا وعاءُ تجميع،
                        // والسطح هنا يقول «هذا المعروض» — نفس صياغة أزرار الشريط
                        // الجانبي في `SettingsSidebar`.
                        'w-full rounded-lg px-3 py-2.5 text-start transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground hover:bg-accent/50',
                      )}
                    >
                      {item.titleTechnical ? (
                        <TechnicalText value={item.title} />
                      ) : (
                        <span className="block text-[15px] font-medium leading-relaxed">
                          {item.title}
                        </span>
                      )}
                      {item.summary && (
                        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
                          {item.summary}
                        </span>
                      )}
                      {item.tag && (
                        <span className="mt-1.5 block text-[13px] leading-relaxed text-muted-foreground">
                          {item.tag}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {/* ── التفاصيل ──────────────────────────────────────────────────────── */}
      <div className="min-w-0">
        {!selected ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('references.empty.selectItem')}
          </p>
        ) : (
          <div className="min-w-0 space-y-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h4 className="min-w-0 text-base font-semibold leading-snug text-foreground">
                {selected.titleTechnical ? (
                  <TechnicalText value={selected.title} className="text-base" />
                ) : (
                  selected.title
                )}
              </h4>
              <StatusBadge tone={SCOPE_BADGE_TONE[selected.scope]}>
                {scopeShortLabel(selected.scope)}
              </StatusBadge>
            </div>

            {/* شريطُ النطاق: «ماذا يقع إن مسسته؟». `mine` بلا شريط — النبرة
                الافتراضية معبرٌ شفّاف، والتحذير الذي يُرفع على ملفٍ خاصّ يُفقد
                التحذيرَ على ملفٍ عامّ قيمتَه. */}
            {selected.scope === 'global' && (
              <SettingsCard tone="warning">
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{t('references.scope.banner.global')}</span>
                </p>
              </SettingsCard>
            )}
            {selected.scope === 'project' && (
              <SettingsCard tone="info">
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-primary">
                  <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  {/* «المشروع» بلا اسمٍ مرفوضة (§4.3-3) — وجملةٌ باسمٍ فارغ
                      («يخصّ مشروع «» …») أسوأ منها: تُقرأ عطلاً. فحين لا يعطي
                      الخادمُ اسماً تُقال الجملةُ التي لا تحتاجه. */}
                  <span className="min-w-0">
                    {selected.projectName
                      ? t('references.scope.banner.project', { name: selected.projectName })
                      : t('references.scope.banner.projectUnnamed')}
                  </span>
                </p>
              </SettingsCard>
            )}
            {selected.scope === 'unknown' && (
              <SettingsCard tone="warning">
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{t('references.scope.banner.unknown')}</span>
                </p>
              </SettingsCard>
            )}

            <SettingsGroup>
              {selected.fields.map((field) => (
                <SettingsRow
                  key={field.key}
                  label={field.label}
                  description={field.description}
                  stacked={field.technical || field.wide}
                >
                  {field.technical ? (
                    <TechnicalText value={field.value} className="text-foreground" />
                  ) : (
                    <span className="text-[13px] leading-relaxed text-muted-foreground">
                      {field.value}
                    </span>
                  )}
                </SettingsRow>
              ))}
            </SettingsGroup>

            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="text-[15px] font-medium leading-relaxed text-foreground">
                  {t('references.content.title')}
                </h5>
                {canManage && selected.canEdit && selected.body !== null && !editing && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                    {t('references.actions.edit')}
                  </Button>
                )}
              </div>
              {selected.body === null ? (
                <div className="space-y-1.5">
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {selected.contentNote ?? t('references.content.unavailable')}
                  </p>
                  {selected.bodyPath && (
                    <TechnicalText value={selected.bodyPath} className="text-muted-foreground" />
                  )}
                </div>
              ) : editing ? (
                <div className="space-y-3">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    aria-label={t('references.content.title')}
                    className="min-h-72 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    dir="ltr"
                  />
                  <p className="text-[13px] leading-relaxed text-warning">
                    {t('references.scope.banner.operatorHome')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" disabled={saving} onClick={() => onSave(selected.id, draft)}>
                      {saving ? t('references.actions.saving') : t('references.actions.save')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                      {t('references.actions.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                // كتلةٌ تقنية داخل صفّ — الموضع الذي يُبقي `bg-muted` مسموحاً (§1).
                <pre
                  dir="ltr"
                  style={{ unicodeBidi: 'isolate' }}
                  className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[13px] leading-relaxed text-foreground"
                >
                  {selected.body}
                </pre>
              )}
              {saveFailed && (
                <p role="alert" className="text-[13px] leading-relaxed text-danger">
                  {t('references.actions.saveFailed')}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
