/**
 * idleThreshold.test.ts — عتبة تنبيه الخمول لكل هارنس (T-1765).
 *
 * RUNNER: vitest (npm run test:client)
 */

import { describe, expect, it } from 'vitest';

import { CODEX_GPT_5_6_IDLE_MS, isGpt56OrLater, resolveIdleThresholdMs } from './idleThreshold';

const claude = (claudeCacheTtlMinutes: number | null | undefined, engine: string | null = null) =>
  resolveIdleThresholdMs({ provider: 'claude', model: 'claude-opus-5', engine, claudeCacheTtlMinutes });

describe('resolveIdleThresholdMs — Claude يتبع قراءة المزوّد', () => {
  it('كاش ساعة معلن → 60 دقيقة', () => {
    expect(claude(60)).toBe(60 * 60_000);
  });

  it('كاش 5 دقائق معلن → 5 دقائق', () => {
    expect(claude(5)).toBe(5 * 60_000);
  });

  it('لا قراءة → لا تنبيه', () => {
    expect(claude(null)).toBeNull();
    expect(claude(undefined)).toBeNull();
  });

  it('قيمة غير معروفة → لا تنبيه', () => {
    expect(claude(30)).toBeNull();
  });

  it('جلسة Claude على محرّك غير Anthropic → لا تنبيه ولو وُجدت قراءة', () => {
    expect(claude(60, 'deepseek')).toBeNull();
  });
});

describe('resolveIdleThresholdMs — Codex', () => {
  const codex = (model: string | null) =>
    resolveIdleThresholdMs({ provider: 'codex', model, engine: null, claudeCacheTtlMinutes: 60 });

  it('GPT-5.6 فما بعد → 30 دقيقة', () => {
    expect(CODEX_GPT_5_6_IDLE_MS).toBe(30 * 60_000);
    for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.10', 'gpt-6-astra']) {
      expect(codex(model)).toBe(CODEX_GPT_5_6_IDLE_MS);
    }
  });

  it('النماذج الأقدم أو المجهولة → لا تنبيه', () => {
    for (const model of ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5', 'gpt-5-codex', 'o3', '', null]) {
      expect(codex(model)).toBeNull();
    }
  });

  it('isGpt56OrLater يقرأ الإصدار لا النص', () => {
    expect(isGpt56OrLater('GPT-5.7')).toBe(true);
    expect(isGpt56OrLater('gpt-4.9')).toBe(false);
  });
});

describe('resolveIdleThresholdMs — بقية الهارنسات', () => {
  it.each(['deepseek', 'gemini', 'kimi', 'opencode', 'glm', 'hermes', 'qwen', 'cursor', 'antigravity', 'sakana'])(
    '%s → لا تنبيه',
    (provider) => {
      expect(resolveIdleThresholdMs({ provider, model: 'gpt-5.6', engine: null, claudeCacheTtlMinutes: 60 })).toBeNull();
    },
  );
});
