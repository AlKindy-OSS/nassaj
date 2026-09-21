import { Boxes, Edit3, Globe, Plus, Server, Terminal, Trash2, Users, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { McpProject, McpProvider, McpScope, ProviderMcpServer } from '../types';
import { IS_PLATFORM } from '../../../constants/config';
import { Button } from '../../../shared/view/ui';
import PremiumFeatureCard from '../../settings/view/PremiumFeatureCard';
import SettingsCard from '../../settings/view/SettingsCard';
import SettingsGroup from '../../settings/view/SettingsGroup';
import SettingsRow from '../../settings/view/SettingsRow';
import SettingsSection from '../../settings/view/SettingsSection';
import StatusBadge from '../../settings/view/StatusBadge';
import {
  MCP_GLOBAL_SUPPORTED_SCOPES,
  MCP_GLOBAL_SUPPORTED_TRANSPORTS,
  MCP_PROVIDER_NAMES,
  MCP_SUPPORTED_SCOPES,
} from '../constants';
import { useMcpServers } from '../hooks/useMcpServers';
import { maskSecret } from '../utils/mcpFormatting';

import McpServerFormModal from './modals/McpServerFormModal';

/**
 * لوح MCP — مُرحَّلٌ إلى لغة سطوح الإعدادات (‏T-1207/ب-416).
 *
 * كان هذا اللوح وتوأمه (المهارات) التبويبين الوحيدين اللذين لم تدخلهما v3، فكان
 * تبديلُ التبويب تبديلَ تطبيق: رأسٌ مبنيٌّ بيد بوزنٍ مخالف، وثمانيةُ `text-xs`،
 * وزرٌّ أساسي **يحمل لون علامة الوكيل** — بنفسجي لكلود ووردي لـKimi ورمادي
 * لـCodex. وهذا الأخير هو بعينه النمط الذي أُعدم في T-1172 على بطاقة الحساب،
 * وسببُ إعدامه يسري هنا حرفياً: لونُ الزرّ كان يقول «أيّ وكيل مفتوح» وهو ما
 * يقوله المنتقي المضيء فوقه أصلاً، فيُنفَق اللون على معلومة مكرّرة ويبقى
 * الزرّ خارج نظام النبرات. العلامة التجارية لا تُلوّن تحكّماً وظيفياً.
 */

type McpServersProps = {
  selectedProvider: McpProvider;
  currentProjects: McpProject[];
};

const getTransportIcon = (transport: string | undefined) => {
  if (transport === 'stdio') {
    return <Terminal className="h-4 w-4" aria-hidden="true" />;
  }

  if (transport === 'sse') {
    return <Zap className="h-4 w-4" aria-hidden="true" />;
  }

  if (transport === 'http') {
    return <Globe className="h-4 w-4" aria-hidden="true" />;
  }

  return <Server className="h-4 w-4" aria-hidden="true" />;
};

const getServerKey = (server: ProviderMcpServer): string => (
  `${server.provider}:${server.scope}:${server.workspacePath || 'global'}:${server.name}`
);

/**
 * قيمةٌ تقنية داخل وصف الصفّ: مسارٌ أو أمرٌ أو متغيّر بيئة. `dir="ltr"` وعزلٌ
 * ثنائي الاتجاه لأن الأساس العربي يقذف المحارف المحايدة في طرفها إلى الحافّة
 * المقابلة، و`font-mono` لأنها تُقرأ محرفاً محرفاً لا كلمةً كلمة.
 */
function ConfigLine({ label, children }: { label: string; children: string }) {
  if (!children) {
    return null;
  }

  // ‏`span.block` لا `div`: الوصف يُصيَّر داخل `<div>` وهو داخل لصيقة صفّ، وسطرٌ
  // كتليّ داخل نصّ يكفيه `display:block` بلا كسر تعشيش HTML.
  return (
    <span className="block min-w-0">
      {label}
      {': '}
      <code
        dir="ltr"
        style={{ unicodeBidi: 'isolate' }}
        className="break-all font-mono text-[13px] text-foreground"
      >
        {children}
      </code>
    </span>
  );
}

export default function McpServers({ selectedProvider, currentProjects }: McpServersProps) {
  const { t } = useTranslation('settings');
  const {
    servers,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    deleteError,
    saveStatus,
    isFormOpen,
    isGlobalFormOpen,
    editingServer,
    openForm,
    openGlobalForm,
    closeForm,
    closeGlobalForm,
    submitForm,
    submitGlobalForm,
    deleteServer,
  } = useMcpServers({ selectedProvider, currentProjects });

  const providerName = MCP_PROVIDER_NAMES[selectedProvider];
  const providerMcpEnabled = MCP_SUPPORTED_SCOPES[selectedProvider].length > 0;
  const description = t(`mcpServers.description.${selectedProvider}`, {
    defaultValue: `Model Context Protocol servers provide additional tools and data sources to ${providerName}`,
  });

  const scopeLabel = (scope: McpScope): string => t(`mcpServers.scope.${scope}`, {
    defaultValue: scope,
  });

  const globalRowLabel = t('mcpServers.addGlobal.label', { defaultValue: 'Global MCP server' });
  const globalRowDescription = t('mcpServers.addGlobal.description', {
    defaultValue: 'One common stdio or HTTP server, written only to providers compatible with the selected scope and transport.',
  });
  const globalActionLabel = t('mcpServers.addGlobal.action', { defaultValue: 'Add global server' });
  const globalModalTitle = t('mcpServers.addGlobal.modalTitle', { defaultValue: 'Add global MCP server' });
  const globalModalDescription = t('mcpServers.addGlobal.modalDescription', {
    defaultValue:
      'Adds this MCP server to compatible provider configs for the selected scope and transport. Only stdio and HTTP transports are supported.',
  });

  const providerRowLabel = t('mcpServers.addProvider.label', {
    provider: providerName,
    defaultValue: `${providerName} MCP server`,
  });
  const providerRowDescription = t('mcpServers.addProvider.description', {
    provider: providerName,
    defaultValue: `Changes ${providerName} only.`,
  });
  const providerActionLabel = t('mcpServers.addProvider.action', {
    provider: providerName,
    defaultValue: `Add ${providerName} server`,
  });

  const statusLine = saveStatus === 'success'
    ? t('saveStatus.success')
    : isLoadingProjectScopes
      ? t('mcpServers.refreshingScopes', { defaultValue: 'Refreshing project scopes…' })
      : null;

  return (
    <div className="min-w-0 space-y-8">
      <SettingsSection
        icon={Server}
        title={t('mcpServers.title')}
        description={description}
        // صفّان وسطرُ حالة — أكثر من صفّ، فالحدّ هو ما يقول أين يبدأ القسم
        // وأين ينتهي (‏SettingsSection §boxed).
        boxed
      >
        <SettingsGroup>
          <SettingsRow label={globalRowLabel} description={globalRowDescription}>
            <Button onClick={openGlobalForm} size="sm" aria-label={globalActionLabel}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {globalActionLabel}
            </Button>
          </SettingsRow>

          {providerMcpEnabled && (
            <SettingsRow label={providerRowLabel} description={providerRowDescription}>
              <Button
                onClick={() => openForm()}
                variant="outline"
                size="sm"
                aria-label={providerActionLabel}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {providerActionLabel}
              </Button>
            </SettingsRow>
          )}
        </SettingsGroup>

        {/* ارتفاعٌ محجوز فلا تقفز القائمة تحته حين تظهر رسالة الحفظ. */}
        <div className="min-h-5 pb-2">
          {statusLine && (
            <p className="animate-in fade-in text-[13px] leading-relaxed text-muted-foreground" role="status">
              {statusLine}
            </p>
          )}
        </div>
      </SettingsSection>

      {(loadError || deleteError) && (
        <SettingsCard tone="danger">
          <p className="text-[13px] leading-relaxed text-danger" role="alert">
            {deleteError || loadError}
          </p>
        </SettingsCard>
      )}

      <SettingsSection
        icon={Boxes}
        title={t('mcpServers.list.title', { defaultValue: 'Configured servers' })}
        boxed={servers.length > 0}
      >
        {isLoading && servers.length === 0 && (
          <p className="py-6 text-[13px] leading-relaxed text-muted-foreground">
            {t('mcpServers.loading', { defaultValue: 'Loading MCP servers…' })}
          </p>
        )}

        {servers.length > 0 && (
          <SettingsGroup>
            {servers.map((server) => (
              <SettingsRow
                key={getServerKey(server)}
                label={(
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    {getTransportIcon(server.transport)}
                    <span
                      dir="ltr"
                      style={{ unicodeBidi: 'isolate' }}
                      className="min-w-0 break-all font-mono"
                    >
                      {server.name}
                    </span>
                    <StatusBadge>{server.transport || 'stdio'}</StatusBadge>
                    <StatusBadge>{scopeLabel(server.scope)}</StatusBadge>
                    {server.projectDisplayName && (
                      <StatusBadge className="max-w-full truncate">
                        {server.projectDisplayName}
                      </StatusBadge>
                    )}
                  </span>
                )}
                description={(
                  <span className="block space-y-1">
                    <ConfigLine label={t('mcpServers.config.command')}>{server.command || ''}</ConfigLine>
                    <ConfigLine label={t('mcpServers.config.url')}>{server.url || ''}</ConfigLine>
                    <ConfigLine label={t('mcpServers.config.args')}>{(server.args || []).join(' ')}</ConfigLine>
                    <ConfigLine label={t('mcpServers.config.cwd', { defaultValue: 'Working directory' })}>
                      {server.cwd || ''}
                    </ConfigLine>
                    {server.env && Object.keys(server.env).length > 0 && (
                      <ConfigLine label={t('mcpServers.config.environment')}>
                        {Object.entries(server.env).map(([key, value]) => `${key}=${maskSecret(value)}`).join(', ')}
                      </ConfigLine>
                    )}
                    {server.envVars && server.envVars.length > 0 && (
                      <ConfigLine label={t('mcpServers.config.envVars', { defaultValue: 'Environment variables' })}>
                        {server.envVars.join(', ')}
                      </ConfigLine>
                    )}
                  </span>
                )}
              >
                <span className="flex items-center gap-1">
                  <Button
                    onClick={() => openForm(server)}
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    aria-label={`${t('mcpServers.actions.edit')}: ${server.name}`}
                    title={t('mcpServers.actions.edit')}
                  >
                    <Edit3 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    onClick={() => deleteServer(server)}
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-danger"
                    aria-label={`${t('mcpServers.actions.delete')}: ${server.name}`}
                    title={t('mcpServers.actions.delete')}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </span>
              </SettingsRow>
            ))}
          </SettingsGroup>
        )}

        {!isLoading && !isLoadingProjectScopes && servers.length === 0 && (
          <p className="py-6 text-[13px] leading-relaxed text-muted-foreground">
            {t('mcpServers.empty')}
          </p>
        )}
      </SettingsSection>

      {/* ‏«حول Codex MCP» كان صندوقاً عنوانُه وحده: مفتاح وصفه أُفرِغ عمداً لأن
          نصّه كان حشواً، فبقي إطارٌ حول لا شيء. حُذفت الكتلة كاملة. */}

      {selectedProvider === 'claude' && !IS_PLATFORM && (
        <PremiumFeatureCard
          icon={<Users className="h-5 w-5" aria-hidden="true" />}
          title={t('mcpServers.teamConfigs.title', { defaultValue: 'Team MCP configs' })}
          description={t('mcpServers.teamConfigs.description', {
            defaultValue: 'Share MCP server configurations across your team. Everyone stays in sync automatically.',
          })}
        />
      )}

      <McpServerFormModal
        provider={selectedProvider}
        isOpen={isFormOpen}
        editingServer={editingServer}
        currentProjects={currentProjects}
        title={editingServer ? undefined : providerActionLabel}
        submitLabel={providerActionLabel}
        onClose={closeForm}
        onSubmit={submitForm}
      />

      <McpServerFormModal
        provider={selectedProvider}
        mode="global"
        isOpen={isGlobalFormOpen}
        editingServer={null}
        currentProjects={currentProjects}
        title={globalModalTitle}
        description={globalModalDescription}
        submitLabel={globalActionLabel}
        supportedScopes={MCP_GLOBAL_SUPPORTED_SCOPES}
        supportedTransports={MCP_GLOBAL_SUPPORTED_TRANSPORTS}
        onClose={closeGlobalForm}
        onSubmit={(formData) => submitGlobalForm(formData)}
      />
    </div>
  );
}
