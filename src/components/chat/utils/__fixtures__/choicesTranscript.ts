/**
 * T-2027 — transcript fixtures for quick-reply tests, shaped as the session
 * store's NormalizedMessage rows and converted through the real
 * `normalizedToChatMessages`, so tests see exactly what the UI renders.
 */
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import type { ChatMessage } from '../../types/types';

const SESSION = 'session-choices-1';
let clock = Date.parse('2026-10-15T09:00:00.000Z');
const stamp = () => new Date((clock += 1_000)).toISOString();

const row = (fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'id' | 'kind'>): NormalizedMessage =>
  ({ sessionId: SESSION, provider: 'claude', timestamp: stamp(), ...fields }) as NormalizedMessage;

export const CHOICES_REPLY = 'شغّل `npm test` ثم أخبرني بالنتيجة.\n\n```choices\nشغّلته\nلم يعمل\nأحتاج شرحاً\n```';
export const CHOICES = ['شغّلته', 'لم يعمل', 'أحتاج شرحاً'];

export const userText = (id: string, content: string) =>
  row({ id, kind: 'text', role: 'user', content, userId: 1 } as Partial<NormalizedMessage> & { id: string; kind: 'text' });
export const assistantText = (id: string, content = CHOICES_REPLY) =>
  row({ id, kind: 'text', role: 'assistant', content, transcriptMessageId: `uuid-${id}`, model: 'claude-opus-5-5' });
export const thinking = (id: string) => row({ id, kind: 'thinking', content: 'Checking the test output…' });
export const streamDelta = (id: string, content = CHOICES_REPLY) => row({ id, kind: 'stream_delta', role: 'assistant', content });
export const toolUse = (id: string) =>
  row({ id, kind: 'tool_use', toolName: 'Bash', toolId: `tool-${id}`, toolInput: { command: 'npm test' } });
export const errorRow = (id: string) => row({ id, kind: 'error', content: 'boom', code: 'SERVER_ERROR' } as Partial<NormalizedMessage> & { id: string; kind: 'error' });
export const interactivePrompt = (id: string) =>
  row({ id, kind: 'interactive_prompt', content: 'Do you want to proceed?\n❯ 1. Yes\n  2. No' });

export const toChat = (rows: NormalizedMessage[]): ChatMessage[] => normalizedToChatMessages(rows);
