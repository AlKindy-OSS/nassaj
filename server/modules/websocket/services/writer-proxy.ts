import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import { WRITER_TARGET } from '@/shared/writer-target.js';

/**
 * Normalizes the JWT-derived socket identity to the integer the database
 * predicates expect, or null when it cannot be resolved (anonymous socket /
 * non-numeric id). One definition so every gate coerces identically — a
 * divergence would silently make one gate stricter than another.
 */
export function toNumericUserId(userId: unknown): number | null {
  const parsed =
    typeof userId === 'number'
      ? userId
      : typeof userId === 'string' && userId.trim() !== ''
        ? Number.parseInt(userId, 10)
        : null;
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * A per-run view of a shared writer: every own property of `overrides` (plain
 * values, methods or getters, read live) shadows the writer's; everything else
 * is forwarded to the writer with methods bound to it, and writes go to it.
 * Wrapping per run, never per socket, keeps one run's identity out of another
 * run that shares the same socket. `WRITER_TARGET` always yields the wrapped
 * writer (B-1327), so ownership checks can see through any wrapper stack.
 */
export function transparentWriterWith(writer: WebSocketWriter, overrides: object): WebSocketWriter {
  return new Proxy(writer, {
    get(target, property): unknown {
      if (property === WRITER_TARGET) return target;
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    set: (target, property, value) => Reflect.set(target, property, value, target),
    defineProperty: (target, property, descriptor) => Reflect.defineProperty(target, property, descriptor),
    deleteProperty: (target, property) => Reflect.deleteProperty(target, property),
  }) as WebSocketWriter;
}

/** The common case: only `send` is replaced. */
export function transparentWriterWithSend(
  writer: WebSocketWriter,
  send: (payload: unknown) => void,
): WebSocketWriter {
  return transparentWriterWith(writer, { send });
}
