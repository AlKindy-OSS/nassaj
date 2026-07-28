/**
 * T-917 — OC-19ب: passthrough عميلي لأوامر opencode
 *
 * يثبت:
 *   • isOpenCodePassthroughCommand: أمر namespace:'opencode' → true
 *   • isOpenCodePassthroughCommand: أمر claude custom بلا namespace → false
 *   • isOpenCodePassthroughCommand: أمر built-in → false
 *   • isOpenCodePassthroughCommand: namespace:'skill' → false (لا تداخل)
 *   • منطق توجيه القائمة: opencode يُعامَل passthrough مثل skill والpassthrough built-in
 *   • منطق توجيه الإرسال: executeCommand لا يُستدعى لـ namespace:'opencode'
 *   • claude custom يبقى على مسار executeCommand
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/openCodePassthrough.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  isOpenCodePassthroughCommand,
  isPassthroughBuiltInCommand,
  type SlashCommand,
} from './useSlashCommands';

// ---------------------------------------------------------------------------
// بناء أوامر اختبارية
// ---------------------------------------------------------------------------

const makeOpenCodeCommand = (name = '/build'): SlashCommand => ({
  name,
  description: 'OpenCode native build command',
  namespace: 'opencode',
  type: 'custom',
  path: '/home/user/.config/opencode/command/build.md',
});

const makeClaudeCustomCommand = (name = '/deploy'): SlashCommand => ({
  name,
  description: 'Custom Claude command',
  namespace: 'project',
  type: 'custom',
  path: '/home/user/project/.claude/commands/deploy.md',
});

const makePassthroughBuiltIn = (name = '/review'): SlashCommand => ({
  name,
  description: 'Review built-in',
  namespace: 'builtin',
  type: 'built-in',
  metadata: { hasHandler: false },
});

const makeHandledBuiltIn = (name = '/help'): SlashCommand => ({
  name,
  description: 'Help built-in',
  namespace: 'builtin',
  type: 'built-in',
  metadata: { hasHandler: true },
});

const makeSkillCommand = (name = '/code-review'): SlashCommand => ({
  name,
  description: 'Code review skill',
  namespace: 'skill',
  type: 'skill',
});

// ---------------------------------------------------------------------------
// isOpenCodePassthroughCommand
// ---------------------------------------------------------------------------

describe('isOpenCodePassthroughCommand', () => {
  it('أمر namespace:opencode → true', () => {
    expect(isOpenCodePassthroughCommand(makeOpenCodeCommand())).toBe(true);
  });

  it('أمر opencode بمسار مختلف → true (النطاق وحده هو المحدِّد)', () => {
    expect(isOpenCodePassthroughCommand({ name: '/lint', namespace: 'opencode', type: 'custom' })).toBe(true);
  });

  it('أمر claude custom (namespace:project) → false', () => {
    expect(isOpenCodePassthroughCommand(makeClaudeCustomCommand())).toBe(false);
  });

  it('أمر claude custom (namespace:user) → false', () => {
    expect(isOpenCodePassthroughCommand({ name: '/x', namespace: 'user', type: 'custom' })).toBe(false);
  });

  it('أمر built-in passthrough → false (ليس opencode)', () => {
    expect(isOpenCodePassthroughCommand(makePassthroughBuiltIn())).toBe(false);
  });

  it('أمر built-in معالَج → false', () => {
    expect(isOpenCodePassthroughCommand(makeHandledBuiltIn())).toBe(false);
  });

  it('أمر skill → false (لا تداخل مع namespace:skill)', () => {
    expect(isOpenCodePassthroughCommand(makeSkillCommand())).toBe(false);
  });

  it('أمر بلا namespace → false', () => {
    expect(isOpenCodePassthroughCommand({ name: '/test', type: 'custom' })).toBe(false);
  });

  it('namespace فارغة → false', () => {
    expect(isOpenCodePassthroughCommand({ name: '/test', namespace: '', type: 'custom' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPassthroughBuiltInCommand لا يتأثر بإضافة opencode (لا انحدار)
// ---------------------------------------------------------------------------

describe('isPassthroughBuiltInCommand — بلا انحدار بعد إضافة opencode', () => {
  it('built-in بـhasHandler:false → true (كما كان)', () => {
    expect(isPassthroughBuiltInCommand(makePassthroughBuiltIn())).toBe(true);
  });

  it('built-in بـhasHandler:true → false (كما كان)', () => {
    expect(isPassthroughBuiltInCommand(makeHandledBuiltIn())).toBe(false);
  });

  it('أمر opencode → false (لا يُصنَّف built-in passthrough)', () => {
    expect(isPassthroughBuiltInCommand(makeOpenCodeCommand())).toBe(false);
  });

  it('أمر skill → false', () => {
    expect(isPassthroughBuiltInCommand(makeSkillCommand())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// منطق التوجيه المحاكي لـ handleCommandSelect / selectCommandFromKeyboard
// ---------------------------------------------------------------------------

/**
 * محاكاة القرار الذي يتخذه الهوك عند اختيار أمر من القائمة:
 *   - passthrough (skill / passthrough built-in / opencode) → insertIntoInput
 *   - غيره → executeNonSkill (يستدعي /api/commands/execute في النهاية)
 */
function simulateMenuRouting(command: SlashCommand): 'insertIntoInput' | 'executeNonSkill' {
  const isSkill = command.type === 'skill' || command.metadata?.type === 'skill';
  if (isSkill || isPassthroughBuiltInCommand(command) || isOpenCodePassthroughCommand(command)) {
    return 'insertIntoInput';
  }
  return 'executeNonSkill';
}

/**
 * محاكاة القرار في handleSubmit (useChatComposerState.ts ~:1010):
 *   إذا matchedCommand موجود وليس skill وليس passthrough built-in وليس opencode
 *   → executeCommand (أي /api/commands/execute)
 *   وإلا → dispatchProviderCommand (إرسال خام)
 */
function simulateSubmitRouting(
  matchedCommand: SlashCommand | undefined,
): 'executeCommand' | 'dispatchProviderCommand' | 'no_match' {
  if (!matchedCommand) {
    return 'no_match';
  }
  const isSkill = matchedCommand.type === 'skill';
  if (
    !isSkill &&
    !isPassthroughBuiltInCommand(matchedCommand) &&
    !isOpenCodePassthroughCommand(matchedCommand)
  ) {
    return 'executeCommand';
  }
  return 'dispatchProviderCommand';
}

describe('توجيه القائمة (menu routing)', () => {
  it('opencode → insertIntoInput (passthrough، لا executeNonSkill)', () => {
    expect(simulateMenuRouting(makeOpenCodeCommand())).toBe('insertIntoInput');
  });

  it('opencode بأي اسم → insertIntoInput', () => {
    expect(simulateMenuRouting({ name: '/format', namespace: 'opencode', type: 'custom' })).toBe('insertIntoInput');
  });

  it('skill → insertIntoInput (لا انحدار)', () => {
    expect(simulateMenuRouting(makeSkillCommand())).toBe('insertIntoInput');
  });

  it('passthrough built-in → insertIntoInput (لا انحدار)', () => {
    expect(simulateMenuRouting(makePassthroughBuiltIn())).toBe('insertIntoInput');
  });

  it('claude custom → executeNonSkill (يبقى على مسار execute)', () => {
    expect(simulateMenuRouting(makeClaudeCustomCommand())).toBe('executeNonSkill');
  });

  it('handled built-in → executeNonSkill (لا انحدار)', () => {
    expect(simulateMenuRouting(makeHandledBuiltIn())).toBe('executeNonSkill');
  });
});

describe('توجيه الإرسال (submit routing)', () => {
  it('opencode → dispatchProviderCommand (لا /api/commands/execute)', () => {
    expect(simulateSubmitRouting(makeOpenCodeCommand())).toBe('dispatchProviderCommand');
  });

  it('opencode مع args في الاسم → dispatchProviderCommand', () => {
    expect(simulateSubmitRouting({ name: '/build', namespace: 'opencode', type: 'custom' })).toBe('dispatchProviderCommand');
  });

  it('claude custom → executeCommand (/api/commands/execute — لا تغيير)', () => {
    expect(simulateSubmitRouting(makeClaudeCustomCommand())).toBe('executeCommand');
  });

  it('claude custom namespace:user → executeCommand', () => {
    expect(simulateSubmitRouting({ name: '/x', namespace: 'user', type: 'custom' })).toBe('executeCommand');
  });

  it('skill → dispatchProviderCommand (لا انحدار)', () => {
    expect(simulateSubmitRouting(makeSkillCommand())).toBe('dispatchProviderCommand');
  });

  it('passthrough built-in → dispatchProviderCommand (لا انحدار)', () => {
    expect(simulateSubmitRouting(makePassthroughBuiltIn())).toBe('dispatchProviderCommand');
  });

  it('handled built-in → executeCommand (يبقى على مسار execute)', () => {
    expect(simulateSubmitRouting(makeHandledBuiltIn())).toBe('executeCommand');
  });

  it('بلا أمر مطابق → no_match (يسقط لإرسال عادي)', () => {
    expect(simulateSubmitRouting(undefined)).toBe('no_match');
  });
});
