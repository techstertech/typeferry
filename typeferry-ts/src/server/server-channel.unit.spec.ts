import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock modules to break circular dependency chain:
//   server-channel -> methods -> server -> server-channel
//   server-channel -> event -> (type-only, but methods is the issue)
// ---------------------------------------------------------------------------

vi.mock('./methods', () => ({
  getRoomName: (channel: string, event: string) =>
    `typeferry:${Buffer.byteLength(channel, 'utf8')}:${channel}:${event}`,
}))

const mockEventInstances: any[] = []

vi.mock('./event', () => {
  const MockEvent = vi.fn(function (
    this: any,
    name: string,
    server: any,
    channel: any,
    opts: any,
  ) {
    this.name = name
    this.server = server
    this.channel = channel
    this.uuid = 'mock-uuid'
    this.isProtected = opts?.protected ?? false
    this.cluster = Boolean(opts?.cluster)
    this.excludeOriginator = Boolean(opts?.excludeOriginator)
    this.shouldSubscribe = opts?.shouldSubscribe ?? (async () => true)
    this.handler = vi.fn()
    mockEventInstances.push(this)
  })
  return { Event: MockEvent }
})

import { TypeFerryEvents } from '../utils'
import { ServerChannel } from './server-channel'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockRooms() {
  return {
    broadcast: vi.fn(),
    has: vi.fn().mockReturnValue(false),
  }
}

function createMockTransport(rooms = createMockRooms()) {
  return { rooms }
}

function createMockServer(overrides: Record<string, any> = {}) {
  const events = new Map<string, any>()
  const allClients = new Map<string, any>()
  return {
    events,
    allClients,
    webSocketTransport: createMockTransport(),
    ...overrides,
  }
}

function createMockEvent(name: string, overrides: Record<string, any> = {}) {
  return {
    name,
    handler: vi.fn(),
    isProtected: false,
    shouldSubscribe: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServerChannel', () => {
  let channel: ServerChannel
  let server: ReturnType<typeof createMockServer>

  beforeEach(() => {
    mockEventInstances.length = 0
    channel = new ServerChannel('test-channel')
    server = createMockServer()
    channel.setServer(server as any)
  })

  afterEach(() => {
    channel.removeAllListeners()
  })

  // ── propagate ───────────────────────────────────────────────────────────

  describe('propagate', () => {
    it('logs warning and returns when event is not registered', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      channel.propagate('unknown-event', '{}')
      expect(logSpy).toHaveBeenCalledWith(
        'Event Not Registered:',
        'unknown-event',
      )
      logSpy.mockRestore()
    })

    it('warns and returns when webSocketTransport is null', () => {
      server.events.set('my-event', createMockEvent('my-event'))
      server.webSocketTransport = null as any
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      channel.propagate('my-event', '{}')

      expect(warnSpy).toHaveBeenCalledWith(
        '[TypeFerry] WebSocket transport not available for propagate',
      )
      warnSpy.mockRestore()
    })

    it('broadcasts to room without excludeUuid', () => {
      const rooms = createMockRooms()
      server.webSocketTransport = createMockTransport(rooms) as any

      server.events.set('my-event', createMockEvent('my-event'))

      channel.propagate('my-event', '{"data":1}')

      expect(rooms.broadcast).toHaveBeenCalledWith(
        'typeferry:12:test-channel:my-event',
        '{"data":1}',
      )
    })

    it('broadcasts to room excluding a specific client socket', () => {
      const rooms = createMockRooms()
      server.webSocketTransport = createMockTransport(rooms) as any

      const mockSocket = { readyState: 1, send: vi.fn(), close: vi.fn() }
      server.allClients.set('client-uuid', { socket: mockSocket })
      server.events.set('my-event', createMockEvent('my-event'))

      channel.propagate('my-event', '{"data":1}', 'client-uuid')

      expect(rooms.broadcast).toHaveBeenCalledWith(
        'typeferry:12:test-channel:my-event',
        '{"data":1}',
        mockSocket,
      )
    })

    it('broadcasts with undefined socket when excludeUuid client not found', () => {
      const rooms = createMockRooms()
      server.webSocketTransport = createMockTransport(rooms) as any

      server.events.set('my-event', createMockEvent('my-event'))

      channel.propagate('my-event', '{"data":1}', 'nonexistent-uuid')

      expect(rooms.broadcast).toHaveBeenCalledWith(
        'typeferry:12:test-channel:my-event',
        '{"data":1}',
        undefined,
      )
    })
  })

  // ── defer ───────────────────────────────────────────────────────────────

  describe('defer', () => {
    it('emits event on next tick', async () => {
      // Register event so onAny handler does not warn
      const mockEvent = createMockEvent('deferred-event')
      server.events.set('deferred-event', mockEvent)

      const emitSpy = vi.spyOn(channel, 'emit')
      channel.defer('deferred-event', { key: 'value' })

      // Should not have emitted synchronously
      expect(emitSpy).not.toHaveBeenCalledWith('deferred-event', {
        key: 'value',
      })

      // Wait for nextTick
      await new Promise<void>(resolve => process.nextTick(resolve))

      expect(emitSpy).toHaveBeenCalledWith('deferred-event', { key: 'value' })
    })

    it('emits event without params', async () => {
      const mockEvent = createMockEvent('deferred-no-params')
      server.events.set('deferred-no-params', mockEvent)

      const emitSpy = vi.spyOn(channel, 'emit')
      channel.defer('deferred-no-params')

      await new Promise<void>(resolve => process.nextTick(resolve))

      expect(emitSpy).toHaveBeenCalledWith('deferred-no-params', undefined)
    })
  })

  // ── refresh ─────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('emits TypeFerryEvents.METHOD_REFRESH with method name', () => {
      // Register the METHOD_REFRESH event to avoid warning
      server.events.set(
        TypeFerryEvents.METHOD_REFRESH,
        createMockEvent(TypeFerryEvents.METHOD_REFRESH),
      )

      const emitSpy = vi.spyOn(channel, 'emit')
      channel.refresh('some-method')

      expect(emitSpy).toHaveBeenCalledWith(
        TypeFerryEvents.METHOD_REFRESH,
        'some-method',
      )
    })
  })

  // ── addEvent ────────────────────────────────────────────────────────────

  describe('addEvent', () => {
    it('creates a new Event and adds to server.events', () => {
      channel.addEvent('new-event')

      expect(server.events.has('new-event')).toBe(true)
      const stored = server.events.get('new-event')
      expect(stored.name).toBe('new-event')
    })

    it('replaces an existing event by deleting first', () => {
      channel.addEvent('replace-me')
      const first = server.events.get('replace-me')

      channel.addEvent('replace-me', { protected: true })
      const second = server.events.get('replace-me')

      expect(second).not.toBe(first)
      expect(second.isProtected).toBe(true)
    })
  })

  // ── list / length / get / has / delete ──────────────────────────────────

  describe('list', () => {
    it('returns array of event names', () => {
      server.events.set('a', createMockEvent('a'))
      server.events.set('b', createMockEvent('b'))

      expect(channel.list).toEqual(['a', 'b'])
    })

    it('returns empty array when no events', () => {
      expect(channel.list).toEqual([])
    })
  })

  describe('length', () => {
    it('returns the number of events', () => {
      server.events.set('a', createMockEvent('a'))
      server.events.set('b', createMockEvent('b'))

      expect(channel.length).toBe(2)
    })
  })

  describe('get', () => {
    it('returns event by name', () => {
      const ev = createMockEvent('target')
      server.events.set('target', ev)

      expect(channel.get('target')).toBe(ev)
    })

    it('returns undefined for unknown event', () => {
      expect(channel.get('nope')).toBeUndefined()
    })
  })

  describe('has', () => {
    it('returns true for registered event', () => {
      server.events.set('exists', createMockEvent('exists'))
      expect(channel.has('exists')).toBe(true)
    })

    it('returns false for unknown event', () => {
      expect(channel.has('nope')).toBe(false)
    })
  })

  describe('delete', () => {
    it('deletes event from server.events', () => {
      server.events.set('to-delete', createMockEvent('to-delete'))
      expect(channel.delete('to-delete')).toBe(true)
      expect(server.events.has('to-delete')).toBe(false)
    })

    it('returns false when deleting non-existent event', () => {
      expect(channel.delete('nope')).toBe(false)
    })
  })

  // ── isSubscribed ────────────────────────────────────────────────────────

  describe('isSubscribed', () => {
    it('returns false when client has no socket', () => {
      const client = { socket: null } as any
      const event = createMockEvent('ev') as any

      expect(channel.isSubscribed(client, event)).toBe(false)
    })

    it('returns false when transport has no rooms', () => {
      server.webSocketTransport = { rooms: null } as any
      const client = { socket: { readyState: 1 } } as any
      const event = createMockEvent('ev') as any

      expect(channel.isSubscribed(client, event)).toBe(false)
    })

    it('returns false when webSocketTransport is null', () => {
      server.webSocketTransport = null as any
      const client = { socket: { readyState: 1 } } as any
      const event = createMockEvent('ev') as any

      expect(channel.isSubscribed(client, event)).toBe(false)
    })

    it('returns true when rooms.has returns true', () => {
      const rooms = createMockRooms()
      rooms.has.mockReturnValue(true)
      server.webSocketTransport = createMockTransport(rooms) as any

      const mockSocket = { readyState: 1 }
      const client = { socket: mockSocket } as any
      const event = createMockEvent('my-ev') as any

      const result = channel.isSubscribed(client, event)

      expect(rooms.has).toHaveBeenCalledWith(
        mockSocket,
        'typeferry:12:test-channel:my-ev',
      )
      expect(result).toBe(true)
    })

    it('returns false when rooms.has returns false', () => {
      const rooms = createMockRooms()
      rooms.has.mockReturnValue(false)
      server.webSocketTransport = createMockTransport(rooms) as any

      const client = { socket: { readyState: 1 } } as any
      const event = createMockEvent('my-ev') as any

      expect(channel.isSubscribed(client, event)).toBe(false)
    })
  })

  // ── onAny handler ──────────────────────────────────────────────────────

  describe('onAny handler', () => {
    it('warns when event is not registered and not a system event', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      channel.emit('some-unregistered-event', { data: 1 })

      expect(warnSpy).toHaveBeenCalledWith(
        'Event Not Registered:',
        'some-unregistered-event',
      )
      warnSpy.mockRestore()
    })

    it('does not warn for system events', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // HttpTransportEvents.HTTP_LISTENING is a system event
      channel.emit('http:listening', { data: 1 })

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('calls event handler for registered events', () => {
      const mockEvent = createMockEvent('handled-event')
      server.events.set('handled-event', mockEvent)

      channel.emit('handled-event', { key: 'val' })

      expect(mockEvent.handler).toHaveBeenCalledWith(channel, { key: 'val' })
    })

    it('does not call handler for unregistered events', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const mockEvent = createMockEvent('other-event')
      server.events.set('other-event', mockEvent)

      channel.emit('unregistered-event', {})

      expect(mockEvent.handler).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
})
