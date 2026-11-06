/**
 * Device information extracted from HTTP request headers.
 * Used for session tracking and security monitoring.
 */
export interface DeviceInfo {
  /**
   * Client IP address supplied by the connection socket or HTTP adapter.
   */
  ip?: string
  /** Raw user agent string */
  userAgent?: string
  /** Parsed operating system name and version */
  os?: string
  /** Parsed browser name and version */
  browser?: string
  /** Device category */
  deviceType?: 'mobile' | 'desktop' | 'tablet' | 'unknown'
}

/**
 * Represents a user session with refresh token rotation support.
 * Sessions belong to a token family for theft detection.
 */
export interface Session {
  /** Unique session identifier */
  id: string
  /** User who owns this session */
  userId: string
  /** Token family for rotation tracking and theft detection */
  familyId: string
  /** Current refresh token value */
  token: string
  /** Unix timestamp (seconds) when session expires */
  expiration: number
  /** Device that created this session */
  deviceInfo?: DeviceInfo
  /** Whether this session has been revoked */
  isRevoked?: boolean
  /** Token that replaced this one after rotation */
  replacedBy?: string
  /** Unix timestamp (ms) when token was last used/rotated (for grace period) */
  usedAt?: number
}

/**
 * JWT access token payload structure.
 * @template TClaims - Additional custom claims to include
 */
export interface AccessTokenPayload<TClaims = Record<string, never>> {
  /** User identifier */
  userId: string
  /** Session identifier for token binding */
  sessionId: string
  /** Issued-at time (Unix timestamp in seconds, server clock) */
  iat: number
  /** Expiration time (Unix timestamp in seconds, server clock) */
  exp: number
  /** Optional custom claims */
  claims?: TClaims
}

/**
 * Token pair returned after authentication or refresh.
 */
export interface TokenPair {
  /** Short-lived JWT access token */
  accessToken: string
  /** Long-lived opaque refresh token */
  refreshToken: string
  /** Access token expiration (Unix timestamp in seconds) */
  exp: number
}

/**
 * Interface for session storage and management.
 * Implement this for different storage backends (MongoDB, Redis, etc.)
 */
export interface SessionManager {
  /**
   * Create a new session for a user.
   * @param userId - User identifier
   * @param deviceInfo - Optional device information
   * @returns Token pair for the new session
   */
  createSession(userId: string, deviceInfo?: DeviceInfo): Promise<TokenPair>

  /**
   * Refresh an existing session, rotating the refresh token.
   * @param refreshToken - Current refresh token
   * @param deviceInfo - Optional updated device information
   * @returns New token pair, or null if refresh token is invalid/expired
   */
  refreshSession(
    refreshToken: string,
    deviceInfo?: DeviceInfo,
  ): Promise<TokenPair | null>

  /**
   * Revoke a specific session by ID.
   * @param sessionId - Session to revoke
   * @returns Whether the session was found and revoked
   */
  revokeSession(sessionId: string): Promise<boolean>

  /**
   * Revoke all sessions in a token family (for theft detection).
   * @param familyId - Token family to revoke
   * @returns Number of sessions revoked
   */
  revokeFamily(familyId: string): Promise<number>

  /**
   * Get all active sessions for a user.
   * @param userId - User identifier
   * @returns Array of active sessions
   */
  getUserSessions(userId: string): Promise<Session[]>

  /**
   * Revoke all sessions for a user, optionally keeping one family.
   * @param userId - User identifier
   * @param exceptFamilyId - Optional family to preserve (current session)
   * @returns Number of sessions revoked
   */
  revokeAllUserSessions(
    userId: string,
    exceptFamilyId?: string,
  ): Promise<number>
}

/**
 * Authentication provider interface.
 * Implement this to support different authentication methods.
 * @template TUser - User type returned in auth context
 */
export interface AuthProvider<TUser = unknown> {
  /**
   * Authenticate a token and return the auth context.
   * @param token - Token to authenticate
   * @returns Auth context if valid, null otherwise
   */
  authenticate(token: string): Promise<AuthContext<TUser> | null>
}

/**
 * Authentication context stored in cache and attached to client.
 * @template TUser - User type
 */
export interface AuthContext<TUser = unknown> {
  /** Full user object */
  user: TUser
  /** User identifier (string representation) */
  userId: string
  /** Session identifier (if using session-based auth) */
  sessionId?: string
}

/**
 * Configuration for authentication module.
 */
export interface AuthConfig {
  /** JWT signing secret */
  secret: string
  /** JWT algorithm (default: 'HS256') */
  algorithm?: 'HS256' | 'HS384' | 'HS512'
  /** Access token expiry in minutes (default: 15) */
  accessTokenExpiryMinutes?: number
  /** Refresh token expiry in days (default: 14) */
  refreshTokenExpiryDays?: number
  /** Grace period for concurrent refresh requests in seconds (default: 15) */
  rotationGracePeriodSeconds?: number
  /** Rate limiting for login endpoint */
  loginRateLimit?: { windowMs: number; maxAttempts: number }
  /** Rate limiting for refresh endpoint */
  refreshRateLimit?: { windowMs: number; maxAttempts: number }
}

/**
 * Cookie configuration options.
 */
export interface CookieOptions {
  /** Cookie name */
  name: string
  /** Cookie max age in days */
  maxAgeDays: number
  /** Whether to set Secure flag (default: true in production) */
  secure?: boolean
  /** SameSite attribute (default: 'Strict') */
  sameSite?: 'Strict' | 'Lax' | 'None'
  /** Cookie path (default: '/') */
  path?: string
}

/**
 * Configuration for client-side token refresh.
 */
export interface TokenRefreshConfig {
  /** Server method to call for refresh (default: 'auth.refresh') */
  refreshMethod: string
  /** Seconds before expiry to trigger refresh (default: 60) */
  refreshBeforeExpirySec: number
  /** BroadcastChannel name for cross-tab sync */
  broadcastChannelName?: string
}

/**
 * Configuration for cross-tab token synchronization.
 */
export interface CrossTabSyncConfig {
  /** BroadcastChannel name */
  channelName: string
  /** Event to emit when token is received from another tab */
  tokenRefreshedEvent?: string
}
