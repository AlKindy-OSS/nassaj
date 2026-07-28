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
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from '../../../shared/view/ui';
import { useProviderSkills } from '../hooks/useProviderSkills';
import type {
  ProviderSkill,
  ProviderSkillCreateEntryPayload,
  SkillsProject,
  SkillsProvider,
  SkillsScope,
} from '../types';

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

const MAX_SKILL_FOLDER_FILES = 500;
const MAX_SKILL_FOLDER_BYTES = 30 * 1024 * 1024;

// Providers that support skill discovery (GET). Others skip the tab entirely.
const PROVIDER_NAMES: Record<SkillsProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  opencode: 'OpenCode',
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
]);

// Install paths shown in the add-skill dialog.
const PROVIDER_SKILL_PATHS: Partial<Record<SkillsProvider, string>> = {
  claude: '~/.claude/skills/<skill-name>/SKILL.md',
  codex: '~/.agents/skills/<skill-name>/SKILL.md',
  cursor: '~/.cursor/skills/<skill-name>/SKILL.md',
  gemini: '~/.gemini/skills/<skill-name>/SKILL.md',
};

const SCOPE_BADGE_CLASSES: Record<SkillsScope, string> = {
  user: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  plugin: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  repo: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  project: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  admin: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  system: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300',
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

const buildQueuedSkillFolders = (selectedFiles: File[]): QueuedSkillFile[] => {
  if (selectedFiles.length > MAX_SKILL_FOLDER_FILES) {
    throw new Error(`A skill folder can contain up to ${MAX_SKILL_FOLDER_FILES} files.`);
  }

  const totalSize = selectedFiles.reduce((size, file) => size + file.size, 0);
  if (totalSize > MAX_SKILL_FOLDER_BYTES) {
    throw new Error('Selected skill folders must be smaller than 30 MB in total.');
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
    throw new Error('The selected folder does not contain a SKILL.md file.');
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
      throw new Error(`Could not read SKILL.md from ${getBaseName(skillRoot)}.`);
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
    const queuedFolders = buildQueuedSkillFolders(selectedFiles);
    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      queuedFolders.forEach((folder) => nextMap.set(folder.id, folder));
      return [...nextMap.values()].slice(0, 20);
    });
  }, []);

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
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t('skills.installPath')}
          </div>
          <code className="mt-1 block whitespace-normal break-all text-xs text-foreground">{providerPath}</code>
        </div>
      )}

      <div
        {...getRootProps()}
        className={cn(
          'rounded-xl border border-dashed p-4 transition-colors sm:p-5',
          isDragActive
            ? 'border-foreground/40 bg-muted/35'
            : 'border-border/70 bg-muted/15 hover:border-foreground/25 hover:bg-muted/25',
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
          <FileUp className="h-7 w-7 text-muted-foreground" strokeWidth={1.5} />
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">{t('skills.dropZoneTitle')}</div>
            <div className="text-sm text-muted-foreground">{t('skills.dropZoneDescription')}</div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="w-full sm:w-auto"
            >
              <FileUp className="h-4 w-4" />
              {t('skills.chooseFiles')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => folderInputRef.current?.click()}
              className="w-full sm:w-auto"
            >
              <FolderUp className="h-4 w-4" />
              {t('skills.chooseFolder')}
            </Button>
          </div>
        </div>
      </div>

      {queuedFiles.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">{t('skills.queuedFiles')}</div>
          <div className="grid gap-2">
            {queuedFiles.map((queuedFile) => (
              <div
                key={queuedFile.id}
                className="flex flex-col gap-3 rounded-lg border border-border/70 bg-background/70 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{queuedFile.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {queuedFile.kind === 'folder'
                      ? `${queuedFile.files.length} files`
                      : 'Markdown file'}
                    {' · '}
                    {formatFileSize(queuedFile.size)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setQueuedFiles((previous) => previous.filter((file) => file.id !== queuedFile.id));
                  }}
                >
                  {t('skills.remove')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden">
      {/* Header row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/20 text-muted-foreground">
            <FileCode2 className="h-4 w-4" strokeWidth={1.7} />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-medium text-foreground">{t('tabs.skills')}</h3>
            <p className="text-sm text-muted-foreground">
              {canWrite
                ? t('skills.description', { provider: providerName })
                : t('skills.descriptionReadOnly', { provider: providerName })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canWrite && (
            <Button
              onClick={() => handleAddDialogOpenChange(true)}
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
            >
              <Plus className="h-4 w-4" />
              {t('skills.addSkill')}
            </Button>
          )}
          <Button
            onClick={() => void refreshSkills({ force: true })}
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            disabled={isLoading || isLoadingProjectScopes}
            aria-label={t('skills.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', (isLoading || isLoadingProjectScopes) && 'animate-spin')} />
            {t('skills.refresh')}
          </Button>
        </div>
      </div>

      {/* Add skill dialog */}
      {canWrite && (
        <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogOpenChange}>
          <DialogContent
            className="flex h-[calc(100vh-2rem)] max-h-[760px] w-[calc(100vw-2rem)] max-w-4xl flex-col overflow-hidden p-0 sm:h-[720px]"
          >
            <DialogTitle>{t('skills.addSkillTitle', { provider: providerName, defaultValue: `Add ${providerName} Skill` })}</DialogTitle>

            {/* Dialog header */}
            <div className="flex-shrink-0 border-b border-border/60 px-4 py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/20 text-muted-foreground">
                  <FileUp className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium text-foreground">
                    {t('skills.addSkillTitle', { provider: providerName, defaultValue: `Add ${providerName} Skill` })}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {t('skills.dropZoneDescription')}
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
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Dialog body */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {uploadPanel}
            </div>

            {/* Dialog footer */}
            <div className="flex flex-shrink-0 flex-col gap-3 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                {(submitError || loadError || (justInstalled && saveStatus === 'success')) ? (
                  <div className={cn(
                    'max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm',
                    submitError || loadError
                      ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                  )}>
                    {submitError || loadError || t('skills.saved')}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('skills.uploadHint')}</span>
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
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Upload className="h-4 w-4" />}
                  {queuedFiles.length > 1
                    ? t('skills.installCount_other', { count: queuedFiles.length, defaultValue: `Install ${queuedFiles.length} Skills` })
                    : t('skills.install')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Inline errors (outside dialog) */}
      {!isAddDialogOpen && (submitError || loadError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200" role="alert">
          {submitError || loadError}
        </div>
      )}

      {/* Delete error */}
      {deleteError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200" role="alert">
          {deleteError}
        </div>
      )}

      {/* Success banner (only when freshly installed and dialog closed) */}
      {justInstalled && saveStatus === 'success' && !isAddDialogOpen && (
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300" role="status">
          <CheckCircle2 className="h-4 w-4" />
          {t('skills.saved')}
        </div>
      )}

      {/* Skill list */}
      <div className="space-y-3">
        {/* List header: search + scanning indicator */}
        {(skills.length > 0 || isLoadingProjectScopes) && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t('skills.visibleSkills')}</div>
              <div className="text-xs text-muted-foreground">{t('skills.visibleSkillsDescription')}</div>
            </div>
            <div className="flex items-center gap-3">
              {isLoadingProjectScopes && (
                <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('skills.scanning')}
                </div>
              )}
              {skills.length > 0 && (
                <div className="relative w-full sm:w-64">
                  {/* RTL-safe icon: start-3 = inset-inline-start */}
                  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
                      className="absolute end-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoading && skills.length === 0 && (
          <div className="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="me-2 h-4 w-4 animate-spin" />
            {t('skills.loading', { provider: providerName })}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && skills.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-muted-foreground">
              <FileText className="h-6 w-6" />
            </div>
            <div className="mt-4 text-sm font-medium text-foreground">{t('skills.empty')}</div>
            <div className="mt-1 text-sm text-muted-foreground">{t('skills.emptyDescription')}</div>
          </div>
        )}

        {/* No search results */}
        {!isLoading && skills.length > 0 && filteredSkills.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
            <Search className="mx-auto h-6 w-6 text-muted-foreground" />
            <div className="mt-3 text-sm font-medium text-foreground">{t('skills.noMatch')}</div>
            <div className="mt-1 text-sm text-muted-foreground">{t('skills.noMatchDescription')}</div>
          </div>
        )}

        {/* Grouped skill cards */}
        {groupedSkills.map((group) => (
          <section key={group.scope} className="min-w-0 space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn('rounded-full px-2.5 py-1 text-xs', SCOPE_BADGE_CLASSES[group.scope])}>
                {scopeLabel(group.scope)}
              </Badge>
              <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                {group.skills.length}
              </span>
            </div>

            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              {group.skills.map((skill) => {
                const isConfirmingDelete = deletingSkillName === skill.name;
                const isDeletable = canWrite && skill.scope !== 'plugin' && skill.scope !== 'system';

                return (
                  <div
                    key={`${skill.command}:${skill.sourcePath}:${skill.projectPath || 'global'}`}
                    className="min-w-0 rounded-lg border border-border bg-card/50 p-4"
                  >
                    {/* Skill identity */}
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1">
                        <div className="break-all font-mono text-sm font-semibold text-foreground">{skill.command}</div>
                        <div className="text-sm text-muted-foreground">{skill.name}</div>
                      </div>

                      {/* Delete action — owner/admin only, user-scoped skills */}
                      {isDeletable && (
                        <div className="flex-shrink-0">
                          {isConfirmingDelete ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">
                                {t('skills.confirmDelete', { name: skill.name, defaultValue: `Delete «${skill.name}»?` })}
                              </span>
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => void handleDeleteSkill(skill)}
                                aria-label={t('skills.confirmYes')}
                              >
                                {t('skills.confirmYes')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => setDeletingSkillName(null)}
                                aria-label={t('skills.cancel')}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleDeleteSkill(skill)}
                              aria-label={t('skills.delete')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>

                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      {skill.description || 'No description provided in the skill front matter.'}
                    </p>

                    {/* Badges */}
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {skill.pluginName && (
                        <Badge variant="outline" className="rounded-full bg-background/70">
                          {t('skills.plugin')}: {skill.pluginName}
                        </Badge>
                      )}
                      {skill.projectDisplayName && (
                        <Badge variant="outline" className="rounded-full bg-background/70">
                          {t('skills.project')}: {skill.projectDisplayName}
                        </Badge>
                      )}
                    </div>

                    {/* Source path */}
                    <div className="mt-4 min-w-0 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        {t('skills.source')}
                      </div>
                      <code className="mt-1 block whitespace-normal break-all text-xs text-foreground">
                        {skill.sourcePath}
                      </code>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
