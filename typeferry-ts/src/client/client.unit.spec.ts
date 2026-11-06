import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClientEvents, Errors, NO_CHANNEL } from '../utils'
import { Client } from './client'

// Mock ClientSocket as a class
vi.mock('./client-socket', () => ({
  ClientSocket: class MockClientSocket {
    ready = true
    connecting = false
    stopped = false
    socket = null
    connect = vi.fn()
    close = vi.fn().mockResolvedValue(undefined)
    send = vi.fn()
    clearReconnectTimer = vi.fn()
    retireConnection = vi.fn()
  },
}))

// Mock IdleTimer and VisibilityManager as constructor functions
vi.mock('./idle-timer', () => ({
  IdleTimer: class MockIdleTimer {
    start = vi.fn()
    stop = vi.fn()
    reset = vi.fn()
    destroy = vi.fn()
  },
}))

vi.mock('./visibility-manager', () => ({
  VisibilityManager: class MockVisibilityManager {
    reconnect = vi.fn()
    destroy = vi.fn()
  },
}))

describe('Client', () => {
  describe('initialize()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('should preserve authenticated state set before initialize', async () => {
      client.authenticated = true
      client.initializing = false

      await client.initialize()

      expect(client.authenticated).toBe(true)
      expect(client.initialized).toBe(true)
    })

    it('should preserve unauthenticated state set before initialize', async () => {
      client.authenticated = false
      client.initializing = false

      await client.initialize()

      expect(client.authenticated).toBe(false)
      expect(client.initialized).toBe(true)
    })

    it('should emit INITIALIZED event after initialization completes', async () => {
      client.authenticated = true
      client.initializing = false

      const initPromise = new Promise<boolean>(resolve => {
        client.once(ClientEvents.INITIALIZED, authenticated =>
          resolve(authenticated),
        )
      })

      await client.initialize()
      const authenticated = await initPromise

      expect(client.initialized).toBe(true)
      expect(client.initializing).toBe(false)
      expect(authenticated).toBe(true)
    })

    it('should emit INITIALIZING event before initialization', async () => {
      client.initializing = false

      const events: string[] = []
      client.once(ClientEvents.INITIALIZING, () => events.push('initializing'))
      client.once(ClientEvents.INITIALIZED, () => events.push('initialized'))

      await client.initialize()

      expect(events).toEqual(['initializing', 'initialized'])
    })

    it('should wait for existing initialization if already initializing', async () => {
      client.initializing = true

      const initPromise = client.initialize()

      // Emit initialized to unblock the waiting initialize
      setTimeout(() => {
        client.initializing = false
        client.emit(ClientEvents.INITIALIZED, true)
      }, 10)

      await initPromise
    })

    it('should load context from localStorage during initialization', async () => {
      const savedContext = { token: 'saved-token', userId: 'user-123' }
      localStorage.setItem('context', JSON.stringify(savedContext))

      client.initializing = false
      client.context = {}

      await client.initialize()

      expect(localStorage.getItem).toHaveBeenCalledWith('context')
    })
  })

  describe('clearContext()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('should clear context and emit CONTEXT_CHANGED event', async () => {
      client.context = { token: 'test', userId: 'user-123' }

      const eventPromise = new Promise<void>(resolve => {
        client.once(ClientEvents.CONTEXT_CHANGED, () => resolve())
      })

      client.clearContext()

      await eventPromise

      expect(client.context).toEqual({})
      expect(localStorage.removeItem).toHaveBeenCalledWith('context')
    })
  })

  describe('loadContext()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('should not emit CONTEXT_CHANGED when stored context matches in-memory', () => {
      const context = { token: 'abc', userId: 'u1' }
      client.context = { ...context }
      localStorage.setItem('context', JSON.stringify(context))

      const spy = vi.fn()
      client.on(ClientEvents.CONTEXT_CHANGED, spy)

      client.loadContext()

      expect(spy).not.toHaveBeenCalled()
    })

    it('should emit CONTEXT_CHANGED when stored context differs from in-memory', () => {
      client.context = { token: 'old' }
      localStorage.setItem(
        'context',
        JSON.stringify({ token: 'old', userId: 'u1' }),
      )

      const spy = vi.fn()
      client.on(ClientEvents.CONTEXT_CHANGED, spy)

      client.loadContext()

      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('should do nothing when localStorage has no context', () => {
      client.context = { token: 'keep' }

      const spy = vi.fn()
      client.on(ClientEvents.CONTEXT_CHANGED, spy)

      client.loadContext()

      expect(spy).not.toHaveBeenCalled()
      expect(client.context).toEqual({ token: 'keep' })
    })
  })

  describe('setContext()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('should set context and persist to localStorage', () => {
      const newContext = { token: 'new-token', userId: 'user-456' }

      client.setContext(newContext)

      expect(client.context).toEqual(newContext)
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'context',
        expect.any(String),
      )
    })

    it('should emit CONTEXT_CHANGED event', async () => {
      const eventPromise = new Promise<void>(resolve => {
        client.once(ClientEvents.CONTEXT_CHANGED, () => resolve())
      })

      client.setContext({ token: 'test' })

      await eventPromise
    })
  })

  describe('updateContext()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('should emit CONTEXT_CHANGED when context values change', () => {
      client.context = { token: 'old' }

      const spy = vi.fn()
      client.on(ClientEvents.CONTEXT_CHANGED, spy)

      client.updateContext({ token: 'new' })

      expect(spy).toHaveBeenCalledTimes(1)
      expect(client.context.token).toBe('new')
    })

    it('should not emit CONTEXT_CHANGED when merged context is identical', () => {
      client.context = { token: 'same', exp: 123 }

      const spy = vi.fn()
      client.on(ClientEvents.CONTEXT_CHANGED, spy)

      client.updateContext({ token: 'same', exp: 123 })

      expect(spy).not.toHaveBeenCalled()
    })

    it('should merge new keys into existing context', () => {
      client.context = { token: 'tok' }

      client.updateContext({ userId: 'u1' })

      expect(client.context).toEqual({ token: 'tok', userId: 'u1' })
    })
  })

  describe('setContextAndReInit()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('should skip setContext when context is identical', () => {
      const ctx = { token: 'tok', exp: 999 }
      client.context = { ...ctx }

      const spy = vi.fn()
      client.on(ClientEvents.CONTEXT_CHANGED, spy)

      // setContextAndReInit will try to reconnect (calls socket.disconnect/connect)
      // and then waitFor INITIALIZED — we just need to test the setContext skip.
      // Manually emit INITIALIZED to unblock the promise.
      const promise = client.setContextAndReInit(ctx)
      setTimeout(() => client.emit(ClientEvents.INITIALIZED), 10)

      return promise.then(() => {
        expect(spy).not.toHaveBeenCalled()
      })
    })

    it('should call setContext when context differs', () => {
      client.context = { token: 'old' }

      const spy = vi.fn()
      client.on(ClientEvents.CONTEXT_CHANGED, spy)

      const promise = client.setContextAndReInit({ token: 'new' })
      setTimeout(() => client.emit(ClientEvents.INITIALIZED), 10)

      return promise.then(() => {
        expect(spy).toHaveBeenCalledTimes(1)
        expect(client.context).toEqual({ token: 'new' })
      })
    })
  })

  describe('executeCall error handler', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('calls errorHandler when WebSocket call throws', async () => {
      const errorHandler = vi.fn()
      client.errorHandler = errorHandler
      client.initialized = true

      // Make clientSocket.ready true so it takes the WebSocket path
      ;(client.clientSocket as any).ready = true

      const testError = new Error('rpc failed')
      ;(client.clientSocket as any).emitWithAck = vi.fn().mockRejectedValue(testError)

      await expect(
        client.call('some.method', {}, { httpFallback: false }),
      ).rejects.toThrow('rpc failed')

      expect(errorHandler).toHaveBeenCalledWith(testError)
    })

    it('does not call errorHandler when none configured and WebSocket throws', async () => {
      client.errorHandler = null
      client.initialized = true

      ;(client.clientSocket as any).ready = true
      ;(client.clientSocket as any).emitWithAck = vi.fn().mockRejectedValue(new Error('rpc failed'))

      await expect(
        client.call('some.method', {}, { httpFallback: false }),
      ).rejects.toThrow('rpc failed')
    })
  })

  describe('channel()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('returns null for falsy name', () => {
      expect(client.channel(null as any)).toBeNull()
      expect(client.channel('' as any)).toBeNull()
    })

    it('returns self for NO_CHANNEL', () => {
      expect(client.channel('NO_CHANNEL')).toBe(client)
    })

    it('creates and caches a new ClientChannel for a string name', () => {
      const ch = client.channel('my-channel')!
      expect(ch).toBeTruthy()
      expect(ch).not.toBe(client)

      // Second call returns same instance
      expect(client.channel('my-channel')).toBe(ch)
    })

    it('handles ObjectId-like objects by converting to string', () => {
      const objectId = {
        constructor: { name: 'ObjectId' },
        toString: () => 'abc123',
      }
      // Manually set the constructor name
      Object.defineProperty(objectId.constructor, 'name', { value: 'ObjectId' })

      const ch = client.channel(objectId)!
      expect(ch).toBeTruthy()

      // Calling again with same string should return cached channel
      expect(client.channel('abc123')).toBe(ch)
    })
  })

  describe('isConnected()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('resolves immediately when already connected', async () => {
      ;(client.clientSocket as any).ready = true
      const result = await client.isConnected()
      expect(result).toBe(true)
    })

    it('resolves after INITIALIZED event when not yet connected', async () => {
      ;(client.clientSocket as any).ready = false

      const promise = client.isConnected()
      setTimeout(() => client.emit(ClientEvents.INITIALIZED), 10)

      const result = await promise
      expect(result).toBe(true)
    })
  })

  describe('fetch()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')))

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('passes credentials include and token header', async () => {
      client.setContext({ token: 'my-token' })

      await client.fetch('https://example.com/api')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/api',
        expect.objectContaining({
          credentials: 'include',
          headers: expect.objectContaining({
            'x-api-key': 'my-token',
          }),
        }),
      )
    })

    it('merges custom options', async () => {
      client.setContext({ token: 'tok' })

      await client.fetch('https://example.com', { method: 'POST' })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
        }),
      )
    })
  })

  describe('connection state properties', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('isConnecting reflects clientSocket.connecting', () => {
      ;(client.clientSocket as any).connecting = false
      expect(client.isConnecting).toBe(false)

      ;(client.clientSocket as any).connecting = true
      expect(client.isConnecting).toBe(true)
    })

    it('isOffline reflects !clientSocket.ready', () => {
      ;(client.clientSocket as any).ready = true
      expect(client.isOffline).toBe(false)

      ;(client.clientSocket as any).ready = false
      expect(client.isOffline).toBe(true)
    })

    it('isOnline reflects clientSocket.ready', () => {
      ;(client.clientSocket as any).ready = true
      expect(client.isOnline).toBe(true)

      ;(client.clientSocket as any).ready = false
      expect(client.isOnline).toBe(false)
    })
  })

  describe('logout()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('clears auth state and emits LOGOUT event', async () => {
      client.initialized = true
      client.authenticated = true
      ;(client.clientSocket as any).ready = true
      ;(client.clientSocket as any).emitWithAck = vi
        .fn()
        .mockResolvedValue(undefined)

      const logoutSpy = vi.fn()
      client.on(ClientEvents.LOGOUT, logoutSpy)

      await client.logout()

      expect(client.authenticated).toBe(false)
      expect(logoutSpy).toHaveBeenCalledWith(false)
    })
  })

  describe('login()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('throws AUTHENTICATION_FAILED when response is empty', async () => {
      client.initialized = true
      ;(client.clientSocket as any).ready = false

      // Mock HTTP request to return empty object
      ;(client.clientHttp as any).request = vi
        .fn()
        .mockImplementation((_payload: any, resolve: any) => resolve({}))

      await expect(
        client.login({ username: 'test', password: 'pass' }),
      ).rejects.toThrow(Errors.AUTHENTICATION_FAILED)
    })

    it('throws AUTHENTICATION_FAILED when response is null/falsy', async () => {
      client.initialized = true
      ;(client.clientSocket as any).ready = false

      ;(client.clientHttp as any).request = vi
        .fn()
        .mockImplementation((_payload: any, resolve: any) => resolve(null))

      await expect(
        client.login({ username: 'test', password: 'pass' }),
      ).rejects.toThrow(Errors.AUTHENTICATION_FAILED)
    })

    it('calls setContextAndReInit when response is a plain object', async () => {
      client.initialized = true
      ;(client.clientSocket as any).ready = false

      const loginResponse = { token: 'new-token', userId: 'u1' }
      ;(client.clientHttp as any).request = vi
        .fn()
        .mockImplementation((_payload: any, resolve: any) =>
          resolve(loginResponse),
        )

      const setContextSpy = vi.spyOn(client, 'setContextAndReInit')
      setContextSpy.mockResolvedValue(undefined)

      await client.login({ username: 'test', password: 'pass' })

      expect(setContextSpy).toHaveBeenCalledWith(loginResponse)
    })
  })

  describe('void()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('sends via WebSocket when socket is ready', async () => {
      ;(client.clientSocket as any).ready = true

      await client.void('test.method', { key: 'value' })

      expect(client.clientSocket.send).toHaveBeenCalledWith('rpc:void', {
        method: 'test.method',
        params: { key: 'value' },
      })
    })

    it('falls back to HTTP when socket is not ready', () => {
      ;(client.clientSocket as any).ready = false
      ;(client.clientHttp as any).request = vi.fn()

      // void() returns a promise that won't resolve for HTTP path
      // (resolve is null), so just call and check the request was made
      client.void('test.method', { key: 'val' })

      expect((client.clientHttp as any).request).toHaveBeenCalled()
    })

    it('uses HTTP when http option is set', () => {
      ;(client.clientSocket as any).ready = true
      ;(client.clientHttp as any).request = vi.fn()

      client.void('test.method', {}, { http: true })

      expect((client.clientHttp as any).request).toHaveBeenCalled()
    })
  })

  describe('handleEvent()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('emits INBOUND_MESSAGE and forwards event to channel', () => {
      const inboundSpy = vi.fn()
      client.on(ClientEvents.INBOUND_MESSAGE, inboundSpy)

      const payload = {
        channel: NO_CHANNEL,
        event: 'test-event',
        params: { data: 42 },
      }

      const eventSpy = vi.fn()
      client.on('test-event', eventSpy)

      client.handleEvent(payload as any)

      expect(inboundSpy).toHaveBeenCalledWith(payload)
      expect(eventSpy).toHaveBeenCalledWith({ data: 42 })
    })

    it('forwards event to named channel', () => {
      const ch = client.channel('my-channel')!
      const eventSpy = vi.fn()
      ch.on('some-event', eventSpy)

      client.handleEvent({
        channel: 'my-channel',
        event: 'some-event',
        params: { value: 'test' },
      } as any)

      expect(eventSpy).toHaveBeenCalledWith({ value: 'test' })
    })
  })

  describe('href()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('builds a URL from path segments', () => {
      const url = client.href('api', 'users')
      expect(url).toContain('/api/users')
    })

    it('appends query string from last plain object argument', () => {
      const url = client.href('api', 'users', { page: 1, limit: 10 })
      expect(url).toContain('?')
      expect(url).toContain('page=1')
      expect(url).toContain('limit=10')
    })

    it('preserves query serialization for structured scalar values', () => {
      const url = client.href('api', 'search', {
        active: true,
        empty: null,
        labels: ['security review', 'release'],
        query: 'TypeFerry & ExampleApp',
      })

      expect(url).toBe(
        `${client.clientHttp.host}/api/search?active=true&empty&labels=security%20review&labels=release&query=TypeFerry%20%26%20ExampleApp`,
      )
    })

    it('sorts query keys lexically before encoding', () => {
      const parameters = Object.fromEntries([
        ['z', 'last'],
        ['2', 'two'],
        ['a', 'first'],
        ['10', 'ten'],
      ])

      expect(client.href('search', parameters)).toBe(
        `${client.clientHttp.host}/search?10=ten&2=two&a=first&z=last`,
      )
    })

    it('strictly encodes spaces, punctuation, and Unicode in keys and values', () => {
      const punctuation = " !'()*+&=/?:#"

      expect(client.href('search', { [punctuation]: `${punctuation}é` })).toBe(
        `${client.clientHttp.host}/search?%20%21%27%28%29%2A%2B%26%3D%2F%3F%3A%23=%20%21%27%28%29%2A%2B%26%3D%2F%3F%3A%23%C3%A9`,
      )
    })

    it('omits undefined values and empty arrays without dropping false or zero', () => {
      const values: unknown[] = [null, undefined, '', false, 0, 12n]

      values.length += 1
      values.push('last')

      expect(
        client.href('search', {
          values,
          omitted: undefined,
          emptyArray: [],
          emptyString: '',
          nullValue: null,
        }),
      ).toBe(
        `${client.clientHttp.host}/search?emptyString=&nullValue&values&values=&values=false&values=0&values=12&values=last`,
      )
    })

    it('accepts typed objects and preserves JavaScript value coercion', () => {
      interface Parameters {
        nested: { value: number }
        custom: { toString(): string }
        arrays: number[][]
      }

      const parameters: Parameters = {
        nested: { value: 1 },
        custom: { toString: () => 'custom value' },
        arrays: [[1, 2]],
      }

      expect(client.href('search', parameters)).toBe(
        `${client.clientHttp.host}/search?arrays=1%2C2&custom=custom%20value&nested=%5Bobject%20Object%5D`,
      )
    })

    it('preserves empty query suffixes and legacy special-key handling', () => {
      const parameters = Object.fromEntries([
        ['__proto__', 'omitted'],
        ['', null],
        ['constructor', 'included'],
      ])

      expect(client.href('search', {})).toBe(`${client.clientHttp.host}/search?`)
      expect(client.href('search', { empty: [], omitted: undefined })).toBe(
        `${client.clientHttp.host}/search?`,
      )
      expect(client.href('search', parameters)).toBe(
        `${client.clientHttp.host}/search?constructor=included`,
      )
      expect(client.href('search', { '': [null, 'value'] })).toBe(
        `${client.clientHttp.host}/search?&=value`,
      )
    })

    it('rejects symbols and malformed Unicode during query encoding', () => {
      expect(() => client.href('search', { symbol: Symbol('value') })).toThrow(
        TypeError,
      )
      expect(() => client.href('search', { invalid: '\uD800' })).toThrow(URIError)
    })

    it('throws when plain object is not the last argument', () => {
      expect(() => client.href({ foo: 'bar' } as any, 'path')).toThrow(
        'Parameters are only allowed in the last argument.',
      )
    })
  })

  describe('reconnect()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('delegates to visibilityManager.reconnect()', () => {
      client.reconnect()
      expect(client.visibilityManager.reconnect).toHaveBeenCalled()
    })
  })

  describe('disconnect()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('delegates to close()', async () => {
      const closeSpy = vi.spyOn(client, 'close').mockResolvedValue(undefined)
      await client.disconnect()
      expect(closeSpy).toHaveBeenCalled()
    })
  })

  describe('retryCall()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('retries the call up to maxRetries times', async () => {
      client.initialized = true
      ;(client.clientSocket as any).ready = true

      let callCount = 0
      ;(client.clientSocket as any).emitWithAck = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount < 3) {
          return Promise.reject(new Error('transient'))
        }
        return Promise.resolve('success')
      })

      const result = await client.call('retry.method', {}, {
        httpFallback: false,
        maxRetries: 2,
        delayBetweenRetriesMs: 10,
      })

      expect(result).toBe('success')
      expect(callCount).toBe(3)
    })
  })

  describe('waitForInitialization()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('throws when initialization times out', async () => {
      client.initialized = false

      // call() will call waitForInitialization when not initialized
      // and it will time out
      await expect(
        client.call('some.method', {}, { timeout: 100 }),
      ).rejects.toThrow('TypeFerry: Client not initialized')
    })
  })

  describe('close()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
    })

    it('emits CLOSE, destroys idle timer and visibility manager', async () => {
      const closeSpy = vi.fn()
      client.on(ClientEvents.CLOSE, closeSpy)

      await client.close()

      expect(closeSpy).toHaveBeenCalled()
      expect(client.visibilityManager.destroy).toHaveBeenCalled()
    })
  })

  describe('typed() and combine()', () => {
    let client: Client

    beforeEach(() => {
      const storage: Record<string, string> = {}
      vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          Reflect.deleteProperty(storage, key)
        }),
      })

      client = new Client({ host: 'localhost' })
    })

    afterEach(async () => {
      vi.clearAllMocks()
      vi.unstubAllGlobals()
      if (client) {
        await client.close().catch(() => undefined)
      }
    })

    it('typed() returns the same client instance', () => {
      const typed = client.typed({} as any)
      expect(typed).toBe(client)
    })

    it('combine() returns the same client instance', () => {
      const combined = client.combine({} as any)
      expect(combined).toBe(client)
    })
  })
})
