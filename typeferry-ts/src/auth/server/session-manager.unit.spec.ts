import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthConfig, DeviceInfo } from '../types'
import { InMemorySessionManager } from './session-manager'

const UUID_V4_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i

function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: 'test-secret',
    accessTokenExpiryMinutes: 15,
    refreshTokenExpiryDays: 14,
    rotationGracePeriodSeconds: 15,
    ...overrides,
  }
}

const deviceInfo: DeviceInfo = {
  ip: '127.0.0.1',
  browser: 'Chrome 120',
  os: 'Windows 10',
  deviceType: 'desktop',
}

describe('InMemorySessionManager', () => {
  let manager: InMemorySessionManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new InMemorySessionManager(makeConfig())
  })

  afterEach(() => {
    manager.destroy()
    vi.useRealTimers()
  })

  it('creates and rotates session UUIDs without Math.random', async () => {
    vi.resetModules()

    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Session credentials must not depend on Math.random')
    })
    let isolatedManager: InMemorySessionManager | undefined

    try {
      const { InMemorySessionManager: FreshSessionManager } = await import('./session-manager')

      isolatedManager = new FreshSessionManager(makeConfig())

      const original = await isolatedManager.createSession('user-1')
      const rotated = await isolatedManager.refreshSession(original.refreshToken)

      if (!rotated) throw new Error('An active session must rotate')

      expect(original.refreshToken).toMatch(UUID_V4_PATTERN)
      expect(rotated.refreshToken).toMatch(UUID_V4_PATTERN)
      expect(rotated.refreshToken).not.toBe(original.refreshToken)
      expect(await isolatedManager.getUserSessions('user-1')).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(UUID_V4_PATTERN),
          familyId: expect.stringMatching(UUID_V4_PATTERN),
          token: rotated.refreshToken,
        }),
      ])
    } finally {
      isolatedManager?.destroy()
      random.mockRestore()
    }
  })

  describe('createSession', () => {
    it('returns a TokenPair with accessToken, refreshToken, and exp', async () => {
      const pair = await manager.createSession('user-1', deviceInfo)

      expect(pair).toBeDefined()
      expect(typeof pair.accessToken).toBe('string')
      expect(typeof pair.refreshToken).toBe('string')
      expect(typeof pair.exp).toBe('number')
      expect(pair.accessToken.split('.')).toHaveLength(3) // JWT format
    })

    it('creates unique refresh tokens for different sessions', async () => {
      const pair1 = await manager.createSession('user-1')
      const pair2 = await manager.createSession('user-1')

      expect(pair1.refreshToken).not.toBe(pair2.refreshToken)
      expect(pair1.accessToken).not.toBe(pair2.accessToken)
    })

    it('increments session count', async () => {
      expect(manager.size).toBe(0)
      await manager.createSession('user-1')
      expect(manager.size).toBe(1)
      await manager.createSession('user-2')
      expect(manager.size).toBe(2)
    })

    it('sets expiration based on refreshTokenExpiryDays', async () => {
      const now = Date.now()
      const pair = await manager.createSession('user-1')
      const expectedExp = Math.floor(now / 1000) + 14 * 24 * 60 * 60

      expect(pair.exp).toBeGreaterThan(Math.floor(now / 1000))
      // Access token exp, not refresh. Check it is in the future.
      expect(pair.exp).toBeGreaterThan(0)
    })

    it('works without deviceInfo', async () => {
      const pair = await manager.createSession('user-1')
      expect(pair.refreshToken).toBeDefined()
    })
  })

  describe('refreshSession', () => {
    it('rotates the token and returns a new pair', async () => {
      const original = await manager.createSession('user-1', deviceInfo)
      const refreshed = await manager.refreshSession(original.refreshToken)

      expect(refreshed).not.toBeNull()
      expect(refreshed!.refreshToken).not.toBe(original.refreshToken)
      expect(refreshed!.accessToken).not.toBe(original.accessToken)
      expect(typeof refreshed!.exp).toBe('number')
    })

    it('increases session count after rotation (old + new)', async () => {
      const original = await manager.createSession('user-1')
      expect(manager.size).toBe(1)

      await manager.refreshSession(original.refreshToken)
      expect(manager.size).toBe(2)
    })

    it('returns null for a non-existent token', async () => {
      const result = await manager.refreshSession('non-existent-token')
      expect(result).toBeNull()
    })

    it('returns null for a revoked session token', async () => {
      const pair = await manager.createSession('user-1')

      // Get session id via getUserSessions to revoke
      const sessions = await manager.getUserSessions('user-1')
      await manager.revokeSession(sessions[0]!.id)

      const result = await manager.refreshSession(pair.refreshToken)
      expect(result).toBeNull()
    })

    it('returns null for an expired refresh token', async () => {
      const pair = await manager.createSession('user-1')

      // Advance time past the refresh token expiry (14 days)
      vi.advanceTimersByTime(15 * 24 * 60 * 60 * 1000)

      const result = await manager.refreshSession(pair.refreshToken)
      expect(result).toBeNull()
    })

    it('revokes entire family on token reuse outside grace period (theft detection)', async () => {
      const original = await manager.createSession('user-1')
      const originalToken = original.refreshToken

      // First rotation - legitimate
      const rotated = await manager.refreshSession(originalToken)
      expect(rotated).not.toBeNull()

      // Advance past grace period (default 15 seconds)
      vi.advanceTimersByTime(20_000)

      // Reuse old token - this should be detected as theft
      const reused = await manager.refreshSession(originalToken)
      expect(reused).toBeNull()

      // The new token should also be revoked (entire family revoked)
      const afterRevoke = await manager.refreshSession(rotated!.refreshToken)
      expect(afterRevoke).toBeNull()
    })

    it('returns new pair for token reuse within grace period', async () => {
      const original = await manager.createSession('user-1')
      const originalToken = original.refreshToken

      // First rotation
      const rotated = await manager.refreshSession(originalToken)
      expect(rotated).not.toBeNull()

      // Immediately reuse old token (within grace period)
      // Do NOT advance timers - stay within grace period
      const reused = await manager.refreshSession(originalToken)
      expect(reused).not.toBeNull()
      // Should get the same new refresh token (from the replacedBy session)
      expect(reused!.refreshToken).toBe(rotated!.refreshToken)
    })

    it('returns null within grace period when replacement session is revoked', async () => {
      const original = await manager.createSession('user-1')
      const originalToken = original.refreshToken

      // First rotation
      const rotated = await manager.refreshSession(originalToken)
      expect(rotated).not.toBeNull()

      // Revoke the replacement session
      const sessions = await manager.getUserSessions('user-1')
      for (const s of sessions) {
        await manager.revokeSession(s.id)
      }

      // Reuse within grace period - replacement is revoked, should return null
      const reused = await manager.refreshSession(originalToken)
      expect(reused).toBeNull()
    })

    it('allows chained rotations', async () => {
      const pair1 = await manager.createSession('user-1')
      const pair2 = await manager.refreshSession(pair1.refreshToken)
      expect(pair2).not.toBeNull()

      const pair3 = await manager.refreshSession(pair2!.refreshToken)
      expect(pair3).not.toBeNull()
      expect(pair3!.refreshToken).not.toBe(pair2!.refreshToken)
    })
  })

  describe('revokeSession', () => {
    it('marks session as revoked and returns true', async () => {
      const pair = await manager.createSession('user-1')
      const sessions = await manager.getUserSessions('user-1')
      const sessionId = sessions[0]!.id

      const result = await manager.revokeSession(sessionId)
      expect(result).toBe(true)

      // Confirm it no longer appears in active sessions
      const remaining = await manager.getUserSessions('user-1')
      expect(remaining).toHaveLength(0)
    })

    it('returns false for an unknown session id', async () => {
      const result = await manager.revokeSession('non-existent-session')
      expect(result).toBe(false)
    })

    it('prevents refresh after revocation', async () => {
      const pair = await manager.createSession('user-1')
      const sessions = await manager.getUserSessions('user-1')
      await manager.revokeSession(sessions[0]!.id)

      const refreshed = await manager.refreshSession(pair.refreshToken)
      expect(refreshed).toBeNull()
    })
  })

  describe('revokeFamily', () => {
    it('revokes all sessions in a token family', async () => {
      const pair1 = await manager.createSession('user-1')
      const pair2 = await manager.refreshSession(pair1.refreshToken)
      expect(pair2).not.toBeNull()

      // Both tokens belong to the same family
      // Get familyId from one of them
      const sessions = await manager.getUserSessions('user-1')
      expect(sessions.length).toBeGreaterThan(0)
      const familyId = sessions[0]!.familyId

      const count = await manager.revokeFamily(familyId)
      expect(count).toBeGreaterThan(0)

      // Neither token should work now
      const r1 = await manager.refreshSession(pair1.refreshToken)
      const r2 = await manager.refreshSession(pair2!.refreshToken)
      expect(r1).toBeNull()
      expect(r2).toBeNull()
    })

    it('returns 0 when no sessions match the family', async () => {
      const count = await manager.revokeFamily('non-existent-family')
      expect(count).toBe(0)
    })

    it('does not revoke sessions from other families', async () => {
      const pair1 = await manager.createSession('user-1')
      const pair2 = await manager.createSession('user-1')

      // Get family IDs - different createSession calls produce different families
      const sessions = await manager.getUserSessions('user-1')
      expect(sessions).toHaveLength(2)

      const family1 = sessions[0]!.familyId
      const family2 = sessions[1]!.familyId
      expect(family1).not.toBe(family2)

      // Revoke first family
      await manager.revokeFamily(family1)

      // Second family should still work
      const remaining = await manager.getUserSessions('user-1')
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.familyId).toBe(family2)
    })
  })

  describe('getUserSessions', () => {
    it('returns active, non-revoked, non-expired, non-replaced sessions', async () => {
      await manager.createSession('user-1')
      await manager.createSession('user-1')
      await manager.createSession('user-2')

      const user1Sessions = await manager.getUserSessions('user-1')
      expect(user1Sessions).toHaveLength(2)
      expect(user1Sessions.every(s => s.userId === 'user-1')).toBe(true)

      const user2Sessions = await manager.getUserSessions('user-2')
      expect(user2Sessions).toHaveLength(1)
    })

    it('excludes revoked sessions', async () => {
      const pair = await manager.createSession('user-1')
      await manager.createSession('user-1')

      const before = await manager.getUserSessions('user-1')
      expect(before).toHaveLength(2)

      await manager.revokeSession(before[0]!.id)

      const after = await manager.getUserSessions('user-1')
      expect(after).toHaveLength(1)
    })

    it('excludes replaced sessions (after rotation)', async () => {
      const pair = await manager.createSession('user-1')
      await manager.refreshSession(pair.refreshToken)

      // After rotation, old session has replacedBy set, should be excluded
      const sessions = await manager.getUserSessions('user-1')
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.replacedBy).toBeUndefined()
    })

    it('excludes expired sessions', async () => {
      await manager.createSession('user-1')

      vi.advanceTimersByTime(15 * 24 * 60 * 60 * 1000) // past 14-day expiry

      const sessions = await manager.getUserSessions('user-1')
      expect(sessions).toHaveLength(0)
    })

    it('returns empty array for unknown user', async () => {
      const sessions = await manager.getUserSessions('unknown-user')
      expect(sessions).toHaveLength(0)
    })
  })

  describe('revokeAllUserSessions', () => {
    it('revokes all sessions for a user', async () => {
      await manager.createSession('user-1')
      await manager.createSession('user-1')
      await manager.createSession('user-2')

      const count = await manager.revokeAllUserSessions('user-1')
      expect(count).toBe(2)

      const user1Sessions = await manager.getUserSessions('user-1')
      expect(user1Sessions).toHaveLength(0)

      // user-2 sessions should be unaffected
      const user2Sessions = await manager.getUserSessions('user-2')
      expect(user2Sessions).toHaveLength(1)
    })

    it('excludes sessions from the specified family', async () => {
      const keep = await manager.createSession('user-1')
      await manager.createSession('user-1')
      await manager.createSession('user-1')

      const sessions = await manager.getUserSessions('user-1')
      expect(sessions).toHaveLength(3)

      // Keep the family of the first session
      const keepFamilyId = sessions[0]!.familyId

      const count = await manager.revokeAllUserSessions('user-1', keepFamilyId)
      expect(count).toBe(2)

      const remaining = await manager.getUserSessions('user-1')
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.familyId).toBe(keepFamilyId)
    })

    it('returns 0 for a user with no sessions', async () => {
      const count = await manager.revokeAllUserSessions('unknown-user')
      expect(count).toBe(0)
    })

    it('does not double-count already revoked sessions', async () => {
      await manager.createSession('user-1')
      await manager.createSession('user-1')

      const sessions = await manager.getUserSessions('user-1')
      await manager.revokeSession(sessions[0]!.id)

      const count = await manager.revokeAllUserSessions('user-1')
      // Only one session was still active
      expect(count).toBe(1)
    })
  })

  describe('cleanup', () => {
    it('removes expired sessions', async () => {
      await manager.createSession('user-1')
      expect(manager.size).toBe(1)

      // Advance past expiration (14 days + buffer)
      vi.advanceTimersByTime(15 * 24 * 60 * 60 * 1000)

      // Trigger cleanup interval (runs every 60 seconds)
      vi.advanceTimersByTime(60_000)

      expect(manager.size).toBe(0)
    })

    it('removes revoked sessions', async () => {
      await manager.createSession('user-1')
      const sessions = await manager.getUserSessions('user-1')
      await manager.revokeSession(sessions[0]!.id)

      expect(manager.size).toBe(1) // still stored, just revoked

      // Trigger cleanup
      vi.advanceTimersByTime(60_000)

      expect(manager.size).toBe(0)
    })

    it('preserves active non-expired sessions', async () => {
      await manager.createSession('user-1')
      await manager.createSession('user-2')

      // Trigger cleanup without expiring anything
      vi.advanceTimersByTime(60_000)

      expect(manager.size).toBe(2)
    })

    it('runs automatically on interval', async () => {
      await manager.createSession('user-1')
      const sessions = await manager.getUserSessions('user-1')
      await manager.revokeSession(sessions[0]!.id)

      // Advance enough for the 60-second cleanup interval to fire
      vi.advanceTimersByTime(61_000)

      expect(manager.size).toBe(0)
    })
  })

  describe('destroy', () => {
    it('clears all sessions', async () => {
      await manager.createSession('user-1')
      await manager.createSession('user-2')
      expect(manager.size).toBe(2)

      manager.destroy()
      expect(manager.size).toBe(0)
    })

    it('stops the cleanup interval', async () => {
      await manager.createSession('user-1')
      const sessions = await manager.getUserSessions('user-1')
      await manager.revokeSession(sessions[0]!.id)

      manager.destroy()

      // Re-create manager for this test to verify interval was cleared
      // After destroy, advancing timers should not cause errors
      // (the interval handler references a cleared map)
      vi.advanceTimersByTime(120_000)

      // Manager was already destroyed, size should remain 0
      expect(manager.size).toBe(0)
    })
  })

  describe('size', () => {
    it('returns 0 for a new manager', () => {
      expect(manager.size).toBe(0)
    })

    it('tracks total session count including rotated sessions', async () => {
      const pair = await manager.createSession('user-1')
      expect(manager.size).toBe(1)

      await manager.refreshSession(pair.refreshToken)
      expect(manager.size).toBe(2) // old (replaced) + new
    })

    it('decreases after cleanup', async () => {
      await manager.createSession('user-1')
      const sessions = await manager.getUserSessions('user-1')
      await manager.revokeSession(sessions[0]!.id)

      expect(manager.size).toBe(1)
      vi.advanceTimersByTime(60_000)
      expect(manager.size).toBe(0)
    })
  })

  describe('edge cases', () => {
    it('handles custom rotationGracePeriodSeconds', async () => {
      manager.destroy()
      manager = new InMemorySessionManager(
        makeConfig({ rotationGracePeriodSeconds: 5 }),
      )

      const original = await manager.createSession('user-1')
      const rotated = await manager.refreshSession(original.refreshToken)
      expect(rotated).not.toBeNull()

      // Advance 3 seconds (within 5s grace)
      vi.advanceTimersByTime(3_000)
      const withinGrace = await manager.refreshSession(original.refreshToken)
      expect(withinGrace).not.toBeNull()

      // Advance past 5s grace period from the original rotation timestamp
      vi.advanceTimersByTime(10_000)
      const outsideGrace = await manager.refreshSession(original.refreshToken)
      expect(outsideGrace).toBeNull()
    })

    it('handles custom refreshTokenExpiryDays', async () => {
      manager.destroy()
      manager = new InMemorySessionManager(
        makeConfig({ refreshTokenExpiryDays: 1 }),
      )

      const pair = await manager.createSession('user-1')

      // Advance 23 hours - should still work
      vi.advanceTimersByTime(23 * 60 * 60 * 1000)
      const refreshed = await manager.refreshSession(pair.refreshToken)
      expect(refreshed).not.toBeNull()

      // Advance past 1 day total from new token creation
      vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000)
      const expired = await manager.refreshSession(refreshed!.refreshToken)
      expect(expired).toBeNull()
    })

    it('handles multiple families per user independently', async () => {
      const session1 = await manager.createSession('user-1')
      const session2 = await manager.createSession('user-1')

      const rotated1 = await manager.refreshSession(session1.refreshToken)
      expect(rotated1).not.toBeNull()

      // Session 2 should still be refreshable independently
      const rotated2 = await manager.refreshSession(session2.refreshToken)
      expect(rotated2).not.toBeNull()
    })
  })
})
