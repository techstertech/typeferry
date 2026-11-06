import { randomUUID } from 'node:crypto'

import type {
  AccessTokenPayload,
  AuthConfig,
  DeviceInfo,
  Session,
  SessionManager,
  TokenPair,
} from '../types'
import { signAccessToken } from './jwt-utils'

/**
 * In-memory session manager implementation.
 * Useful for testing, development, or single-instance deployments.
 *
 * Session identifiers and refresh credentials use independent cryptographic
 * UUIDs so public identifiers cannot expose bearer-token randomness.
 *
 * For production multi-instance deployments, implement SessionManager
 * with a shared storage backend (MongoDB, Redis, etc.)
 */
export class InMemorySessionManager implements SessionManager {
  private sessions = new Map<string, Session>()
  private config: AuthConfig
  private cleanupInterval: NodeJS.Timeout

  constructor(config: AuthConfig) {
    this.config = config
    // Clean up expired and revoked sessions every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000)
  }

  async createSession(
    userId: string,
    deviceInfo?: DeviceInfo,
  ): Promise<TokenPair> {
    const familyId = randomUUID()
    const token = randomUUID()
    const sessionId = randomUUID()

    const expiryDays = this.config.refreshTokenExpiryDays ?? 14
    const expiration = Math.floor(Date.now() / 1000) + expiryDays * 24 * 60 * 60

    const session: Session = {
      id: sessionId,
      userId,
      familyId,
      token,
      expiration,
      ...(deviceInfo === undefined ? {} : { deviceInfo }),
    }

    this.sessions.set(token, session)

    return this.buildTokenPair(token, userId, sessionId)
  }

  async refreshSession(
    refreshToken: string,
    deviceInfo?: DeviceInfo,
  ): Promise<TokenPair | null> {
    const session = this.sessions.get(refreshToken)

    if (!session || session.isRevoked) {
      return null
    }

    if (Date.now() / 1000 > session.expiration) {
      return null
    }

    // Token has already been used - check for theft
    if (session.replacedBy) {
      return this.handleReusedToken(session)
    }

    return this.rotateSession(session, deviceInfo)
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) {
        session.isRevoked = true
        return true
      }
    }
    return false
  }

  async revokeFamily(familyId: string): Promise<number> {
    let count = 0

    for (const session of this.sessions.values()) {
      if (session.familyId === familyId && !session.isRevoked) {
        session.isRevoked = true
        count++
      }
    }

    return count
  }

  async getUserSessions(userId: string): Promise<Session[]> {
    const now = Date.now() / 1000

    return Array.from(this.sessions.values()).filter(
      s =>
        s.userId === userId &&
        !s.isRevoked &&
        !s.replacedBy &&
        s.expiration > now,
    )
  }

  async revokeAllUserSessions(
    userId: string,
    exceptFamilyId?: string,
  ): Promise<number> {
    let count = 0

    for (const session of this.sessions.values()) {
      if (
        session.userId === userId &&
        !session.isRevoked &&
        (!exceptFamilyId || session.familyId !== exceptFamilyId)
      ) {
        session.isRevoked = true
        count++
      }
    }

    return count
  }

  /**
   * Handle a token that has already been rotated.
   * Implements grace period for concurrent requests,
   * but revokes entire family if reuse is detected outside grace period.
   */
  private handleReusedToken(session: Session): TokenPair | null {
    const graceSeconds = this.config.rotationGracePeriodSeconds ?? 15
    const now = Date.now()

    // Check if reuse is within grace period from when token was rotated
    if (!session.usedAt || now - session.usedAt > graceSeconds * 1000) {
      // Token reuse outside grace period indicates theft - revoke entire family
      this.revokeFamily(session.familyId)
      return null
    }

    // Within grace period - return the new token pair
    const nextSession = this.sessions.get(session.replacedBy!)
    if (!nextSession || nextSession.isRevoked) {
      return null
    }

    return this.buildTokenPair(
      nextSession.token,
      nextSession.userId,
      nextSession.id,
    )
  }

  /**
   * Rotate a session by creating a new token and marking the old one as replaced.
   */
  private async rotateSession(
    session: Session,
    deviceInfo?: DeviceInfo,
  ): Promise<TokenPair> {
    const newToken = randomUUID()
    const newSessionId = randomUUID()

    const expiryDays = this.config.refreshTokenExpiryDays ?? 14
    const expiration = Math.floor(Date.now() / 1000) + expiryDays * 24 * 60 * 60

    const newSession: Session = {
      id: newSessionId,
      userId: session.userId,
      familyId: session.familyId,
      token: newToken,
      expiration,
      ...(deviceInfo === undefined ? {} : { deviceInfo }),
    }

    // Mark old token as replaced and record when
    session.replacedBy = newToken
    session.usedAt = Date.now()
    this.sessions.set(newToken, newSession)

    return this.buildTokenPair(newToken, session.userId, newSessionId)
  }

  /**
   * Build a token pair with a signed access token.
   */
  private buildTokenPair(
    refreshToken: string,
    userId: string,
    sessionId: string,
  ): TokenPair {
    const expiryMinutes = this.config.accessTokenExpiryMinutes ?? 15
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + expiryMinutes * 60

    const payload: AccessTokenPayload = { userId, sessionId, iat, exp }
    const accessToken = signAccessToken(payload, this.config)

    return { accessToken, refreshToken, exp }
  }

  /**
   * Clean up expired and revoked sessions.
   */
  private cleanup(): void {
    const now = Date.now() / 1000

    for (const [key, session] of this.sessions) {
      if (session.isRevoked || session.expiration <= now) {
        this.sessions.delete(key)
      }
    }
  }

  /**
   * Stop the cleanup interval and clear sessions.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval)
    this.sessions.clear()
  }

  /**
   * Get the current session count (for monitoring).
   */
  get size(): number {
    return this.sessions.size
  }
}
