/** Public surface of the internal session team chat module (ADR-187). */
export { configureInternalChatSessionAccess, isInternalChatReady } from './access.js';
export { handleInternalChatConnection } from './connection.js';
export type { InternalChatConnection } from './connection.js';
export type { InternalChatAccessMode, SessionAccessPredicate } from './access.js';
export { internalChatRealtime } from './realtime.js';
export type { InternalChatSocket } from './realtime.js';
export { internalSessionChatDb } from './repository.js';
export type { InternalMemberGrant, InternalMessageDto, InternalRole } from './repository.js';
export { createInternalSessionChatRouter } from './routes.js';
