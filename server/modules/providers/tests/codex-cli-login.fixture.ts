/**
 * ADR-200 S3 — what a successful `codex login --with-api-key` leaves on disk,
 * so fake spawns satisfy the writer's re-read-and-verify step (L4).
 *
 * Recorded against codex-cli 0.160.0 in a throwaway CODEX_HOME under /var/tmp
 * with dummy values only: the CLI REPLACES auth.json with exactly
 *   { "auth_mode": "apikey", "OPENAI_API_KEY": "<key>" }
 * (2-space JSON, no trailing newline), wiping any `tokens`/`last_refresh`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The bytes the measured CLI writes for an API-key login. */
export const codexCliApiKeyAuthJson = (apiKey: string): string =>
  JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2);

/**
 * Emulates the CLI's write for a fake child: `stdin` is the text the writer
 * sent, `opts.env.CODEX_HOME` the spawn's resolved home.
 */
export function emulateCodexCliLogin(opts: unknown, stdin: string): void {
  const home = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env?.CODEX_HOME;
  if (!home) return;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), codexCliApiKeyAuthJson(stdin.trim()));
}
