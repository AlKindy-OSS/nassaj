import { FolderOpen, Globe, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import { Button, Input } from '../../../../shared/view/ui';
import SegmentedControl from '../../../settings/view/SegmentedControl';
import SettingsCard from '../../../settings/view/SettingsCard';
import {
  globalManualTargets,
  MCP_PROVIDER_NAMES,
  MCP_SUPPORTED_SCOPES,
  MCP_SUPPORTED_TRANSPORTS,
  MCP_SUPPORTS_WORKING_DIRECTORY,
} from '../../constants';
import { useMcpServerForm } from '../../hooks/useMcpServerForm';
import type {
  McpFormMode,
  McpFormState,
  McpProject,
  McpProvider,
  McpScope,
  McpTransport,
  ProviderMcpServer,
} from '../../types';

/**
 * نموذج خادم MCP — مُرحَّلٌ إلى لغة السطوح (‏T-1207/ب-416).
 *
 * كان هذا الملف أكثف بؤرة لون خام في النطاق كلّه: خمسة وثمانون مطابقةً لدرجات
 * Tailwind (‏gray/blue/red) واثنتان وثلاثون `dark:` variant — أي أن كل نبرة هنا
 * كانت تُكتب مرّتين، مرّةً للفاتح ومرّةً للداكن، بينما الرمز (`--danger`,
 * `--input`, `--background`) يتبدّل بالوضع من تلقائه فلا يحتاج variant أصلاً.
 * والحارس `src/lib/themeStatusContrast.test.ts` يقيس الرموز على كل بريست ووضع
 * وسطح؛ ولا يقيس درجةً خامّة مكتوبة هنا.
 *
 * ومنتقيا «نمط الإدخال» و«النطاق» كانا زرّين مصبوغين بـ`bg-blue-600` — تحكّمٌ
 * مجزّأ منفَّذ بيد؛ صارا `SegmentedControl` وهو البدائية الموضوعة لهما.
 */

type McpServerFormModalProps = {
  provider: McpProvider;
  mode?: McpFormMode;
  isOpen: boolean;
  editingServer: ProviderMcpServer | null;
  currentProjects: McpProject[];
  title?: string;
  description?: string;
  submitLabel?: string;
  supportedScopes?: McpScope[];
  supportedTransports?: McpTransport[];
  onClose: () => void;
  onSubmit: (formData: McpFormState, editingServer: ProviderMcpServer | null) => Promise<void>;
};

/** لصيقة حقل — درجةُ «لصيقة صفّ» من السلّم الخماسي (§3). */
const LABEL_CLASS = 'mb-2 block text-[15px] font-medium leading-relaxed text-foreground';

/** نصّ مساعد — أدنى درجات السلّم، و`text-xs` دونها ممنوع. */
const HELP_CLASS = 'mt-2 text-[13px] leading-relaxed text-muted-foreground';

/**
 * ‏`select` و`textarea` ليس لهما بدائية مشتركة، فيأخذان أصناف `Input` نفسها
 * حرفاً بحرف: `border-input` وحلقة تركيز بسمك 2 من `--ring` وحده (§2.7). أي
 * انحرافٍ هنا يُنتج حقلين بمظهرين في نموذج واحد.
 */
const FIELD_CLASS = 'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm '
  + 'transition-colors placeholder:text-muted-foreground focus-visible:outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export default function McpServerFormModal({
  provider,
  mode = 'provider',
  isOpen,
  editingServer,
  currentProjects,
  title,
  description,
  submitLabel,
  supportedScopes,
  supportedTransports,
  onClose,
  onSubmit,
}: McpServerFormModalProps) {
  const { t } = useTranslation('settings');
  const isGlobalMode = mode === 'global';
  const availableScopes = supportedScopes ?? MCP_SUPPORTED_SCOPES[provider];
  const availableTransports = supportedTransports ?? MCP_SUPPORTED_TRANSPORTS[provider];

  const scopeLabel = (scope: McpScope): string => {
    if (scope === 'user') {
      return isGlobalMode
        ? t('mcpForm.scope.option.userAll', { defaultValue: 'User (compatible providers)' })
        : t('mcpForm.scope.option.user', { defaultValue: 'User (global)' });
    }

    if (scope === 'local') {
      return t('mcpForm.scope.option.local', { defaultValue: 'Claude local' });
    }

    return isGlobalMode
      ? t('mcpForm.scope.option.projectAll', { defaultValue: 'Project (compatible providers)' })
      : t('mcpForm.scope.option.project', { defaultValue: 'Project' });
  };

  const scopeHint = (scope: McpScope): string => {
    const compatibleProviders = globalManualTargets(scope, formData.transport)
      .map((target) => MCP_PROVIDER_NAMES[target])
      .join(', ');

    if (scope === 'user') {
      return isGlobalMode
        ? t('mcpForm.scope.hint.userAll', {
          providers: compatibleProviders,
          defaultValue: 'Writes only to compatible provider user configs ({{providers}}) and is available across projects on this machine.',
        })
        : t('mcpForm.scope.hint.user', {
          defaultValue: 'Available across all projects on your machine.',
        });
    }

    if (scope === 'local') {
      return t('mcpForm.scope.hint.local', {
        defaultValue: 'Stored in Claude user settings for the selected project.',
      });
    }

    return isGlobalMode
      ? t('mcpForm.scope.hint.projectAll', {
        providers: compatibleProviders,
        defaultValue: 'Writes only to compatible provider configs in the selected project workspace: {{providers}}.',
      })
      : t('mcpForm.scope.hint.project', {
        defaultValue: 'Stored in the selected project workspace.',
      });
  };

  const {
    formData,
    multilineText,
    projectOptions,
    isEditing,
    isSubmitting,
    jsonValidationError,
    canSubmit,
    updateForm,
    updateScope,
    updateTransport,
    updateJsonInput,
    updateMultilineText,
    handleSubmit,
  } = useMcpServerForm({
    provider,
    isOpen,
    editingServer,
    currentProjects,
    supportedScopes: availableScopes,
    supportedTransports: availableTransports,
    unsupportedTransportMessage: isGlobalMode
      ? (transport) => t('mcpForm.validation.unsupportedTransport', {
        transport,
        defaultValue: `A global MCP server supports only stdio and http for compatible providers, not ${transport}.`,
      })
      : undefined,
    onSubmit,
  });

  if (!isOpen) {
    return null;
  }

  const providerName = MCP_PROVIDER_NAMES[provider];
  const modalTitle = title ?? (isEditing ? t('mcpForm.title.edit') : t('mcpForm.title.add'));
  const addButtonLabel = submitLabel ?? t('mcpForm.actions.addTo', {
    provider: providerName,
    defaultValue: `Add server to ${providerName}`,
  });
  const showProjectSelector = formData.scope !== 'user';
  const supportsHttpHeaders = formData.transport === 'http' || formData.transport === 'sse';
  const supportsWorkingDirectory = !isGlobalMode && MCP_SUPPORTS_WORKING_DIRECTORY[provider];
  const showCodexOnlyFields = provider === 'codex' && !isGlobalMode;

  return (
    // غطاء المودال سطحٌ خارج «منطقة المحتوى» بنصّ §0 — كصدفة `Settings.tsx`.
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-semibold leading-snug text-foreground">{modalTitle}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('mcpForm.actions.cancel')}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-4">
          {description && (
            <SettingsCard tone="info">
              <p className="text-[13px] leading-relaxed text-primary">{description}</p>
            </SettingsCard>
          )}

          {!isEditing && (
            <SegmentedControl
              label={t('mcpForm.importMode.label', { defaultValue: 'Input mode' })}
              value={formData.importMode}
              onChange={(value) => updateForm('importMode', value)}
              options={[
                { value: 'form' as const, label: t('mcpForm.importMode.form') },
                { value: 'json' as const, label: t('mcpForm.importMode.json') },
              ]}
            />
          )}

          {isEditing && (
            <div>
              <span className={LABEL_CLASS}>{t('mcpForm.scope.label')}</span>
              <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                {formData.scope === 'user'
                  ? <Globe className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  : <FolderOpen className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
                <span>{scopeLabel(formData.scope)}</span>
                {formData.workspacePath && (
                  <code
                    dir="ltr"
                    style={{ unicodeBidi: 'isolate' }}
                    className="min-w-0 break-all font-mono text-[13px] text-muted-foreground"
                  >
                    {formData.workspacePath}
                  </code>
                )}
              </div>
              <p className={HELP_CLASS}>{t('mcpForm.scope.cannotChange')}</p>
            </div>
          )}

          {!isEditing && (
            <div className="space-y-4">
              <div>
                <span className={LABEL_CLASS}>{`${t('mcpForm.scope.label')} *`}</span>
                <SegmentedControl
                  label={t('mcpForm.scope.label')}
                  value={formData.scope}
                  onChange={(value) => updateScope(value)}
                  options={availableScopes.map((scope) => ({ value: scope, label: scopeLabel(scope) }))}
                  className="flex-wrap"
                />
                <p className={HELP_CLASS}>{scopeHint(formData.scope)}</p>
              </div>

              {showProjectSelector && (
                <div>
                  <label className={LABEL_CLASS} htmlFor="mcp-form-project">
                    {`${t('mcpForm.fields.selectProject')} *`}
                  </label>
                  <select
                    id="mcp-form-project"
                    value={formData.workspacePath}
                    onChange={(event) => updateForm('workspacePath', event.target.value)}
                    className={cn(FIELD_CLASS, 'h-10')}
                    required
                  >
                    <option value="">{t('mcpForm.fields.selectProject')}</option>
                    {projectOptions.map((project) => (
                      <option key={project.value} value={project.value}>
                        {project.label}
                      </option>
                    ))}
                  </select>
                  {formData.workspacePath && (
                    <p
                      dir="ltr"
                      style={{ unicodeBidi: 'isolate' }}
                      className="mt-1 truncate font-mono text-[13px] text-muted-foreground"
                    >
                      {formData.workspacePath}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className={formData.importMode === 'json' ? 'md:col-span-2' : ''}>
              <label className={LABEL_CLASS} htmlFor="mcp-form-name">
                {`${t('mcpForm.fields.serverName')} *`}
              </label>
              <Input
                id="mcp-form-name"
                value={formData.name}
                onChange={(event) => updateForm('name', event.target.value)}
                placeholder={t('mcpForm.placeholders.serverName')}
                required
              />
            </div>

            {formData.importMode === 'form' && (
              <div>
                <label className={LABEL_CLASS} htmlFor="mcp-form-transport">
                  {`${t('mcpForm.fields.transportType')} *`}
                </label>
                <select
                  id="mcp-form-transport"
                  value={formData.transport}
                  onChange={(event) => updateTransport(event.target.value as McpFormState['transport'])}
                  className={cn(FIELD_CLASS, 'h-10')}
                >
                  {availableTransports.map((transport) => (
                    <option key={transport} value={transport}>
                      {transport === 'sse' ? 'SSE' : transport.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {formData.importMode === 'json' && (
            <div>
              <label className={LABEL_CLASS} htmlFor="mcp-form-json">
                {`${t('mcpForm.fields.jsonConfig')} *`}
              </label>
              <textarea
                id="mcp-form-json"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                value={formData.jsonInput}
                onChange={(event) => updateJsonInput(event.target.value)}
                className={cn(
                  FIELD_CLASS,
                  'font-mono placeholder:font-sans',
                  jsonValidationError && 'border-danger',
                )}
                rows={8}
                placeholder={'{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["@upstash/context7-mcp"]\n}'}
                required
              />
              {jsonValidationError && (
                <p className="mt-1 text-[13px] leading-relaxed text-danger" role="alert">
                  {jsonValidationError}
                </p>
              )}
              <p className={HELP_CLASS}>
                {t('mcpForm.validation.jsonHelp')}
                <br />
                <code dir="ltr" style={{ unicodeBidi: 'isolate' }} className="break-all font-mono">
                  {'stdio: {"type":"stdio","command":"npx","args":["@upstash/context7-mcp"]}'}
                </code>
                <br />
                <code dir="ltr" style={{ unicodeBidi: 'isolate' }} className="break-all font-mono">
                  {'http/sse: {"type":"http","url":"https://api.example.com/mcp"}'}
                </code>
              </p>
            </div>
          )}

          {formData.importMode === 'form' && formData.transport === 'stdio' && (
            <div className="space-y-4">
              <div>
                <label className={LABEL_CLASS} htmlFor="mcp-form-command">
                  {`${t('mcpForm.fields.command')} *`}
                </label>
                <Input
                  id="mcp-form-command"
                  dir="ltr"
                  style={{ unicodeBidi: 'isolate' }}
                  className="font-mono placeholder:font-sans"
                  value={formData.command}
                  onChange={(event) => updateForm('command', event.target.value)}
                  placeholder="npx @my-org/mcp-server"
                  required
                />
              </div>

              <div>
                <label className={LABEL_CLASS} htmlFor="mcp-form-args">
                  {t('mcpForm.fields.arguments')}
                </label>
                <textarea
                  id="mcp-form-args"
                  dir="ltr"
                  style={{ unicodeBidi: 'isolate' }}
                  value={multilineText.args}
                  onChange={(event) => updateMultilineText('args', event.target.value)}
                  className={cn(FIELD_CLASS, 'font-mono placeholder:font-sans')}
                  rows={3}
                  placeholder="--port&#10;3000"
                />
              </div>

              {supportsWorkingDirectory && (
                <div>
                  <label className={LABEL_CLASS} htmlFor="mcp-form-cwd">
                    {t('mcpForm.fields.workingDirectory', { defaultValue: 'Working directory' })}
                  </label>
                  <Input
                    id="mcp-form-cwd"
                    dir="ltr"
                    style={{ unicodeBidi: 'isolate' }}
                    className="font-mono placeholder:font-sans"
                    value={formData.cwd}
                    onChange={(event) => updateForm('cwd', event.target.value)}
                    placeholder="."
                  />
                </div>
              )}
            </div>
          )}

          {formData.importMode === 'form' && formData.transport !== 'stdio' && (
            <div>
              <label className={LABEL_CLASS} htmlFor="mcp-form-url">
                {`${t('mcpForm.fields.url')} *`}
              </label>
              <Input
                id="mcp-form-url"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                className="font-mono placeholder:font-sans"
                value={formData.url}
                onChange={(event) => updateForm('url', event.target.value)}
                placeholder="https://api.example.com/mcp"
                type="url"
                required
              />
            </div>
          )}

          {formData.importMode === 'form' && (
            <div>
              <label className={LABEL_CLASS} htmlFor="mcp-form-env">
                {t('mcpForm.fields.envVars')}
              </label>
              <textarea
                id="mcp-form-env"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                value={multilineText.env}
                onChange={(event) => updateMultilineText('env', event.target.value)}
                className={cn(FIELD_CLASS, 'font-mono placeholder:font-sans')}
                rows={3}
                placeholder="API_KEY=your-key&#10;DEBUG=true"
              />
            </div>
          )}

          {formData.importMode === 'form' && supportsHttpHeaders && (
            <div>
              <label className={LABEL_CLASS} htmlFor="mcp-form-headers">
                {t('mcpForm.fields.headers')}
              </label>
              <textarea
                id="mcp-form-headers"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                value={multilineText.headers}
                onChange={(event) => updateMultilineText('headers', event.target.value)}
                className={cn(FIELD_CLASS, 'font-mono placeholder:font-sans')}
                rows={3}
                placeholder="Authorization=Bearer token&#10;X-API-Key=your-key"
              />
            </div>
          )}

          {showCodexOnlyFields && formData.importMode === 'form' && formData.transport === 'stdio' && (
            <div>
              <label className={LABEL_CLASS} htmlFor="mcp-form-env-names">
                {t('mcpForm.fields.envVarNames', { defaultValue: 'Environment variable names' })}
              </label>
              <textarea
                id="mcp-form-env-names"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                value={multilineText.envVars}
                onChange={(event) => updateMultilineText('envVars', event.target.value)}
                className={cn(FIELD_CLASS, 'font-mono placeholder:font-sans')}
                rows={3}
                placeholder="GITHUB_TOKEN&#10;API_KEY"
              />
            </div>
          )}

          {showCodexOnlyFields && formData.importMode === 'form' && formData.transport === 'http' && (
            <div>
              <label className={LABEL_CLASS} htmlFor="mcp-form-bearer">
                {t('mcpForm.fields.bearerTokenEnvVar', { defaultValue: 'Bearer token environment variable' })}
              </label>
              <Input
                id="mcp-form-bearer"
                dir="ltr"
                style={{ unicodeBidi: 'isolate' }}
                className="font-mono placeholder:font-sans"
                value={formData.bearerTokenEnvVar}
                onChange={(event) => updateForm('bearerTokenEnvVar', event.target.value)}
                placeholder="MCP_TOKEN"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('mcpForm.actions.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting || !canSubmit}>
              {isSubmitting
                ? t('mcpForm.actions.saving')
                : isEditing
                  ? t('mcpForm.actions.updateServer')
                  : addButtonLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
