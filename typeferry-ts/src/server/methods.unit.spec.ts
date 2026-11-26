import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock server module to break circular dependency:
//   methods -> Server (value import) -> ServerChannel -> methods
// ---------------------------------------------------------------------------

vi.mock('./server', () => ({
  Server: vi.fn(),
}))

import { NO_CHANNEL, ServerEvents } from '../utils'
import { getRoomName, rpcLogout, rpcOff, rpcOn } from './methods'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockRooms() {
  return {
    join: vi.fn(),
    leave: vi.fn(),
    leaveAll: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    getSocketRoomCount: vi.fn().mockReturnValue(0),
  }
}

function createMockServer(overrides: Record<string, any> = {}) {
  const events = new Map<string, any>()
  const methods = new Map<string, any>()
  const server = {
    events,
    methods,
    webSocketTransport: { rooms: createMockRooms() },
    shouldAllowChannelSubscribe: vi.fn().mockResolvedValue(true),
    emit: vi.fn(),
    ...overrides,
  }
  return server
}

function createMockEvent(
  name: string,
  overrides: Record<string, any> = {},
) {
  return {
    name,
    isProtected: false,
    shouldSubscribe: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getRoomName', () => {
  it('combines channel and event name', () => {
    expect(getRoomName('my-channel', 'my-event')).toBe(
      'typeferry:10:my-channel:my-event',
    )
  })

  it('works with NO_CHANNEL', () => {
    expect(getRoomName(NO_CHANNEL, 'event')).toBe(
      `typeferry:${Buffer.byteLength(NO_CHANNEL, 'utf8')}:${NO_CHANNEL}:event`,
    )
  })
})

describe('rpcOff', () => {
  it('unsubscribes client from event rooms', async () => {
    const server = createMockServer()
    const rooms = server.webSocketTransport.rooms

    const event = createMockEvent('test-event')
    server.events.set('test-event', event)

    const method = rpcOff(server as any, 'rpc:off')
    const client = { socket: { readyState: 1 } }

    const result = await method.fn.call(client as any, {
      events: ['test-event'],
      channel: 'chan',
    })

    expect(rooms.leave).toHaveBeenCalledWith(
      client.socket,
      'typeferry:4:chan:test-event',
    )
    expect(result).toEqual({ 'test-event': true })
  })

  it('returns false for unknown events', async () => {
    const server = createMockServer()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const method = rpcOff(server as any, 'rpc:off')
    const client = { socket: { readyState: 1 } }

    const result = await method.fn.call(client as any, {
      events: ['unknown'],
      channel: 'chan',
    })

    expect(result).toEqual({ unknown: false })
    expect(logSpy).toHaveBeenCalledWith('[TypeFerry] Event Not Found:', 'unknown')
    logSpy.mockRestore()
  })

  it('returns empty object when client has no socket', async () => {
    const server = createMockServer()
    const method = rpcOff(server as any, 'rpc:off')
    const client = { socket: null }

    const result = await method.fn.call(client as any, {
      events: ['test-event'],
    })

    expect(result).toEqual({})
  })

  it('returns empty object when transport has no rooms', async () => {
    const server = createMockServer()
    server.webSocketTransport = { rooms: null } as any

    const method = rpcOff(server as any, 'rpc:off')
    const client = { socket: { readyState: 1 } }

    const result = await method.fn.call(client as any, {
      events: ['test-event'],
    })

    expect(result).toEqual({})
  })

  it('defaults to NO_CHANNEL when channel not provided', async () => {
    const server = createMockServer()
    const rooms = server.webSocketTransport.rooms

    server.events.set('ev', createMockEvent('ev'))

    const method = rpcOff(server as any, 'rpc:off')
    const client = { socket: { readyState: 1 } }

    await method.fn.call(client as any, { events: ['ev'] })

    expect(rooms.leave).toHaveBeenCalledWith(
      client.socket,
      `typeferry:${Buffer.byteLength(NO_CHANNEL, 'utf8')}:${NO_CHANNEL}:ev`,
    )
  })
})

describe('rpcOn', () => {
  it('subscribes client to event room', async () => {
    const server = createMockServer()
    const rooms = server.webSocketTransport.rooms
    const event = createMockEvent('my-ev')
    server.events.set('my-ev', event)

    const method = rpcOn(server as any, 'rpc:on')
    const client = {
      socket: { readyState: 1 },
      authenticated: true,
    }

    const result = await method.fn.call(client as any, {
      events: ['my-ev'],
      channel: 'chan',
    })

    expect(rooms.join).toHaveBeenCalledWith(
      client.socket,
      'typeferry:4:chan:my-ev',
    )
    expect(result).toEqual({ 'my-ev': true })
  })

  it('returns empty object when events is empty', async () => {
    const server = createMockServer()
    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: false }

    const result = await method.fn.call(client as any, {
      events: [],
    })

    expect(result).toEqual({})
  })

  it('returns false when channel subscription is not allowed', async () => {
    const server = createMockServer()
    server.shouldAllowChannelSubscribe.mockResolvedValue(false)
    server.events.set('ev', createMockEvent('ev'))

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: true }

    const result = await method.fn.call(client as any, {
      events: ['ev'],
      channel: 'chan',
    })

    expect(result).toEqual({ ev: false })
  })

  it('returns false when event is not found', async () => {
    const server = createMockServer()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: true }

    const result = await method.fn.call(client as any, {
      events: ['nonexistent'],
      channel: 'chan',
    })

    expect(result).toEqual({ nonexistent: false })
    expect(logSpy).toHaveBeenCalledWith(
      '[TypeFerry] Event Not Found:',
      'nonexistent',
    )
    logSpy.mockRestore()
  })

  it('returns false when event is protected and client not authenticated', async () => {
    const server = createMockServer()
    const event = createMockEvent('protected-ev', { isProtected: true })
    server.events.set('protected-ev', event)

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: false }

    const result = await method.fn.call(client as any, {
      events: ['protected-ev'],
      channel: 'chan',
    })

    expect(result).toEqual({ 'protected-ev': false })
  })

  it('allows protected event when client is authenticated', async () => {
    const server = createMockServer()
    const event = createMockEvent('protected-ev', { isProtected: true })
    server.events.set('protected-ev', event)

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: true }

    const result = await method.fn.call(client as any, {
      events: ['protected-ev'],
      channel: 'chan',
    })

    expect(result).toEqual({ 'protected-ev': true })
  })

  it('returns false when shouldSubscribe returns false', async () => {
    const server = createMockServer()
    const event = createMockEvent('ev', {
      shouldSubscribe: vi.fn().mockResolvedValue(false),
    })
    server.events.set('ev', event)

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: true }

    const result = await method.fn.call(client as any, {
      events: ['ev'],
      channel: 'chan',
    })

    expect(result).toEqual({ ev: false })
  })

  it('returns false when client has no socket', async () => {
    const server = createMockServer()
    const event = createMockEvent('ev')
    server.events.set('ev', event)

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: null, authenticated: true }

    const result = await method.fn.call(client as any, {
      events: ['ev'],
      channel: 'chan',
    })

    expect(result).toEqual({ ev: false })
  })

  it('returns false when transport rooms is null', async () => {
    const server = createMockServer()
    server.webSocketTransport = { rooms: null } as any
    const event = createMockEvent('ev')
    server.events.set('ev', event)

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: true }

    const result = await method.fn.call(client as any, {
      events: ['ev'],
      channel: 'chan',
    })

    expect(result).toEqual({ ev: false })
  })

  it('defaults to NO_CHANNEL when channel not provided', async () => {
    const server = createMockServer()
    const rooms = server.webSocketTransport.rooms
    const event = createMockEvent('ev')
    server.events.set('ev', event)

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: true }

    await method.fn.call(client as any, { events: ['ev'] })

    expect(rooms.join).toHaveBeenCalledWith(
      client.socket,
      `typeferry:${Buffer.byteLength(NO_CHANNEL, 'utf8')}:${NO_CHANNEL}:ev`,
    )
  })
})

describe('rpcLogout', () => {
  it('clears client authentication state and emits LOGOUT', async () => {
    const server = createMockServer()
    const method = rpcLogout(server as any, 'rpc:logout')

    const client = {
      context: { user: { _id: '123' } },
      authenticated: true,
      userId: '123',
    }

    const result = await method.fn.call(client as any, undefined)

    expect(client.context).toBeNull()
    expect(client.authenticated).toBe(false)
    expect(client.userId).toBeNull()
    expect(server.emit).toHaveBeenCalledWith(ServerEvents.LOGOUT, client)
    expect(result).toBe(true)
  })

  it('is a protected method', () => {
    const server = createMockServer()
    const method = rpcLogout(server as any, 'rpc:logout')
    expect(method.isProtected).toBe(true)
  })

  it('leaves all subscribed WebSocket rooms on logout', async () => {
    const server = createMockServer()
    const method = rpcLogout(server as any, 'rpc:logout')
    const socket = { readyState: 1 }
    const client = {
      socket,
      context: { user: { _id: '123' } },
      authenticated: true,
      userId: '123',
    }

    await method.fn.call(client as any, undefined)

    expect(server.webSocketTransport.rooms.leaveAll).toHaveBeenCalledWith(
      socket,
    )
  })
})

describe('room isolation and subscription bounds', () => {
  it('separates colon-containing channels from colon-containing event names', () => {
    expect(getRoomName('user:42', 'alert')).not.toBe(
      getRoomName('user', '42:alert'),
    )
  })

  it('rejects non-string channels and bounds event batch and socket room counts', async () => {
    const server = createMockServer()
    server.events.set('ev', createMockEvent('ev'))
    server.webSocketTransport.rooms.getSocketRoomCount.mockReturnValue(1024)

    const method = rpcOn(server as any, 'rpc:on')
    const client = { socket: { readyState: 1 }, authenticated: true }

    const arrayChannel = await method.fn.call(client as any, {
      events: ['ev'],
      channel: ['admin'],
    })
    expect(arrayChannel).toEqual({})

    const capped = await method.fn.call(client as any, {
      events: ['ev'],
      channel: 'valid',
    })
    expect(capped).toEqual({ ev: false })
  })

  it('rejects oversized batches (>256), oversized UTF-8 channels, __proto__ event keys, and post-await deauth/closed sockets', async () => {
    const server = createMockServer()
    server.events.set('ev', createMockEvent('ev'))
    const onMethod = rpcOn(server as any, 'rpc:on')
    const offMethod = rpcOff(server as any, 'rpc:off')
    const client = { socket: { readyState: 1 }, authenticated: true }

    const tooMany = Array.from({ length: 257 }, (_, i) => `ev-${i}`)
    expect(
      await onMethod.fn.call(client as any, { events: tooMany, channel: 'c' }),
    ).toEqual({})
    expect(
      await offMethod.fn.call(client as any, { events: tooMany, channel: 'c' }),
    ).toEqual({})

    const multiByteChannel = 'é'.repeat(200) // 400 UTF-8 bytes > 256
    expect(
      await onMethod.fn.call(client as any, {
        events: ['ev'],
        channel: multiByteChannel,
      }),
    ).toEqual({})

    const protoOn = (await onMethod.fn.call(client as any, {
      events: ['__proto__'],
      channel: 'c',
    })) as object
    expect(Object.getPrototypeOf(protoOn)).toBe(Object.prototype)
    expect(Object.hasOwn(protoOn, '__proto__')).toBe(true)

    const protoOff = (await offMethod.fn.call(client as any, {
      events: ['__proto__'],
      channel: 'c',
    })) as object
    expect(Object.getPrototypeOf(protoOff)).toBe(Object.prototype)
    expect(Object.hasOwn(protoOff, '__proto__')).toBe(true)

    const delayedNode: any = { socket: { readyState: 1 }, authenticated: true }
    server.events.set(
      'prot',
      createMockEvent('prot', {
        isProtected: true,
        shouldSubscribe: vi.fn(async () => {
          delayedNode.authenticated = false
          return true
        }),
      }),
    )
    expect(
      await onMethod.fn.call(delayedNode, { events: ['prot'], channel: 'c' }),
    ).toEqual({ prot: false })
    expect(server.webSocketTransport.rooms.join).not.toHaveBeenCalled()
  })
})
