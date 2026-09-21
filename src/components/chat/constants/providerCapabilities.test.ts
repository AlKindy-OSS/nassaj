/**
 * T-224 (م0+م1) — الواصف الكانوني لقدرات مزوّدات الواجهة.
 *
 * يثبت:
 *   • hermes.permissions.modes === ['default'] (م1 — الخلفي يتجاوز الأذونات).
 *   • cyclePermissionMode مع مجموعة أحادية (hermes) لا ينكسر — يبقى في 'default'.
 *   • getProviderDisplayName: hermes/kimi/deepseek/glm لا تُسقَط إلى «Claude».
 *   • safeFallbackCapabilities: مزوّد غير معروف يعرض اسمه الخام لا «Claude».
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/constants/providerCapabilities.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  getProviderCapabilities,
  getProviderDisplayName,
} from './providerCapabilities';

describe('getProviderCapabilities — hermes permissions (T-224 م1)', () => {
  it('hermes.permissions.modes يساوي [\'default\'] بالضبط', () => {
    const caps = getProviderCapabilities('hermes');
    expect(caps.permissions.modes).toEqual(['default']);
  });

  it('hermes.permissions.modes عنصر واحد فقط — لا دوّار', () => {
    const modes = getProviderCapabilities('hermes').permissions.modes;
    expect(modes).toHaveLength(1);
  });

  it('cyclePermissionMode مع hermes (مجموعة أحادية): (indexOf+1) % length يعود لـ default', () => {
    // محاكاة مضمون دوّار الأذونات في useChatProviderState دون بيئة React.
    const modes = getProviderCapabilities('hermes').permissions.modes;
    const currentMode = 'default';
    const currentIndex = modes.indexOf(currentMode);
    expect(currentIndex).toBe(0); // 'default' موجود

    const nextIndex = (currentIndex + 1) % modes.length;
    expect(modes[nextIndex]).toBe('default'); // يبقى في default — لا نكسر
  });

  it('claude يحتفظ بمجموعته الكاملة (5 أوضاع)', () => {
    const modes = getProviderCapabilities('claude').permissions.modes;
    expect(modes).toContain('default');
    expect(modes).toContain('auto');
    expect(modes).toContain('acceptEdits');
    expect(modes).toContain('bypassPermissions');
    expect(modes).toContain('plan');
  });
});

describe('getProviderDisplayName — إصلاح وسم هرمز (T-224 م0)', () => {
  it('hermes لا يُسقَط إلى «Claude»', () => {
    expect(getProviderDisplayName('hermes')).not.toBe('Claude');
  });

  it('hermes يعرض «Hermes (Nous)»', () => {
    expect(getProviderDisplayName('hermes')).toBe('Hermes (Nous)');
  });

  it('kimi لا يُسقَط إلى «Claude»', () => {
    expect(getProviderDisplayName('kimi')).not.toBe('Claude');
    expect(getProviderDisplayName('kimi')).toBe('Kimi');
  });

  it('deepseek لا يُسقَط إلى «Claude»', () => {
    expect(getProviderDisplayName('deepseek')).not.toBe('Claude');
    expect(getProviderDisplayName('deepseek')).toBe('DeepSeek');
  });

  it('glm لا يُسقَط إلى «Claude»', () => {
    expect(getProviderDisplayName('glm')).not.toBe('Claude');
    expect(getProviderDisplayName('glm')).toBe('GLM');
  });

  it('المزوّدات المعروفة لا تتأثّر: claude → «Claude»', () => {
    expect(getProviderDisplayName('claude')).toBe('Claude');
  });

  it('المزوّدات المعروفة لا تتأثّر: cursor → «Cursor»', () => {
    expect(getProviderDisplayName('cursor')).toBe('Cursor');
  });

  it('المزوّدات المعروفة لا تتأثّر: codex → «Codex»', () => {
    expect(getProviderDisplayName('codex')).toBe('Codex');
  });

  it('المزوّدات المعروفة لا تتأثّر: gemini → «Gemini»', () => {
    expect(getProviderDisplayName('gemini')).toBe('Gemini');
  });

  it('المزوّدات المعروفة لا تتأثّر: opencode → «OpenCode»', () => {
    expect(getProviderDisplayName('opencode')).toBe('OpenCode');
  });

  it('مزوّد غير معروف يعرض اسمه الخام (بحرف كبير) لا «Claude»', () => {
    const name = getProviderDisplayName('futuremodel');
    expect(name).not.toBe('Claude');
    expect(name).toBe('Futuremodel');
  });

  it('قيمة null/undefined تسقط إلى Claude (سقوط آمن)', () => {
    expect(getProviderDisplayName(null)).toBe('Claude');
    expect(getProviderDisplayName(undefined)).toBe('Claude');
  });
});
