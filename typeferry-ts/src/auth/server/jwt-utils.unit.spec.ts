import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'

import type { AccessTokenPayload, AuthConfig } from '../types'
import { decodeToken, signAccessToken, verifyAccessToken } from './jwt-utils'

const SECRET = 'test-secret-key-for-signing'

function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: SECRET,
    accessTokenExpiryMinutes: 15,
    refreshTokenExpiryDays: 14,
    ...overrides,
  }
}

function makePayload(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    userId: 'user-123',
    sessionId: 'session-456',
    iat: now,
    exp: now + 900,
    ...overrides,
  }
}

describe('signAccessToken', () => {
  it('returns a signed JWT string', () => {
    const config = makeConfig()
    const payload = makePayload()
    const token = signAccessToken(payload, config)

    expect(typeof token).toBe('string')
    expect(token.split('.')).toHaveLength(3)
  })

  it('uses HS256 by default', () => {
    const config = makeConfig()
    const payload = makePayload()
    const token = signAccessToken(payload, config)
    const header = JSON.parse(
      Buffer.from(token.split('.')[0]!, 'base64url').toString(),
    )
    expect(header.alg).toBe('HS256')
  })

  it('respects custom algorithm', () => {
    const config = makeConfig({ algorithm: 'HS384' })
    const payload = makePayload()
    const token = signAccessToken(payload, config)
    const header = JSON.parse(
      Buffer.from(token.split('.')[0]!, 'base64url').toString(),
    )
    expect(header.alg).toBe('HS384')
  })

  it('embeds payload claims in the token', () => {
    const config = makeConfig()
    const payload = makePayload({ userId: 'alice', sessionId: 'sess-1' })
    const token = signAccessToken(payload, config)
    const decoded = jwt.decode(token) as any
    expect(decoded.userId).toBe('alice')
    expect(decoded.sessionId).toBe('sess-1')
  })
})

describe('verifyAccessToken', () => {
  it('verifies and returns payload for a valid token', () => {
    const config = makeConfig()
    const payload = makePayload()
    const token = signAccessToken(payload, config)

    const result = verifyAccessToken(token, config)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe(payload.userId)
    expect(result!.sessionId).toBe(payload.sessionId)
  })

  it('strips Bearer prefix before verifying', () => {
    const config = makeConfig()
    const payload = makePayload()
    const token = signAccessToken(payload, config)

    const result = verifyAccessToken(`Bearer ${token}`, config)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe(payload.userId)
  })

  it('strips bearer prefix case-insensitively', () => {
    const config = makeConfig()
    const payload = makePayload()
    const token = signAccessToken(payload, config)

    const result = verifyAccessToken(`bearer ${token}`, config)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe(payload.userId)
  })

  it('returns null for expired tokens', () => {
    const config = makeConfig({ accessTokenExpiryMinutes: 1 })
    const pastTime = Math.floor(Date.now() / 1000) - 3600
    const payload = makePayload({ iat: pastTime, exp: pastTime + 60 })
    // Sign the token directly with jwt to bypass any iat checks
    const token = jwt.sign(payload, config.secret, { algorithm: 'HS256' })

    const result = verifyAccessToken(token, config)
    expect(result).toBeNull()
  })

  it('returns null for token signed with wrong secret', () => {
    const config = makeConfig()
    const payload = makePayload()
    const token = jwt.sign(payload, 'wrong-secret', { algorithm: 'HS256' })

    const result = verifyAccessToken(token, config)
    expect(result).toBeNull()
  })

  it('returns null for algorithm mismatch', () => {
    const config = makeConfig({ algorithm: 'HS256' })
    const payload = makePayload()
    // Sign with HS384 but verify with HS256
    const token = jwt.sign(payload, config.secret, { algorithm: 'HS384' })

    const result = verifyAccessToken(token, config)
    expect(result).toBeNull()
  })

  it('returns null for malformed tokens', () => {
    const config = makeConfig()
    expect(verifyAccessToken('not-a-jwt', config)).toBeNull()
    expect(verifyAccessToken('', config)).toBeNull()
    expect(verifyAccessToken('a.b.c', config)).toBeNull()
  })

  it('rejects empty signing secrets on sign and verify', () => {
    const emptyConfig = makeConfig({ secret: '' })
    expect(() => signAccessToken(makePayload(), emptyConfig)).toThrow()

    const validToken = signAccessToken(makePayload(), makeConfig())
    expect(verifyAccessToken(validToken, emptyConfig)).toBeNull()
  })

  it('rejects tokens whose iat claim is beyond allowed future clock skew', () => {
    const config = makeConfig()
    const now = Math.floor(Date.now() / 1000)
    const token = jwt.sign(
      makePayload({ iat: now + 60, exp: now + 900 }),
      config.secret,
      { algorithm: 'HS256' },
    )
    expect(verifyAccessToken(token, config)).toBeNull()
  })

  it('uses default 15 minute maxAge when accessTokenExpiryMinutes is not set', () => {
    const config = makeConfig()
    delete (config as any).accessTokenExpiryMinutes
    const payload = makePayload()
    const token = signAccessToken(payload, config)

    const result = verifyAccessToken(token, config)
    expect(result).not.toBeNull()
  })

  it('round-trips with sign and verify', () => {
    const config = makeConfig()
    const payload = makePayload({ userId: 'round-trip-user', sessionId: 'rt-session' })
    const token = signAccessToken(payload, config)
    const verified = verifyAccessToken(token, config)

    expect(verified).not.toBeNull()
    expect(verified!.userId).toBe('round-trip-user')
    expect(verified!.sessionId).toBe('rt-session')
    expect(verified!.iat).toBe(payload.iat)
    expect(verified!.exp).toBe(payload.exp)
  })
})

describe('decodeToken', () => {
  it('decodes a valid token without verification', () => {
    const config = makeConfig()
    const payload = makePayload({ userId: 'decode-test' })
    const token = signAccessToken(payload, config)

    const decoded = decodeToken(token)
    expect(decoded).not.toBeNull()
    expect(decoded!.userId).toBe('decode-test')
  })

  it('strips Bearer prefix before decoding', () => {
    const config = makeConfig()
    const payload = makePayload()
    const token = signAccessToken(payload, config)

    const decoded = decodeToken(`Bearer ${token}`)
    expect(decoded).not.toBeNull()
    expect(decoded!.userId).toBe(payload.userId)
  })

  it('decodes expired tokens without error', () => {
    const pastTime = Math.floor(Date.now() / 1000) - 7200
    const payload = makePayload({ iat: pastTime, exp: pastTime + 60 })
    const token = jwt.sign(payload, SECRET, { algorithm: 'HS256' })

    const decoded = decodeToken(token)
    expect(decoded).not.toBeNull()
    expect(decoded!.userId).toBe(payload.userId)
    expect(decoded!.exp).toBeLessThan(Date.now() / 1000)
  })

  it('decodes tokens signed with a different secret', () => {
    const payload = makePayload({ userId: 'other-secret-user' })
    const token = jwt.sign(payload, 'completely-different-secret', {
      algorithm: 'HS256',
    })

    const decoded = decodeToken(token)
    expect(decoded).not.toBeNull()
    expect(decoded!.userId).toBe('other-secret-user')
  })

  it('returns null for completely malformed input', () => {
    expect(decodeToken('not-a-jwt')).toBeNull()
    expect(decodeToken('')).toBeNull()
  })
})
