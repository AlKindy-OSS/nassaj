export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export {
  PRESENCE_MESSAGE_TYPE,
  presenceConnect,
  presenceDisconnect,
  presenceRunStarted,
  presenceRunState,
  presenceRunStopped,
} from './services/presence.service.js';
// B-137 session read gate. Exported through the barrel so other backend modules
// (ج1: the providers module's read-only activity route) reuse the ONE visibility
// predicate instead of re-implementing it; cross-module imports may only touch
// this barrel (eslint boundaries).
export { isSessionVisibleToUser } from './services/chat-websocket.service.js';
export {
  OPEN_SESSIONS_MESSAGE_TYPE,
  openSessionsCount,
  openSessionStarted,
  openSessionStopped,
  sendOpenSessionsCount,
} from './services/open-sessions.service.js';
