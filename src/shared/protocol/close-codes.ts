/**
 * Application WebSocket close codes. Colyseus reserves 4000-4010, so custom codes live above that.
 * The Unity client maps these in `WebSocketSessionTermination`.
 */
export const AppCloseCode = {
  /** Session revoked (logout elsewhere, ban, token rotation). Client must return to login. */
  SESSION_REVOKED: 4401,
  /** Default code used by the GM panel / maintenance mass disconnect. */
  MAINTENANCE_DISCONNECT: 4101,
  /** Policy violation (invalid token on join). */
  POLICY_VIOLATION: 1008,
  /** Internal error while registering the connection. */
  INTERNAL_ERROR: 1011,
} as const;
