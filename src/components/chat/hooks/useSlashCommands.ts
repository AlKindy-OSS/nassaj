import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';
import { getProviderCapabilities } from '../constants/providerCapabilities';
import { safeLocalStorage } from '../utils/chatStorage';
import { createCommandViewModel, type CommandViewModel } from '../utils/commandLocalization';
import type { LLMProvider, Project, ProjectSession } from '../../../types/app';

const COMMAND_QUERY_DEBOUNCE_MS = 150;

export interface SlashCommand {
  name: string;
  description?: string;
  /** Presentation-only localization. `name` always remains the canonical command. */
  view?: CommandViewModel;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface UseSlashCommandsOptions {
  selectedProject: Project | null;
  /**
   * T-881: الجلسة المفتوحة حالياً. مزوّدها (__provider) يُحدِّد بوابة إظهار مدخلة
   * «/btw» بنفس أسبقية handleSubmit في useChatComposerState: __provider ?? provider.
   * اختياري للتوافق مع مواقع استدعاء قائمة (لا selectedSession بعد).
   */
  selectedSession?: ProjectSession | null;
  provider: LLMProvider;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onExecuteCommand: (command: SlashCommand, rawInput?: string) => void | Promise<void>;
  /**
   * T-1704: يُستدعى عند اختيار أمر تمريري فوري (مثل `/compact` في Claude) من
   * القائمة؛ يُرسله المستدعي خاماً إلى المحرّك كأنه كُتب ثم ضُغط Enter، بدل
   * إدراجه نصّاً وانتظار الإرسال اليدوي. اختياري: غيابه يُبقي سلوك الإدراج.
   */
  onDispatchPassthroughCommand?: (command: SlashCommand, remainingInput: string) => void;
  /** True while another execute-style command owns the HTTP execution lock. */
  isExecutableCommandRunning?: boolean;
}

type ProviderSkill = {
  disableModelInvocation?: boolean;
  name: string;
  description?: string;
  command: string;
  scope: string;
  sourcePath?: string;
  pluginName?: string;
  pluginId?: string;
};

type ProviderSkillsResponse = {
  success?: boolean;
  data?: {
    skills?: ProviderSkill[];
  };
};

const getCommandHistoryKey = (projectName: string) => `command_history_${projectName}`;

const readCommandHistory = (projectName: string): Record<string, number> => {
  const history = safeLocalStorage.getItem(getCommandHistoryKey(projectName));
  if (!history) {
    return {};
  }

  try {
    return JSON.parse(history);
  } catch (error) {
    console.error('Error parsing command history:', error);
    return {};
  }
};

const saveCommandHistory = (projectName: string, history: Record<string, number>) => {
  safeLocalStorage.setItem(getCommandHistoryKey(projectName), JSON.stringify(history));
};

const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  Boolean(value) && typeof (value as Promise<unknown>).then === 'function';

const isSkillCommand = (command: SlashCommand) =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// Built-in Claude Code commands that have no dedicated UI handler. They must be
// forwarded raw to the CLI dispatch path (not /api/commands/execute). In the
// menu they behave like skills: selecting them inserts the command into the
// input so the user can append arguments (e.g. `/review 123`) and press Enter.
export const isPassthroughBuiltInCommand = (command: SlashCommand) =>
  (command.type === 'built-in' || command.namespace === 'builtin') &&
  command.metadata?.hasHandler === false;

// T-1704: passthrough built-ins that take no arguments and whose whole value is
// "run it now". Selecting one from the menu dispatches the raw command at once
// instead of inserting `/name ` and waiting for Enter.
const IMMEDIATE_PASSTHROUGH_COMMANDS = new Set(['/compact']);

export const isImmediatePassthroughCommand = (command: SlashCommand): boolean =>
  isPassthroughBuiltInCommand(command) &&
  IMMEDIATE_PASSTHROUGH_COMMANDS.has(command.name) &&
  !commandExpectsArguments(command);

/**
 * Codex built-ins advertised by the server are web actions, never ordinary
 * prompts. The server remains the source of truth for which commands exist;
 * this guard only classifies an already-discovered command.
 */
export const isProviderHandledBuiltInCommand = (
  provider: LLMProvider,
  command: SlashCommand,
): boolean =>
  provider === 'codex' &&
  (command.type === 'built-in' || command.namespace === 'builtin');

export const commandExpectsArguments = (command: SlashCommand): boolean =>
  typeof command.metadata?.argumentHint === 'string' &&
  command.metadata.argumentHint.trim().length > 0;

const CODEX_FALLBACK_COMMANDS = new Set([
  '/help',
  '/models',
  '/model',
  '/cost',
  '/status',
  '/compact',
  '/usage',
  '/mcp',
  '/skills',
  '/hooks',
  '/apps',
  '/rename',
  '/goal',
]);

// These commands use the authorized Codex thread as their execution scope.
// Do not offer them while composing a brand-new conversation.
const CODEX_SESSION_COMMANDS = new Set([
  '/compact',
  '/usage',
  '/mcp',
  '/skills',
  '/hooks',
  '/apps',
  '/rename',
  '/goal',
]);

/**
 * Native commands declared by the current server batch remain fail-closed even
 * while discovery is loading or unavailable. This is deliberately not a full
 * Codex command catalog: newly discovered commands still come from `/list`.
 */
export const resolveProviderCommandFallback = (
  provider: LLMProvider,
  commandName: string,
): SlashCommand | undefined => {
  if (provider !== 'codex' || !CODEX_FALLBACK_COMMANDS.has(commandName)) return undefined;
  return {
    name: commandName,
    description: commandName === '/compact'
      ? 'Compact the current Codex context'
      : 'Run this Codex command',
    namespace: 'builtin',
    type: 'built-in',
    metadata: { type: 'builtin', hasHandler: true },
  };
};

// OC-19ب: opencode's native commands (namespace:'opencode') must be forwarded
// raw to the engine — not sent to /api/commands/execute (which 403s paths outside
// .claude/commands) and not expanded by the Claude CLI. Selecting one inserts
// "/name" into the input so the user can append args before dispatching, exactly
// like skills and passthrough built-ins.
export const isOpenCodePassthroughCommand = (command: SlashCommand) =>
  command.namespace === 'opencode';

// T-881: مدخلة «/btw» العميلية المحضة — تُحقن في القائمة عند مزوّدات بقناة جانبية.
// عند الاختيار تُدرج «/btw » (بمسافة لاحقة) فيكتب المستخدم
// سؤاله ثم يرسل؛ لا تُوجَّه لا إلى /api/commands/execute ولا خاماً إلى CLI.
// المحدّد: namespace:'nassaj' + type:'btw' — لا يُصادفه أيٌّ من حراس التوجيه
// الخادمية (isPassthroughBuiltInCommand / isOpenCodePassthroughCommand).
export const isBtwSlashEntry = (command: SlashCommand): boolean =>
  command.type === 'btw' && command.namespace === 'nassaj';

export type SlashCommandSelectionMode = 'insert' | 'execute';

/**
 * Single classification source for menu selection. Insert-style entries only
 * complete the textarea; execute-style entries invoke the commands endpoint.
 */
export const getSlashCommandSelectionMode = (
  provider: LLMProvider,
  command: SlashCommand,
): SlashCommandSelectionMode => (
  isSkillCommand(command) ||
  commandExpectsArguments(command) ||
  (isPassthroughBuiltInCommand(command) &&
    !isProviderHandledBuiltInCommand(provider, command)) ||
  isOpenCodePassthroughCommand(command) ||
  isBtwSlashEntry(command)
    ? 'insert'
    : 'execute'
);

const dedupeProviderSkills = (skills: ProviderSkill[]): ProviderSkill[] => {
  const seenCommands = new Set<string>();

  return skills.filter((skill) => {
    // Multiple physical Claude plugin folders can expose the same invocation.
    // The slash menu should show each executable command only once.
    const key = skill.command;
    if (seenCommands.has(key)) {
      return false;
    }

    seenCommands.add(key);
    return true;
  });
};

const mapSkillToSlashCommand = (skill: ProviderSkill): SlashCommand => ({
  name: skill.command,
  description: skill.description,
  namespace: 'skill',
  path: skill.sourcePath,
  type: 'skill',
  metadata: {
    type: skill.scope,
    scope: skill.scope,
    sourcePath: skill.sourcePath,
    pluginName: skill.pluginName,
    pluginId: skill.pluginId,
    skillName: skill.name,
    disableModelInvocation: skill.disableModelInvocation === true,
  },
});

export const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): SlashCommand[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  const commandPrefix = normalizedQuery.startsWith('/')
    ? normalizedQuery
    : `/${normalizedQuery}`;
  const namePrefixMatches = commands.filter((command) =>
    [command.name, ...(command.view?.aliases ?? [])].some((term) =>
      term.toLocaleLowerCase().startsWith(commandPrefix),
    ),
  );

  // Namespaced commands should behave like path completion. Once a provider
  // namespace is typed, only exact command-prefix matches should stay visible.
  if (normalizedQuery.includes(':') || namePrefixMatches.length > 0) {
    return namePrefixMatches;
  }

  const nameSubstringMatches = commands.filter((command) =>
    command.view?.searchTerms?.some((term) => term.includes(normalizedQuery)) ??
    command.name.toLowerCase().includes(normalizedQuery),
  );
  if (nameSubstringMatches.length > 0) {
    return nameSubstringMatches;
  }

  return commands.filter((command) =>
    command.view?.searchTerms?.some((term) => term.includes(normalizedQuery)) ??
    command.description?.toLowerCase().includes(normalizedQuery),
  );
};

export function useSlashCommands({
  selectedProject,
  selectedSession,
  provider,
  input,
  setInput,
  textareaRef,
  onExecuteCommand,
  onDispatchPassthroughCommand,
  isExecutableCommandRunning = false,
}: UseSlashCommandsOptions) {
  const { t, i18n } = useTranslation('chat');

  // الأوامر المجلوبة من الخادم — قبل حقن مدخلات عميلية.
  const [fetchedCommands, setFetchedCommands] = useState<SlashCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);

  // T-881: بوابة «/btw» — مزوّد الجلسة المفتوحة يُقدَّم على المزوّد العام
  // (نفس أسبقية handleSubmit في useChatComposerState:1004).
  const sideChannelProvider: string = selectedSession?.__provider ?? provider;

  const btwEntry = useMemo<SlashCommand>(
    () => ({
      name: '/btw',
      description: t('btw.description'),
      namespace: 'nassaj',
      type: 'btw',
    }),
    [t],
  );
  const sideEntry = useMemo<SlashCommand>(
    () => ({
      name: '/side',
      description: t('btw.sideDescription', {
        defaultValue: 'Ask a side question on the current Codex thread',
      }),
      namespace: 'nassaj',
      type: 'btw',
    }),
    [t],
  );

  // قائمة الأوامر النهائية: الخادمية + مدخلة «/btw» حين يدعمها المزوّد.
  // /btw يسأل سياق thread قائم، لذلك لا نعرض وعداً لا يمكن تنفيذه في محادثة جديدة.
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const visibleCommands = provider === 'codex' && !selectedSession?.id
      ? fetchedCommands.filter((command) => !CODEX_SESSION_COMMANDS.has(command.name))
      : fetchedCommands;
    const rawCommands = (
      !selectedSession?.id ||
      !getProviderCapabilities(sideChannelProvider).sideChannel.supported
    )
      ? visibleCommands
      // `/side` is Codex's native alias. Claude keeps its established `/btw`
      // surface only, even though both entries share the same side-channel route.
      : sideChannelProvider === 'codex'
        ? [sideEntry, ...visibleCommands]
        : [btwEntry, ...visibleCommands];
    return rawCommands.map((command) => ({
      ...command,
      view: createCommandViewModel(command.name, command.description, sideChannelProvider as LLMProvider, i18n?.language, command.type),
    }));
  }, [
    fetchedCommands,
    provider,
    selectedSession?.id,
    sideChannelProvider,
    btwEntry,
    sideEntry,
    i18n?.language,
  ]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [slashPosition, setSlashPosition] = useState(-1);

  const commandQueryTimerRef = useRef<number | null>(null);

  const clearCommandQueryTimer = useCallback(() => {
    if (commandQueryTimerRef.current !== null) {
      window.clearTimeout(commandQueryTimerRef.current);
      commandQueryTimerRef.current = null;
    }
  }, []);

  const resetCommandMenuState = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery('');
    setSelectedCommandIndex(-1);
    clearCommandQueryTimer();
  }, [clearCommandQueryTimer]);

  useEffect(() => {
    let cancelled = false;

    const fetchCommands = async () => {
      if (!selectedProject) {
        setFetchedCommands([]);
        setFilteredCommands([]);
        return;
      }

      // Never keep commands from the previous harness visible while the new
      // provider-specific registry is loading. A stale Claude `/compact`, for
      // example, must not be selectable inside a Codex session.
      setFetchedCommands([]);
      setFilteredCommands([]);

      try {
        const workspacePath = selectedProject.fullPath || selectedProject.path || '';
        const skillsParams = new URLSearchParams();
        if (workspacePath) {
          skillsParams.set('workspacePath', workspacePath);
        }

        const [response, skillsResponse] = await Promise.all([
          authenticatedFetch('/api/commands/list', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              projectPath: workspacePath || selectedProject.path,
              provider,
            }),
          }),
          authenticatedFetch(
            `/api/providers/${encodeURIComponent(provider)}/skills${skillsParams.toString() ? `?${skillsParams.toString()}` : ''}`,
          ).catch(() => null as unknown as Response),
        ]);

        if (!response.ok) {
          throw new Error('Failed to fetch commands');
        }

        const data = await response.json();
        const skillsData =
          skillsResponse !== null && skillsResponse.ok
            ? ((await skillsResponse.json()) as ProviderSkillsResponse)
            : null;
        const skillCommands = dedupeProviderSkills(skillsData?.data?.skills || [])
          .map(mapSkillToSlashCommand);
        // The CLI's dynamic built-in list (server /list probe) echoes the user's
        // skills under their slash names. The skills endpoint already provides
        // those with richer metadata (scope, sourcePath, plugin info), so any
        // built-in whose name collides with a skill command is dropped here to
        // keep each invocation listed once.
        const skillCommandNames = new Set(
          skillCommands.map((command) => command.name.toLowerCase()),
        );
        const allCommands: SlashCommand[] = [
          ...((data.builtIn || []) as SlashCommand[])
            .filter((command) => !skillCommandNames.has(command.name.toLowerCase()))
            .map((command) => ({
              ...command,
              type: 'built-in',
            })),
          ...skillCommands,
          ...((data.custom || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'custom',
          })),
        ];

        const parsedHistory = readCommandHistory(selectedProject.projectId);
        const sortedCommands = [...allCommands].sort((commandA, commandB) => {
          const commandAUsage = parsedHistory[commandA.name] || 0;
          const commandBUsage = parsedHistory[commandB.name] || 0;
          return commandBUsage - commandAUsage;
        });

        if (!cancelled) {
          setFetchedCommands(sortedCommands);
        }
      } catch (error) {
        console.error('Error fetching slash commands:', error);
        if (!cancelled) {
          setFetchedCommands([]);
        }
      }
    };

    fetchCommands();
    return () => {
      cancelled = true;
    };
  }, [selectedProject, provider]);

  useEffect(() => {
    if (!showCommandMenu) {
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  useEffect(() => {
    setFilteredCommands(filterSlashCommands(slashCommands, commandQuery));
  }, [commandQuery, slashCommands]);

  const frequentCommands = useMemo(() => {
    if (!selectedProject || slashCommands.length === 0) {
      return [];
    }

    const parsedHistory = readCommandHistory(selectedProject.projectId);

    return slashCommands
      .map((command) => ({
        ...command,
        usageCount: parsedHistory[command.name] || 0,
      }))
      .filter((command) => command.usageCount > 0)
      .sort((commandA, commandB) => commandB.usageCount - commandA.usageCount)
      .slice(0, 5);
  }, [selectedProject, slashCommands]);

  const trackCommandUsage = useCallback(
    (command: SlashCommand) => {
      if (!selectedProject) {
        return;
      }

      const parsedHistory = readCommandHistory(selectedProject.projectId);
      parsedHistory[command.name] = (parsedHistory[command.name] || 0) + 1;
      saveCommandHistory(selectedProject.projectId, parsedHistory);
    },
    [selectedProject],
  );

  const insertCommandIntoInput = useCallback(
    (command: SlashCommand) => {
      const currentTextarea = textareaRef.current;
      const insertionStart = slashPosition >= 0
        ? slashPosition
        : currentTextarea?.selectionStart ?? input.length;
      const textBeforeCommand = input.slice(0, insertionStart);
      const textAfterCommandStart = input.slice(insertionStart);
      const spaceIndex = textAfterCommandStart.indexOf(' ');
      const textAfterCommand = slashPosition >= 0 && spaceIndex !== -1
        ? textAfterCommandStart.slice(spaceIndex).trimStart()
        : input.slice(currentTextarea?.selectionEnd ?? insertionStart);
      const separator = textBeforeCommand && !/\s$/.test(textBeforeCommand) ? ' ' : '';
      const newInput = `${textBeforeCommand}${separator}${command.name}${textAfterCommand ? ` ${textAfterCommand}` : ' '}`;

      setInput(newInput);
      resetCommandMenuState();

      window.requestAnimationFrame(() => {
        currentTextarea?.focus();
        const nextCursorPosition = `${textBeforeCommand}${separator}${command.name} `.length;
        currentTextarea?.setSelectionRange(nextCursorPosition, nextCursorPosition);
      });
    },
    [input, resetCommandMenuState, setInput, slashPosition, textareaRef],
  );

  const isCommandExecutionDisabled = useCallback(
    (command: SlashCommand) =>
      isExecutableCommandRunning &&
      getSlashCommandSelectionMode(provider, command) === 'execute',
    [isExecutableCommandRunning, provider],
  );

  const executeNonSkillCommand = useCallback(
    (command: SlashCommand) => {
      if (isCommandExecutionDisabled(command)) {
        return;
      }

      // Selection feedback is immediate: the network request must not leave a
      // stale menu covering the composer while the command is running.
      resetCommandMenuState();
      window.requestAnimationFrame(() => textareaRef.current?.focus());

      const executionResult = onExecuteCommand(command);
      if (isPromiseLike(executionResult)) {
        // Keep behavior silent; execution errors are handled by the caller.
        void executionResult.catch(() => undefined);
      }
    },
    [isCommandExecutionDisabled, onExecuteCommand, resetCommandMenuState, textareaRef],
  );

  // T-1704: an immediate passthrough leaves the composer untouched and goes
  // straight to the engine; the menu closes first so no stale list covers it.
  const dispatchImmediatePassthrough = useCallback(
    (command: SlashCommand): boolean => {
      if (!onDispatchPassthroughCommand || !isImmediatePassthroughCommand(command)) {
        return false;
      }
      // Whatever the user had typed besides the "/comp…" trigger survives the
      // dispatch: only the slash token that opened the menu is removed.
      const remainingInput = slashPosition >= 0
        ? `${input.slice(0, slashPosition)}${input.slice(slashPosition).replace(/^\/\S*\s?/, '')}`
        : input;
      resetCommandMenuState();
      onDispatchPassthroughCommand(command, remainingInput);
      return true;
    },
    [input, onDispatchPassthroughCommand, resetCommandMenuState, slashPosition],
  );

  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      if (getSlashCommandSelectionMode(provider, command) === 'insert') {
        if (dispatchImmediatePassthrough(command)) {
          return;
        }
        insertCommandIntoInput(command);
        return;
      }

      if (isCommandExecutionDisabled(command)) {
        return;
      }
      executeNonSkillCommand(command);
    },
    [
      dispatchImmediatePassthrough,
      executeNonSkillCommand,
      insertCommandIntoInput,
      isCommandExecutionDisabled,
      provider,
    ],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand | null, index: number, isHover: boolean) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isHover) {
        setSelectedCommandIndex(index);
        return;
      }

      const selectionMode = getSlashCommandSelectionMode(provider, command);
      if (selectionMode === 'execute' && isCommandExecutionDisabled(command)) {
        return;
      }

      trackCommandUsage(command);
      if (selectionMode === 'insert') {
        if (dispatchImmediatePassthrough(command)) {
          return;
        }
        insertCommandIntoInput(command);
        return;
      }

      executeNonSkillCommand(command);
    },
    [
      selectedProject,
      trackCommandUsage,
      dispatchImmediatePassthrough,
      insertCommandIntoInput,
      executeNonSkillCommand,
      isCommandExecutionDisabled,
      provider,
    ],
  );

  const handleToggleCommandMenu = useCallback(() => {
    const isOpening = !showCommandMenu;
    setShowCommandMenu(isOpening);
    setCommandQuery('');
    setSelectedCommandIndex(-1);

    if (isOpening) {
      setFilteredCommands(slashCommands);
    }

    textareaRef.current?.focus();
  }, [showCommandMenu, slashCommands, textareaRef]);

  const handleCommandInputChange = useCallback(
    (newValue: string, cursorPos: number) => {
      if (!newValue.trim()) {
        resetCommandMenuState();
        return;
      }

      const textBeforeCursor = newValue.slice(0, cursorPos);
      const backticksBefore = (textBeforeCursor.match(/```/g) || []).length;
      const inCodeBlock = backticksBefore % 2 === 1;

      if (inCodeBlock) {
        resetCommandMenuState();
        return;
      }

      // Match / at start of input OR after whitespace, capturing the /word up to cursor.
      const slashPattern = /(?:^|\s)(\/\S*)$/;
      const match = textBeforeCursor.match(slashPattern);

      if (!match) {
        resetCommandMenuState();
        return;
      }

      // Compute actual position of / in the full input string.
      const slashPos = match.index! + (match[0].length - match[1].length);
      const query = match[1].slice(1); // strip leading /

      setSlashPosition(slashPos);
      setShowCommandMenu(true);
      setSelectedCommandIndex(-1);

      clearCommandQueryTimer();
      commandQueryTimerRef.current = window.setTimeout(() => {
        setCommandQuery(query);
      }, COMMAND_QUERY_DEBOUNCE_MS);
    },
    [resetCommandMenuState, clearCommandQueryTimer],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showCommandMenu) {
        return false;
      }

      if (!filteredCommands.length) {
        if (event.key === 'Escape') {
          event.preventDefault();
          resetCommandMenuState();
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) => {
          for (let offset = 1; offset <= filteredCommands.length; offset += 1) {
            const nextIndex = (previousIndex + offset + filteredCommands.length) % filteredCommands.length;
            if (!isCommandExecutionDisabled(filteredCommands[nextIndex])) return nextIndex;
          }
          return -1;
        });
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedCommandIndex((previousIndex) => {
          const startIndex = previousIndex < 0 ? 0 : previousIndex;
          for (let offset = 1; offset <= filteredCommands.length; offset += 1) {
            const nextIndex = (startIndex - offset + filteredCommands.length) % filteredCommands.length;
            if (!isCommandExecutionDisabled(filteredCommands[nextIndex])) return nextIndex;
          }
          return -1;
        });
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedCommandIndex >= 0) {
          selectCommandFromKeyboard(filteredCommands[selectedCommandIndex]);
        } else {
          const firstEnabledCommand = filteredCommands.find(
            (command) => !isCommandExecutionDisabled(command),
          );
          if (firstEnabledCommand) selectCommandFromKeyboard(firstEnabledCommand);
        }
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        resetCommandMenuState();
        return true;
      }

      return false;
    },
    [
      showCommandMenu,
      filteredCommands,
      isCommandExecutionDisabled,
      resetCommandMenuState,
      selectCommandFromKeyboard,
      selectedCommandIndex,
    ],
  );

  useEffect(
    () => () => {
      clearCommandQueryTimer();
    },
    [clearCommandQueryTimer],
  );

  return {
    slashCommands,
    slashCommandsCount: slashCommands.length,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
    isCommandExecutionDisabled,
  };
}
