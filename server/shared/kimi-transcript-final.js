import { randomUUID } from 'node:crypto';
/** Persist the ordered native-agent turn through the existing vendor writer, returning only the acknowledged final text ID. */
export async function persistKimiTranscriptFinal(turn, append) {
  if (!turn.sessionId || !Number.isSafeInteger(turn.userId) || turn.userId <= 0)
    return null;
  const messages = [...turn.messages];
  const blocks = turn.assistantBlocks;
  const last = blocks.at(-1);
  const finalText = turn.succeeded && last?.type === 'text' && last.text?.trim() ? last.text : null;
  const preceding = finalText ? blocks.slice(0, -1) : blocks;
  if (preceding.length)
    messages.push({ role: 'assistant', content: preceding });
  if (finalText)
    messages.push({ role: 'assistant', content: finalText, isFinalAnswer: true });
  let finalId = null;
  try {
    for (const message of messages) {
      const id = randomUUID();
      await append({ type: 'message', timestamp: new Date().toISOString(), message: { id, ...message } }, id);
      if (message.isFinalAnswer)
        finalId = id;
    }
  }
  catch {
    return null;
  }
  return finalId;
}
