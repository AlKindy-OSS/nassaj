import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  CheckCircle2,
  FileCode2,
  FileText,
  FileUp,
  FolderUp,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../auth/context/AuthContext';
import { cn } from '../../../lib/utils';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from '../../../shared/view/ui';
import SettingsCard from '../../settings/view/SettingsCard';
import SettingsGroup from '../../settings/view/SettingsGroup';
import SettingsRow from '../../settings/view/SettingsRow';
import SettingsSection from '../../settings/view/SettingsSection';
import StatusBadge from '../../settings/view/StatusBadge';
import { useProviderSkills } from '../hooks/useProviderSkills';
import type {
  ProviderSkill,
  ProviderSkillCreateEntryPayload,
  SkillsProject,
  SkillsProvider,
  SkillsScope,
} from '../types';

/**
 * لوح المهارات — مُرحَّلٌ إلى لغة سطوح الإعدادات (‏T-1207/ب-416).
 *
 * ما سقط هنا: ثلاثة عشر `text-xs` (دون عتبة القراءة العربية)، وستّ عائلات لون
 * خامّة في جدول `SCOPE_BADGE_CLASSES` وحده مضروبةً في `dark:` variant لكل واحدة،
 * ورأسٌ مبنيٌّ بيد بوزن `font-medium` بينما كل رأسٍ آخر في التبويب `font-semibold`
 * — فارقٌ يراه الحاجب ولا يسمّيه القارئ، وهو ما يُنتج «الصفحة مش مضبوطة» بلا
 * قدرةٍ على الإشارة إلى موضعه.
 *
 * وشارات النطاق كانت ستّ ألوان لستّ قيم — واللون هنا **تصنيفٌ لا حالة**، فلا
 * يستحقّ نبرة: النطاق لا يصير أسوأ ولا أفضل، ولا يقرأ أحدٌ «سماوي = إضافة».
 * صارت `StatusBadge` محايدة، والفرق يقوله نصّها.
 */

type ProviderSkillsProps = {
  selectedProvider: SkillsProvider;
  currentProjects: SkillsProject[];
};

type QueuedSkillSourceFile = {
  file: File;
  relativePath: string;
};

type QueuedSkillFile = {
  id: string;
  name: string;
  size: number;
  kind: 'markdown' | 'folder';
  skillFile: File;
  files: QueuedSkillSourceFile[];
};

/** رسائل الفشل مترجَمة عند نقطة الاستدعاء — الدالّة خارج المكوّن فلا `t` لها. */
type QueueFailureMessages = {
  tooManyFiles: string;
  tooLarge: string;
  missingSkillFile: string;
  unreadable: (name: string) => string;
};

const MAX_SKILL_FOLDER_FILES = 500;
const MAX_SKILL_FOLDER_BYTES = 30 * 1024 * 1024;

// Providers that support skill discovery (GET). Others skip the tab entirely.
const PROVIDER_NAMES: Record<SkillsProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  hermes: 'Hermes',
  sakana: 'Sakana',
};

// Providers that support skill installation via POST/DELETE.
const WRITE_SUPPORTED_PROVIDERS: ReadonlySet<SkillsProvider> = new Set([
  'claude',
  'codex',
  'cursor',
  'gemini',
  'qwen',
]);

// Install paths shown in the add-skill dialog.
const PROVIDER_SKILL_PATHS: Partial<Record<SkillsProvider, string>> = {
  claude: '~/.claude/skills/<skill-name>/SKILL.md',
  codex: '~/.agents/skills/<skill-name>/SKILL.md',
  cursor: '~/.cursor/skills/<skill-name>/SKILL.md',
  gemini: '~/.gemini/skills/<skill-name>/SKILL.md',
};

const SCOPE_ORDER: SkillsScope[] = ['user', 'plugin', 'repo', 'project', 'admin', 'system'];

const groupSkillsByScope = (skills: ProviderSkill[]): Array<{ scope: SkillsScope; skills: ProviderSkill[] }> => (
  SCOPE_ORDER
    .map((scope) => ({ scope, skills: skills.filter((skill) => skill.scope === scope) }))
    .filter((group) => group.skills.length > 0)
);

const formatFileSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const getBrowserRelativePath = (file: File): string => {
  const fileWithRelativePath = file as File & {
    path?: string;
    webkitRelativePath?: string;
  };
  return (
    fileWithRelativePath.webkitRelativePath
    || fileWithRelativePath.path
    || file.name
  )
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const getParentPath = (filePath: string): string => {
  const separatorIndex = filePath.lastIndexOf('/');
  return separatorIndex >= 0 ? filePath.slice(0, separatorIndex) : '';
};

const getBaseName = (filePath: string): string => {
  const segments = filePath.split('/').filter(Boolean);
  return segments.at(-1) || 'skill';
};

const readFileAsBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : '';
    const separatorIndex = result.indexOf(',');
    resolve(separatorIndex >= 0 ? result.slice(separatorIndex + 1) : result);
  };
  reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
  reader.readAsDataURL(file);
});

const buildQueuedSkillFolders = (
  selectedFiles: File[],
  messages: QueueFailureMessages,
): QueuedSkillFile[] => {
  if (selectedFiles.length > MAX_SKILL_FOLDER_FILES) {
    throw new Error(messages.tooManyFiles);
  }

  const totalSize = selectedFiles.reduce((size, file) => size + file.size, 0);
  if (totalSize > MAX_SKILL_FOLDER_BYTES) {
    throw new Error(messages.tooLarge);
  }

  const files = selectedFiles.map((file) => ({
    file,
    relativePath: getBrowserRelativePath(file),
  }));
  const skillRoots = files
    .filter(({ relativePath }) => getBaseName(relativePath).toLowerCase() === 'skill.md')
    .map(({ relativePath }) => getParentPath(relativePath))
    .sort((left, right) => right.length - left.length);

  if (skillRoots.length === 0) {
    throw new Error(messages.missingSkillFile);
  }

  return skillRoots.map((skillRoot) => {
    const skillFiles = files.filter(({ relativePath }) => {
      const owningRoot = skillRoots.find((candidateRoot) => {
        const normalizedRelativePath = relativePath.toLowerCase();
        const normalizedSkillPath = `${candidateRoot}/skill.md`.toLowerCase();
        return normalizedRelativePath === normalizedSkillPath
          || relativePath.startsWith(`${candidateRoot}/`);
      });
      return owningRoot === skillRoot;
    });
    const skillSourceFile = skillFiles.find(
      ({ relativePath }) => (
        relativePath.toLowerCase() === `${skillRoot}/skill.md`.toLowerCase()
      ),
    );
    if (!skillSourceFile) {
      throw new Error(messages.unreadable(getBaseName(skillRoot)));
    }

    return {
      id: `folder:${skillRoot}:${skillFiles.map(({ file }) => file.lastModified).join(':')}`,
      name: getBaseName(skillRoot),
      size: skillFiles.reduce((size, { file }) => size + file.size, 0),
      kind: 'folder' as const,
      skillFile: skillSourceFile.file,
      files: skillFiles.map(({ file, relativePath }) => ({
        file,
        relativePath: skillRoot ? relativePath.slice(skillRoot.length + 1) : relativePath,
      })),
    };
  });
};

/** مسارٌ تقني: `dir="ltr"` + عزلٌ ثنائي الاتجاه + `font-mono` (§3). */
function TechnicalPath({ children, className }: { children: string; className?: string }) {
  return (
    <code
      dir="ltr"
      style={{ unicodeBidi: 'isolate' }}
      className={cn('block break-all font-mono text-[13px] text-foreground', className)}
    >
      {children}
    </code>
  );
}

export default function ProviderSkills({ selectedProvider, currentProjects }: ProviderSkillsProps) {
  const { t } = useTranslation('settings');
  const { user } = useAuth();

  // Role-based write access: backend guards with 403, UI hides buttons proactively.
  const role = user?.role;
  const canWrite = (role === 'owner' || role === 'admin')
    && WRITE_SUPPORTED_PROVIDERS.has(selectedProvider);

  const {
    skills,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    saveStatus,
    addSkills,
    deleteSkill,
    refreshSkills,
  } = useProviderSkills({ selectedProvider, currentProjects });

  const [queuedFiles, setQueuedFiles] = useState<QueuedSkillFile[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [deletingSkillName, setDeletingSkillName] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const providerName = PROVIDER_NAMES[selectedProvider];
  const providerPath = PROVIDER_SKILL_PATHS[selectedProvider] ?? null;

  const queueFailureMessages = useMemo<QueueFailureMessages>(() => ({
    tooManyFiles: t('skills.errors.tooManyFiles', {
      count: MAX_SKILL_FOLDER_FILES,
      defaultValue: `A skill folder can contain up to ${MAX_SKILL_FOLDER_FILES} files.`,
    }),
    tooLarge: t('skills.errors.tooLarge', {
      defaultValue: 'Selected skill folders must be smaller than 30 MB in total.',
    }),
    missingSkillFile: t('skills.errors.missingSkillFile', {
      defaultValue: 'The selected folder does not contain a SKILL.md file.',
    }),
    unreadable: (name: string) => t('skills.errors.unreadableSkillFile', {
      name,
      defaultValue: `Could not read SKILL.md from ${name}.`,
    }),
  }), [t]);

  const setFolderInputRef = useCallback((node: HTMLInputElement | null) => {
    folderInputRef.current = node;
    if (!node) {
      return;
    }
    node.setAttribute('webkitdirectory', '');
    node.setAttribute('directory', '');
  }, []);

  // Reset transient state when provider changes.
  useEffect(() => {
    setQueuedFiles([]);
    setSubmitError(null);
    setIsSubmitting(false);
    setSearchQuery('');
    setIsAddDialogOpen(false);
    setJustInstalled(false);
    setDeletingSkillName(null);
    setDeleteError(null);
  }, [selectedProvider]);

  const filteredSkills = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return skills;
    }

    return skills.filter((skill) => (
      [
        skill.command,
        skill.name,
        skill.description,
        skill.scope,
        skill.pluginName,
        skill.projectDisplayName,
        skill.sourcePath,
      ]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
    ));
  }, [searchQuery, skills]);

  const groupedSkills = useMemo(() => groupSkillsByScope(filteredSkills), [filteredSkills]);

  const queueSkillFolders = useCallback((selectedFiles: File[]) => {
    const queuedFolders = buildQueuedSkillFolders(selectedFiles, queueFailureMessages);
    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      queuedFolders.forEach((folder) => nextMap.set(folder.id, folder));
      return [...nextMap.values()].slice(0, 20);
    });
  }, [queueFailureMessages]);

  const handleDrop = useCallback((files: File[]) => {
    const includesDirectory = files.some((file) => getBrowserRelativePath(file).includes('/'));
    if (includesDirectory) {
      try {
        queueSkillFolders(files);
        setSubmitError(null);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : t('skills.errors.dropFailed'));
      }
      return;
    }

    const acceptedFiles = files
      .filter((file) => file.name.toLowerCase().endsWith('.md'))
      .slice(0, 20);

    if (acceptedFiles.length === 0) {
      setSubmitError(t('skills.errors.dropFailed'));
      return;
    }

    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      acceptedFiles.forEach((file) => {
        const id = `${file.name}:${file.size}:${file.lastModified}`;
        nextMap.set(id, {
          id,
          name: file.name,
          size: file.size,
          kind: 'markdown',
          skillFile: file,
          files: [{ file, relativePath: 'SKILL.md' }],
        });
      });

      return [...nextMap.values()].slice(0, 20);
    });
    setSubmitError(null);
  }, [queueSkillFolders, t]);

  const handleFolderSelection = useCallback((selectedFiles: File[]) => {
    if (selectedFiles.length === 0) {
      return;
    }

    try {
      queueSkillFolders(selectedFiles);
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('skills.errors.dropFailed'));
    }
  }, [queueSkillFolders, t]);

  const { getRootProps, isDragActive } = useDropzone({
    maxFiles: MAX_SKILL_FOLDER_FILES,
    noClick: true,
    noKeyboard: true,
    onDrop: handleDrop,
  });

  const handleUploadInstall = useCallback(async () => {
    if (queuedFiles.length === 0) {
      setSubmitError(t('skills.errors.dropFailed'));
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const entries = await Promise.all<ProviderSkillCreateEntryPayload>(queuedFiles.map(async (queuedFile) => ({
        fileName: queuedFile.kind === 'folder' ? `${queuedFile.name}.md` : queuedFile.name,
        directoryName: queuedFile.kind === 'folder' ? queuedFile.name : undefined,
        content: await queuedFile.skillFile.text(),
        files: queuedFile.kind === 'folder'
          ? await Promise.all(
            queuedFile.files
              .filter(({ relativePath }) => relativePath.toLowerCase() !== 'skill.md')
              .map(async ({ file, relativePath }) => ({
                relativePath,
                content: await readFileAsBase64(file),
                encoding: 'base64' as const,
              })),
          )
          : undefined,
      })));
      await addSkills({ entries });
      setQueuedFiles([]);
      setJustInstalled(true);
      setIsAddDialogOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('skills.errors.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }, [addSkills, queuedFiles, t]);

  const handleAddDialogOpenChange = useCallback((open: boolean) => {
    if (open) {
      setSubmitError(null);
      setJustInstalled(false);
      setIsAddDialogOpen(true);
      return;
    }

    setQueuedFiles([]);
    setSubmitError(null);
    setJustInstalled(false);
    setIsAddDialogOpen(false);
  }, []);

  const handleDeleteSkill = useCallback(async (skill: ProviderSkill) => {
    if (deletingSkillName === skill.name) {
      // Second click: confirm and execute delete
      try {
        setDeleteError(null);
        await deleteSkill(skill.name);
        setDeletingSkillName(null);
      } catch (error) {
        setDeleteError(error instanceof Error ? error.message : t('skills.errors.deleteFailed'));
        setDeletingSkillName(null);
      }
      return;
    }
    // First click: enter confirm state
    setDeletingSkillName(skill.name);
    setDeleteError(null);
  }, [deleteSkill, deletingSkillName, t]);

  const scopeLabel = (scope: SkillsScope): string => {
    const key = `skills.scopes.${scope}` as const;
    return t(key as Parameters<typeof t>[0], { defaultValue: scope });
  };

  // The upload panel is extracted so it can be rendered inside the Dialog.
  const uploadPanel = (
    <div className="space-y-4">
      {providerPath && (
        // كتلةٌ تقنية داخل صفّ — `bg-muted` مسموحة لها وحدها بنصّ §1، بلا ألفا.
        <div className="rounded-lg border border-border bg-muted px-3 py-2">
          <div className="text-[13px] font-medium leading-relaxed text-muted-foreground">
            {t('skills.installPath')}
          </div>
          <TechnicalPath className="mt-1">{providerPath}</TechnicalPath>
        </div>
      )}

      <div
        {...getRootProps()}
        className={cn(
          // الحدّ المتقطّع إشارةُ «أفلت هنا» لا وعاءَ تجميع — فرعان متنافيان
          // بالكامل كي لا يبتلع صنفٌ غير مشروط نظيرَه المشروط لنفس الخاصية.
          'rounded-lg border border-dashed p-4 transition-colors duration-150 sm:p-5',
          isDragActive
            ? 'border-foreground bg-muted'
            : 'border-input hover:border-foreground',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,text/markdown"
          multiple
          className="hidden"
          onChange={(event) => {
            handleDrop(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <input
          ref={setFolderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            handleFolderSelection(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <div className="flex flex-col items-center justify-center gap-3 py-4 text-center sm:py-6">
          <FileUp className="h-7 w-7 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
          <div className="text-[15px] font-medium leading-relaxed text-foreground">
            {t('skills.dropZoneTitle')}
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="w-full sm:w-auto"
            >
              <FileUp className="h-4 w-4" aria-hidden="true" />
              {t('skills.chooseFiles')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => folderInputRef.current?.click()}
              className="w-full sm:w-auto"
            >
              <FolderUp className="h-4 w-4" aria-hidden="true" />
              {t('skills.chooseFolder')}
            </Button>
          </div>
        </div>
      </div>

      {queuedFiles.length > 0 && (
        <SettingsSection title={t('skills.queuedFiles')} icon={FileText} boxed>
          <SettingsGroup>
            {queuedFiles.map((queuedFile) => (
              <SettingsRow
                key={queuedFile.id}
                label={(
                  <span dir="ltr" style={{ unicodeBidi: 'isolate' }} className="block break-all font-mono">
                    {queuedFile.name}
                  </span>
                )}
                description={queuedFile.kind === 'folder'
                  ? t('skills.queuedFolder', {
                    count: queuedFile.files.length,
                    size: formatFileSize(queuedFile.size),
                    defaultValue: `{{count}} files · {{size}}`,
                  })
                  : t('skills.queuedMarkdown', {
                    size: formatFileSize(queuedFile.size),
                    defaultValue: 'Markdown file · {{size}}',
                  })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQueuedFiles((previous) => previous.filter((file) => file.id !== queuedFile.id));
                  }}
                >
                  {t('skills.remove')}
                </Button>
              </SettingsRow>
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}
    </div>
  );

  const hasVisibleList = filteredSkills.length > 0;

  return (
    <div className="min-w-0 space-y-8 overflow-x-hidden">
      {/* القسم الأول: ما هذا اللوح وما الفعلان المتاحان فيه. محتواه سطرُ أفعال
          واحد — فلا يُصندَق (‏SettingsSection §boxed). */}
      <SettingsSection
        icon={FileCode2}
        title={t('tabs.skills')}
        description={canWrite
          ? t('skills.description', { provider: providerName })
          : t('skills.descriptionReadOnly', { provider: providerName })}
      >
        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <Button
              onClick={() => handleAddDialogOpenChange(true)}
              size="sm"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('skills.addSkill')}
            </Button>
          )}
          <Button
            onClick={() => void refreshSkills({ force: true })}
            variant="outline"
            size="sm"
            disabled={isLoading || isLoadingProjectScopes}
            aria-label={t('skills.refresh')}
          >
            <RefreshCw
              className={cn('h-4 w-4', (isLoading || isLoadingProjectScopes) && 'animate-spin')}
              aria-hidden="true"
            />
            {t('skills.refresh')}
          </Button>
        </div>
      </SettingsSection>

      {/* Add skill dialog */}
      {canWrite && (
        <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogOpenChange}>
          <DialogContent
            className="flex h-[calc(100vh-2rem)] max-h-[760px] w-[calc(100vw-2rem)] max-w-4xl flex-col overflow-hidden p-0 sm:h-[720px]"
          >
            <DialogTitle>
              {t('skills.addSkillTitle', { provider: providerName, defaultValue: `Add ${providerName} skill` })}
            </DialogTitle>

            {/* Dialog header */}
            <div className="flex-shrink-0 border-b border-border px-4 py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <FileUp className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-semibold leading-snug text-foreground">
                    {t('skills.addSkillTitle', { provider: providerName, defaultValue: `Add ${providerName} skill` })}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={t('skills.cancel')}
                  disabled={isSubmitting}
                  onClick={() => handleAddDialogOpenChange(false)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            {/* Dialog body */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {uploadPanel}
            </div>

            {/* Dialog footer */}
            <div className="flex flex-shrink-0 flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                {(submitError || loadError) ? (
                  <SettingsCard tone="danger" className="max-h-24 overflow-y-auto">
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-danger" role="alert">
                      {submitError || loadError}
                    </p>
                  </SettingsCard>
                ) : (justInstalled && saveStatus === 'success') ? (
                  <SettingsCard tone="success">
                    <p className="text-[13px] leading-relaxed text-success" role="status">
                      {t('skills.saved')}
                    </p>
                  </SettingsCard>
                ) : (
                  <span className="text-[13px] leading-relaxed text-muted-foreground">
                    {t('skills.uploadHint')}
                  </span>
                )}
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={isSubmitting}
                  onClick={() => handleAddDialogOpenChange(false)}
                >
                  {t('skills.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => void handleUploadInstall()}
                  disabled={isSubmitting || queuedFiles.length === 0}
                >
                  {isSubmitting
                    ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : <Upload className="h-4 w-4" aria-hidden="true" />}
                  {queuedFiles.length > 1
                    ? t('skills.installCount_other', { count: queuedFiles.length, defaultValue: `Install ${queuedFiles.length} skills` })
                    : t('skills.install')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Inline errors (outside dialog) */}
      {!isAddDialogOpen && (submitError || loadError) && (
        <SettingsCard tone="danger">
          <p className="text-[13px] leading-relaxed text-danger" role="alert">
            {submitError || loadError}
          </p>
        </SettingsCard>
      )}

      {deleteError && (
        <SettingsCard tone="danger">
          <p className="text-[13px] leading-relaxed text-danger" role="alert">
            {deleteError}
          </p>
        </SettingsCard>
      )}

      {/* Success banner (only when freshly installed and dialog closed) */}
      {justInstalled && saveStatus === 'success' && !isAddDialogOpen && (
        <StatusBadge tone="success" className="gap-2">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          <span role="status">{t('skills.saved')}</span>
        </StatusBadge>
      )}

      {/* القسم الثاني: القائمة. يُصندَق حين يحمل أكثر من صفّ فعلاً. */}
      <SettingsSection
        icon={FileText}
        title={t('skills.visibleSkills')}
        boxed={hasVisibleList}
      >
        {(skills.length > 0 || isLoadingProjectScopes) && (
          <SettingsGroup>
            <SettingsRow
              label={t('skills.search')}
              description={isLoadingProjectScopes ? t('skills.scanning') : undefined}
            >
              {skills.length > 0 && (
                <div className="relative w-full sm:w-64">
                  {/* RTL-safe icon: start-3 = inset-inline-start */}
                  <Search
                    className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={t('skills.search')}
                    aria-label={t('skills.search')}
                    className="h-9 w-full pe-9 ps-9"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label={t('skills.clearSearch')}
                      className="absolute end-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </SettingsRow>
          </SettingsGroup>
        )}

        {/* Loading state */}
        {isLoading && skills.length === 0 && (
          <p className="flex min-h-[120px] items-center justify-center text-[13px] leading-relaxed text-muted-foreground">
            <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
            {t('skills.loading', { provider: providerName })}
          </p>
        )}

        {/* Empty state — بلا وعاء مرسوم: الفراغ نفسه هو الرسالة. */}
        {!isLoading && skills.length === 0 && (
          <div className="py-10 text-center">
            <FileText className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-[15px] font-medium leading-relaxed text-foreground">
              {t('skills.empty')}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('skills.emptyDescription')}
            </p>
          </div>
        )}

        {/* No search results */}
        {!isLoading && skills.length > 0 && filteredSkills.length === 0 && (
          <div className="py-10 text-center">
            <Search className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-[15px] font-medium leading-relaxed text-foreground">
              {t('skills.noMatch')}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('skills.noMatchDescription')}
            </p>
          </div>
        )}

        {/* Grouped skill rows */}
        {groupedSkills.map((group) => (
          <section key={group.scope} className="min-w-0 space-y-2 py-2">
            <div className="flex items-center gap-2">
              <StatusBadge>{scopeLabel(group.scope)}</StatusBadge>
              <span className="text-[13px] leading-relaxed text-muted-foreground">
                {group.skills.length}
              </span>
            </div>

            <SettingsGroup>
              {group.skills.map((skill) => {
                const isConfirmingDelete = deletingSkillName === skill.name;
                const isDeletable = canWrite && skill.scope !== 'plugin' && skill.scope !== 'system';

                return (
                  <SettingsRow
                    key={`${skill.command}:${skill.sourcePath}:${skill.projectPath || 'global'}`}
                    label={(
                      <span
                        dir="ltr"
                        style={{ unicodeBidi: 'isolate' }}
                        className="block break-all font-mono"
                      >
                        {skill.command}
                      </span>
                    )}
                    description={(
                      <span className="block space-y-1">
                        <span className="block text-foreground">{skill.name}</span>
                        {skill.disableModelInvocation === true && <span className="block text-xs text-foreground">{t('skillObservations.manualOnly', { ns: 'chat' })}</span>}
                        <span className="block">
                          {skill.description || t('skills.noDescription', {
                            defaultValue: 'No description provided in the skill front matter.',
                          })}
                        </span>
                        {(skill.pluginName || skill.projectDisplayName) && (
                          <span className="flex flex-wrap items-center gap-2 pt-1">
                            {skill.pluginName && (
                              <StatusBadge>{`${t('skills.plugin')}: ${skill.pluginName}`}</StatusBadge>
                            )}
                            {skill.projectDisplayName && (
                              <StatusBadge>{`${t('skills.project')}: ${skill.projectDisplayName}`}</StatusBadge>
                            )}
                          </span>
                        )}
                        <span className="block pt-1">
                          {t('skills.source')}
                          {': '}
                          <code
                            dir="ltr"
                            style={{ unicodeBidi: 'isolate' }}
                            className="break-all font-mono text-[13px] text-foreground"
                          >
                            {skill.sourcePath}
                          </code>
                        </span>
                      </span>
                    )}
                  >
                    {isDeletable && (isConfirmingDelete ? (
                      <span className="flex items-center justify-end gap-1.5">
                        <span className="text-[13px] leading-relaxed text-muted-foreground">
                          {t('skills.confirmDelete', { name: skill.name, defaultValue: `Delete «${skill.name}»?` })}
                        </span>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="h-8 px-2.5 text-[13px]"
                          onClick={() => void handleDeleteSkill(skill)}
                        >
                          {t('skills.confirmYes')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setDeletingSkillName(null)}
                          aria-label={t('skills.cancel')}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-danger"
                        onClick={() => void handleDeleteSkill(skill)}
                        aria-label={`${t('skills.delete')}: ${skill.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    ))}
                  </SettingsRow>
                );
              })}
            </SettingsGroup>
          </section>
        ))}
      </SettingsSection>
    </div>
  );
}
