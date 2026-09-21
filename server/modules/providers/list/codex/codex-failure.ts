export type CodexFailure = {
  code: string;
  content: string;
  staleSessionId?: string;
  command?: string;
};

function readCodexFailureMessage(error: unknown): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const nestedError = record?.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : null;
  const raw = typeof error === 'string'
    ? error
    : record?.message ?? nestedError?.message ?? String(error || 'Codex turn failed');

  let message = String(raw).trim();
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = JSON.parse(message) as { message?: unknown; error?: { message?: unknown } };
      const nested = parsed.error?.message ?? parsed.message;
      if (typeof nested !== 'string' || nested.trim() === message) {
        break;
      }
      message = nested.trim();
    } catch {
      break;
    }
  }
  return message || 'Codex turn failed';
}

export function classifyCodexFailure(
  error: unknown,
  sessionId: string | null = null,
  command?: string,
): CodexFailure {
  const content = readCodexFailureMessage(error);
  const lower = content.toLowerCase();

  if (/thread .*not found|conversation .*not found|no rollout found/.test(lower)) {
    return {
      code: 'conversation_not_found',
      content: 'This Codex conversation no longer exists or its first turn never completed. Start a new conversation.',
      staleSessionId: sessionId || undefined,
      command,
    };
  }
  if (lower.includes('model') && lower.includes('not supported')) {
    return { code: 'model_not_supported', content };
  }
  if (/not logged in|authentication required|unauthorized|status["': ]+401/.test(lower)) {
    return { code: 'authentication_required', content: 'Codex authentication is missing or expired. Reconnect Codex in Settings.' };
  }
  if (/failed to load models cache|unknown variant/.test(lower)) {
    return {
      code: 'codex_cache_incompatible',
      content: 'The Codex model cache is incompatible with the installed runtime. Refresh models or update Codex before retrying.',
    };
  }
  if (/rate.?limit|quota|usage limit|too many requests/.test(lower)) {
    return { code: 'usage_limit', content };
  }
  return { code: 'codex_turn_failed', content };
}
