import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClientEvents } from '../utils'
import { ContextManager, isTokenExpired } from './context-manager'

function createMockStorage(): Storage & { store: Record<string, string> } {
  const store: Record<string, string> = {}
  return {
    store,
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      Reflect.deleteProperty(store, key)
    }),
    clear: vi.fn(() => {
      for (const key of Object.keys(store)) {
        Reflect.deleteProperty(store, key)
      }
    }),
    get length() {
      return Object.keys(store).length
    },
    key: vi.fn(() => null),
  }
}

describe('ContextManager', () => {
  let manager: ContextManager
  let storage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    storage = createMockStorage()
    manager = new ContextManager(storage)
  })

  afterEach(() => {
    vi.clearAllMocks()
    manager.removeAllListeners()
  })

  describe('loadContext()', () => {
    it('should load and merge context from storage', () => {
      storage.store.context = JSON.stringify({ token: 'abc', userId: 'u1' })

      manager.loadContext()

      expect(manager.context).toEqual({ token: 'abc', userId: 'u1' })
    })

    it('should not emit CONTEXT_CHANGED when stored context matches in-memory', () => {
      const context = { token: 'abc', userId: 'u1' }
      manager.context = { ...context }
      storage.store.context = JSON.stringify(context)

      const spy = vi.fn()
      manager.on(ClientEvents.CONTEXT_CHANGED, spy)

      manager.loadContext()

      expect(spy).not.toHaveBeenCalled()
    })

    it('should emit CONTEXT_CHANGED when stored context differs from in-memory', () => {
      manager.context = { token: 'old' }
      storage.store.context = JSON.stringify({ token: 'old', userId: 'u1' })

      const spy = vi.fn()
      manager.on(ClientEvents.CONTEXT_CHANGED, spy)

      manager.loadContext()

      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('should do nothing when storage has no context', () => {
      manager.context = { token: 'keep' }

      const spy = vi.fn()
      manager.on(ClientEvents.CONTEXT_CHANGED, spy)

      manager.loadContext()

      expect(spy).not.toHaveBeenCalled()
      expect(manager.context).toEqual({ token: 'keep' })
    })

    it('should do nothing when no storage is provided', () => {
      const noStorageManager = new ContextManager()
      noStorageManager.context = { token: 'keep' }

      const spy = vi.fn()
      noStorageManager.on(ClientEvents.CONTEXT_CHANGED, spy)

      noStorageManager.loadContext()

      expect(spy).not.toHaveBeenCalled()
      expect(noStorageManager.context).toEqual({ token: 'keep' })
    })
  })

  describe('setContext()', () => {
    it('should replace context entirely', () => {
      manager.context = { old: 'data' }

      manager.setContext({ token: 'new' })

      expect(manager.context).toEqual({ token: 'new' })
    })

    it('should persist to storage', () => {
      manager.setContext({ token: 'new-token' })

      expect(storage.setItem).toHaveBeenCalledWith(
        'context',
        expect.any(String),
      )
    })

    it('should emit CONTEXT_CHANGED', () => {
      const spy = vi.fn()
      manager.on(ClientEvents.CONTEXT_CHANGED, spy)

      manager.setContext({ token: 'test' })

      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('should work without storage', () => {
      const noStorageManager = new ContextManager()

      noStorageManager.setContext({ token: 'test' })

      expect(noStorageManager.context).toEqual({ token: 'test' })
    })
  })

  describe('updateContext()', () => {
    it('should merge new keys into existing context', () => {
      manager.context = { token: 'tok' }

      manager.updateContext({ userId: 'u1' })

      expect(manager.context).toEqual({ token: 'tok', userId: 'u1' })
    })

    it('should emit CONTEXT_CHANGED when context values change', () => {
      manager.context = { token: 'old' }

      const spy = vi.fn()
      manager.on(ClientEvents.CONTEXT_CHANGED, spy)

      manager.updateContext({ token: 'new' })

      expect(spy).toHaveBeenCalledTimes(1)
      expect(manager.context.token).toBe('new')
    })

    it('should not emit CONTEXT_CHANGED when merged context is identical', () => {
      manager.context = { token: 'same', exp: 123 }

      const spy = vi.fn()
      manager.on(ClientEvents.CONTEXT_CHANGED, spy)

      manager.updateContext({ token: 'same', exp: 123 })

      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('clearContext()', () => {
    it('should reset context to empty object', () => {
      manager.context = { token: 'test', userId: 'u1' }

      manager.clearContext()

      expect(manager.context).toEqual({})
    })

    it('should remove from storage', () => {
      manager.context = { token: 'test' }

      manager.clearContext()

      expect(storage.removeItem).toHaveBeenCalledWith('context')
    })

    it('should emit CONTEXT_CHANGED', () => {
      const spy = vi.fn()
      manager.on(ClientEvents.CONTEXT_CHANGED, spy)

      manager.clearContext()

      expect(spy).toHaveBeenCalledTimes(1)
    })
  })
})

describe('isTokenExpired', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return false when context has no exp', () => {
    expect(isTokenExpired({})).toBe(false)
    expect(isTokenExpired({ token: 'abc' })).toBe(false)
  })

  it('should detect expired token using legacy exp-only check', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(isTokenExpired({ exp: now - 10 })).toBe(true)
  })

  it('should detect valid token using legacy exp-only check', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(isTokenExpired({ exp: now + 300 })).toBe(false)
  })

  it('matches server expiry at the exact exp second', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)

    expect(isTokenExpired({ exp: Date.now() / 1000 })).toBe(true)
  })

  it('matches server expiry at the exact elapsed lifetime with clock skew', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)

    expect(isTokenExpired({
      iat: 500_000,
      exp: 500_900,
      _tokenReceivedAt: Date.now() - 900_000,
    })).toBe(true)
  })

  it('should use clock-skew-safe check when iat and _tokenReceivedAt are present', () => {
    vi.useFakeTimers()
    const nowMs = 1_000_000_000_000
    vi.setSystemTime(nowMs)

    const serverIat = 900_000 // server clock is behind
    const serverExp = serverIat + 900 // 15 min TTL
    const tokenReceivedAt = nowMs // received just now in client time

    // Without clock-skew fix, exp (900900) < now/1000 (1000000) → would be "expired"
    // With fix: TTL = 900s, elapsed = 0 → NOT expired
    expect(
      isTokenExpired({
        exp: serverExp,
        iat: serverIat,
        _tokenReceivedAt: tokenReceivedAt,
      }),
    ).toBe(false)
  })

  it('should detect expiry via clock-skew-safe check when TTL is exceeded', () => {
    vi.useFakeTimers()
    const nowMs = 1_000_000_000_000
    vi.setSystemTime(nowMs)

    const tokenReceivedAt = nowMs - 1_000_000 // received 1000s ago
    const serverIat = 500_000
    const serverExp = serverIat + 900 // 15 min TTL — 900s < 1000s elapsed

    expect(
      isTokenExpired({
        exp: serverExp,
        iat: serverIat,
        _tokenReceivedAt: tokenReceivedAt,
      }),
    ).toBe(true)
  })
})
