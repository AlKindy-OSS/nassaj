/**
 * T-881 — مدخلة «/btw» في قائمة السلاش
 *
 * يثبت:
 *   • isBtwSlashEntry: الحكم الصحيح على نوع المدخلة
 *   • توجيه القائمة: btw → insertIntoInput (ليس executeNonSkill)
 *   • الإدراج ينتهي بمسافة (insertCommandIntoInput يُلحق ' ' حين لا يوجد نص بعد الأمر)
 *   • بوابة المزوّد: claude (sideChannel.supported=true) يرى المدخلة
 *   • بوابة المزوّد: codex/hermes/… (sideChannel.supported=false) لا يرى المدخلة
 *   • لا تداخل: isBtwSlashEntry لا يؤثر على predicates التوجيه الأخرى
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/btwSlashEntry.test.ts
 */

import { describe, it, expect } from 'vitest';

import {
  isBtwSlashEntry,
  isOpenCodePassthroughCommand,
  isPassthroughBuiltInCommand,
  type SlashCommand,
} from './useSlashCommands';
import { getProviderCapabilities } from '../constants/providerCapabilities';
import { getDisplayNamespace } from '../utils/commandNamespace';

// ---------------------------------------------------------------------------
// بناء أوامر اختبارية
// ---------------------------------------------------------------------------

const makeBtwEntry = (): SlashCommand => ({
  name: '/btw',
  description: 'Ask a side question on the current session context',
  namespace: 'nassaj',
  type: 'btw',
});

const makeSkillCommand = (name = '/code-review'): SlashCommand => ({
  name,
  description: 'Code review skill',
  namespace: 'skill',
  type: 'skill',
});

const makePassthroughBuiltIn = (name = '/review'): SlashCommand => ({
  name,
  namespace: 'builtin',
  type: 'built-in',
  metadata: { hasHandler: false },
});

const makeOpenCodeCommand = (name = '/build'): SlashCommand => ({
  name,
  namespace: 'opencode',
  type: 'custom',
});

const makeHandledBuiltIn = (name = '/help'): SlashCommand => ({
  name,
  namespace: 'builtin',
  type: 'built-in',
  metadata: { hasHandler: true },
});

const makeClaudeCustom = (name = '/deploy'): SlashCommand => ({
  name,
  namespace: 'project',
  type: 'custom',
});

// ---------------------------------------------------------------------------
// isBtwSlashEntry
// ---------------------------------------------------------------------------

describe('isBtwSlashEntry', () => {
  it('مدخلة btw كاملة (namespace:nassaj + type:btw) → true', () => {
    expect(isBtwSlashEntry(makeBtwEntry())).toBe(true);
  });

  it('type:btw بدون namespace:nassaj → false', () => {
    expect(isBtwSlashEntry({ name: '/btw', type: 'btw', namespace: 'builtin' })).toBe(false);
  });

  it('namespace:nassaj بدون type:btw → false', () => {
    expect(isBtwSlashEntry({ name: '/btw', type: 'custom', namespace: 'nassaj' })).toBe(false);
  });

  it('أمر skill → false', () => {
    expect(isBtwSlashEntry(makeSkillCommand())).toBe(false);
  });

  it('passthrough built-in → false', () => {
    expect(isBtwSlashEntry(makePassthroughBuiltIn())).toBe(false);
  });

  it('opencode → false', () => {
    expect(isBtwSlashEntry(makeOpenCodeCommand())).toBe(false);
  });

  it('handled built-in → false', () => {
    expect(isBtwSlashEntry(makeHandledBuiltIn())).toBe(false);
  });

  it('claude custom → false', () => {
    expect(isBtwSlashEntry(makeClaudeCustom())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// بوابة المزوّد: sideChannel.supported
// ---------------------------------------------------------------------------

describe('بوابة sideChannel — أي المزوّدات تُظهر /btw', () => {
  it('claude → sideChannel.supported = true (تُظهر المدخلة)', () => {
    expect(getProviderCapabilities('claude').sideChannel.supported).toBe(true);
  });

  it('codex → sideChannel.supported = false (تُخفي المدخلة)', () => {
    expect(getProviderCapabilities('codex').sideChannel.supported).toBe(false);
  });

  it('hermes → sideChannel.supported = false', () => {
    expect(getProviderCapabilities('hermes').sideChannel.supported).toBe(false);
  });

  it('kimi → sideChannel.supported = false', () => {
    expect(getProviderCapabilities('kimi').sideChannel.supported).toBe(false);
  });

  it('antigravity → sideChannel.supported = false', () => {
    expect(getProviderCapabilities('antigravity').sideChannel.supported).toBe(false);
  });

  it('مزوّد غير معروف → sideChannel.supported = false (fail-closed)', () => {
    expect(getProviderCapabilities('unknown_provider').sideChannel.supported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// توجيه القائمة (menu routing)
// يحاكي منطق selectCommandFromKeyboard / handleCommandSelect
// ---------------------------------------------------------------------------

/**
 * محاكاة القرار في الهوك عند اختيار أمر من القائمة بعد إضافة isBtwSlashEntry:
 *   - skill / passthrough / opencode / btw → insertIntoInput
 *   - غيره → executeNonSkill
 */
function simulateMenuRouting(command: SlashCommand): 'insertIntoInput' | 'executeNonSkill' {
  const isSkill = command.type === 'skill' || command.metadata?.type === 'skill';
  if (
    isSkill ||
    isPassthroughBuiltInCommand(command) ||
    isOpenCodePassthroughCommand(command) ||
    isBtwSlashEntry(command)
  ) {
    return 'insertIntoInput';
  }
  return 'executeNonSkill';
}

describe('توجيه القائمة — isBtwSlashEntry يُوجَّه إلى insertIntoInput', () => {
  it('btw → insertIntoInput (لا executeNonSkill)', () => {
    expect(simulateMenuRouting(makeBtwEntry())).toBe('insertIntoInput');
  });

  it('skill → insertIntoInput (لا انحدار)', () => {
    expect(simulateMenuRouting(makeSkillCommand())).toBe('insertIntoInput');
  });

  it('passthrough built-in → insertIntoInput (لا انحدار)', () => {
    expect(simulateMenuRouting(makePassthroughBuiltIn())).toBe('insertIntoInput');
  });

  it('opencode → insertIntoInput (لا انحدار)', () => {
    expect(simulateMenuRouting(makeOpenCodeCommand())).toBe('insertIntoInput');
  });

  it('handled built-in → executeNonSkill (لا انحدار)', () => {
    expect(simulateMenuRouting(makeHandledBuiltIn())).toBe('executeNonSkill');
  });

  it('claude custom → executeNonSkill (لا انحدار)', () => {
    expect(simulateMenuRouting(makeClaudeCustom())).toBe('executeNonSkill');
  });
});

// ---------------------------------------------------------------------------
// الإدراج ينتهي بمسافة
// يحاكي insertCommandIntoInput في useSlashCommands (حالة: إدخال فارغ، لا نص بعد الأمر)
// ---------------------------------------------------------------------------

/**
 * محاكاة newInput الذي يبنيه insertCommandIntoInput من إدخال فارغ:
 * السطر الرئيسي في الهوك:
 *   const newInput = `${textBefore}${sep}${command.name}${textAfter ? ` ${textAfter}` : ' '}`;
 */
function simulateInsert(command: SlashCommand, existingInput = ''): string {
  const textBeforeCommand = existingInput; // slashPosition = 0 في البداية
  const textAfterCommand = '';            // لا نص بعد
  const separator = '';                   // البداية فارغة — لا فاصل
  return `${textBeforeCommand}${separator}${command.name}${textAfterCommand ? ` ${textAfterCommand}` : ' '}`;
}

describe('الإدراج ينتهي بمسافة', () => {
  it('insertCommandIntoInput على إدخال فارغ ينتج «/btw »', () => {
    const result = simulateInsert(makeBtwEntry(), '');
    expect(result).toBe('/btw ');
  });

  it('النتيجة تنتهي بمسافة واحدة بالضبط', () => {
    const result = simulateInsert(makeBtwEntry(), '');
    expect(result.endsWith(' ')).toBe(true);
  });

  it('النتيجة لا تُرسل كأمر btw صالح (السؤال فارغ)', () => {
    // isBtwCommand تشترط سؤالاً غير فارغ بعد «/btw »
    // نتيجة الإدراج هي «/btw » (مسافة فقط) — السؤال = '' → false
    const inserted = simulateInsert(makeBtwEntry(), '');
    const questionAfterPrefix = inserted.slice('/btw '.length).trim();
    expect(questionAfterPrefix).toBe('');
    // أي: المستخدم لا يزال بحاجة لكتابة سؤاله قبل الإرسال
  });
});

// ---------------------------------------------------------------------------
// لا تداخل مع predicates التوجيه الأخرى
// ---------------------------------------------------------------------------

describe('لا تداخل — btw لا يُأثّر على predicates أخرى', () => {
  const btw = makeBtwEntry();

  it('isPassthroughBuiltInCommand(btw) → false', () => {
    expect(isPassthroughBuiltInCommand(btw)).toBe(false);
  });

  it('isOpenCodePassthroughCommand(btw) → false', () => {
    expect(isOpenCodePassthroughCommand(btw)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-1055: تصنيف العرض — /btw تحت مجموعة «Built-in Commands»
// يُثبت أن getDisplayNamespace تطوي «nassaj» تحت «builtin» عرضاً فقط،
// بينما يبقى namespace='nassaj' هو المعتمَد في كل قرارات التوجيه.
// ---------------------------------------------------------------------------

describe('T-1055 — تصنيف العرض: /btw تُعرض ضمن مجموعة builtin', () => {
  it('(١) getDisplayNamespace(btwEntry) → builtin', () => {
    expect(getDisplayNamespace(makeBtwEntry())).toBe('builtin');
  });

  it('(٢-أ) namespace المدخلة نفسها لا يزال nassaj — وسم التوجيه لم يُمسّ', () => {
    expect(makeBtwEntry().namespace).toBe('nassaj');
  });

  it('(٢-ب) isPassthroughBuiltInCommand لا يزال false — لا تُرسَل للـCLI خاماً', () => {
    expect(isPassthroughBuiltInCommand(makeBtwEntry())).toBe(false);
  });

  it('(٣) الإدراج لا يزال ينتهي بمسافة بعد تغيير تصنيف العرض', () => {
    expect(simulateInsert(makeBtwEntry(), '')).toBe('/btw ');
  });
});
