import type { AnyRecord } from '@/shared/types.js';

/** Read a bounded provider-attested model identifier without inferring any fallback. */
export function readResponseModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const model = value.trim();
  return model && model.length <= 256 && !/\s|[\x00-\x1f\x7f]/.test(model) ? model : undefined;
}

/** Scope Anthropic-compatible message_start model metadata to one response, never a session. */
export function createVendorResponseModelReader(): (event: AnyRecord) => AnyRecord {
  let active: { id?: string; model?: string } | undefined;
  let completed: typeof active;
  return (event) => {
    if (event.type === 'message_start') {
      active = { id: readResponseModel(event.message?.id), model: readResponseModel(event.message?.model) };
      completed = undefined;
    }
    if (event.type === 'message_stop') { completed = active; active = undefined; }
    if (event.type === 'error') { active = undefined; completed = undefined; }
    if (event.type === 'message' || event.type === 'assistant') {
      const message = event.message ?? event;
      const id = readResponseModel(message.id);
      const context = id && id === active?.id ? active : id && id === completed?.id ? completed : undefined;
      const model = readResponseModel(message.model) ?? context?.model;
      if (message.role === 'user') { active = undefined; completed = undefined; return event; }
      return event.message ? { ...event, message: { ...message, model } } : { ...event, model };
    }
    if (event.type === 'content_block_delta' || event.type === 'content_block_start') {
      return { ...event, model: readResponseModel(event.model) ?? active?.model };
    }
    return event;
  };
}
