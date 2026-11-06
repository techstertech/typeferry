import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageType, Presentation, ServerEvents } from '../utils'
import { ClientNode, type ClientNodeContext } from './client-node'
import { SocketState } from './types'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockSocket(readyState: number = SocketState.OPEN) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  }
}

function createMockServer(overrides: Record<string, any> = {}) {
  return {
    indexClientByUserId: vi.fn(),
    removeClientFromUserIndex: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientNode', () => {
  let server: ReturnType<typeof createMockServer>

  beforeEach(() => {
    server = createMockServer()
  })

  describe('constructor', () => {
    it('initializes with default values', () => {
      const node = new ClientNode(server)

      expect(node.isAuthenticated).toBe(false)
      expect(node.context).toEqual({})
      expect(node.userId).toBeNull()
      expect(node.user).toBeNull()
      expect(node.isServer).toBe(false)
      expect(node.headers).toEqual({})
      expect(node.meta).toEqual({})
    })

    it('stores socket, req, and res', () => {
      const socket = createMockSocket()
      const req = {} as any
      const res = {} as any

      const node = new ClientNode(server, socket as any, req, res)

      expect(node.socket).toBe(socket)
      expect(node.req).toBe(req)
      expect(node.res).toBe(res)
    })

    it('creates rate limiter with boolean limit', () => {
      const node = new ClientNode(server, undefined, undefined, undefined, true)

      expect(node.limiter).toBeDefined()
    })

    it('creates rate limiter with custom limit', () => {
      const node = new ClientNode(server, undefined, undefined, undefined, {
        max: 100,
        interval: 30000,
      })

      expect(node.limiter).toBeDefined()
    })

    it('does not create rate limiter when no limit', () => {
      const node = new ClientNode(server)

      expect(node.limiter).toBeUndefined()
    })
  })

  describe('authenticated getter/setter', () => {
    it('gets and sets isAuthenticated', () => {
      const node = new ClientNode(server)

      expect(node.authenticated).toBe(false)
      node.authenticated = true
      expect(node.authenticated).toBe(true)
      expect(node.isAuthenticated).toBe(true)
    })
  })

  it('retires the current principal immediately when authentication is cleared', () => {
    const node = new ClientNode(server)
    const removed: Array<string | null> = []

    server.removeClientFromUserIndex.mockImplementation((client: ClientNode) => {
      removed.push(client.userId)
      expect(client.context).toEqual({ user: { _id: 'previous' } })
    })
    node.authenticated = true
    node.setContext({ user: { _id: 'previous' } })

    node.authenticated = false

    expect(node.authenticated).toBe(false)
    expect(node.context).toEqual({})
    expect(node.userId).toBeNull()
    expect(node.user).toBeNull()
    expect(removed).toEqual(['previous'])

    node.authenticated = false

    expect(removed).toEqual(['previous'])
  })

  describe('readyState', () => {
    it('returns socket readyState', () => {
      const socket = createMockSocket(SocketState.OPEN)
      const node = new ClientNode(server, socket as any)

      expect(node.readyState).toBe(SocketState.OPEN)
    })

    it('returns undefined when no socket', () => {
      const node = new ClientNode(server)
      expect(node.readyState).toBeUndefined()
    })
  })

  describe('setId', () => {
    it('sets the uuid', () => {
      const node = new ClientNode(server)
      node.setId('my-uuid')
      expect(node.uuid).toBe('my-uuid')
    })
  })

  describe('setContext', () => {
    it('sets context when authenticated', () => {
      const node = new ClientNode(server)
      node.authenticated = true
      node.context = { user: { _id: 'u1' } }

      // setContext should call setUserId internally
      node.setContext({ user: { _id: 'u2' } })

      expect(node.context).toEqual({ user: { _id: 'u2' } })
      expect(node.userId).toBe('u2')
    })

    it('sets empty context when not authenticated', () => {
      const node = new ClientNode(server)
      node.authenticated = false

      node.setContext({ user: { _id: 'u1' } })

      expect(node.context).toEqual({})
    })
  })

  describe('user identity transitions', () => {
    it('retires the previous user index before installing a different context', () => {
      const node = new ClientNode(server)
      const previous: ClientNodeContext = { user: { _id: 'previous' } }
      const replacement: ClientNodeContext = { user: { _id: 42 } }
      const changes: Array<[string, string | null]> = []

      server.indexClientByUserId.mockImplementation((client: ClientNode) => {
        changes.push(['index', client.userId])
      })
      server.removeClientFromUserIndex.mockImplementation((client: ClientNode) => {
        changes.push(['remove', client.userId])
        expect(client.context).toEqual(previous)
      })
      node.authenticated = true
      node.setContext(previous)

      node.setContext(replacement)

      expect(changes).toEqual([['index', 'previous'], ['remove', 'previous'], ['index', '42']])
      expect(node.context).toEqual(replacement)
      expect(node.user).toEqual(replacement.user)
      expect(node.userId).toBe('42')
    })

    it.each<ClientNodeContext | null>([null, {}, { user: {} }])(
      'removes the previous user index when its context is cleared: %j',
      context => {
        const node = new ClientNode(server)
        const removed: Array<string | null> = []

        server.removeClientFromUserIndex.mockImplementation((client: ClientNode) => {
          removed.push(client.userId)
        })
        node.authenticated = true
        node.setContext({ user: { _id: 'previous' } })

        node.setContext(context)

        expect(removed).toEqual(['previous'])
        expect(node.userId).toBeNull()
        expect(node.user).toBeNull()
        expect(server.indexClientByUserId).toHaveBeenCalledTimes(1)
      },
    )

    it('removes the previous user index after authentication is cleared', () => {
      const node = new ClientNode(server)
      const removed: Array<string | null> = []

      server.removeClientFromUserIndex.mockImplementation((client: ClientNode) => {
        removed.push(client.userId)
      })
      node.authenticated = true
      node.setContext({ user: { _id: 'previous' } })
      node.authenticated = false
      node.setContext(null)

      expect(removed).toEqual(['previous'])
      expect(node.context).toEqual({})
      expect(node.userId).toBeNull()
      expect(node.user).toBeNull()
    })

    it('retires the previous index when setUserId refreshes a changed user', () => {
      const node = new ClientNode(server)
      const removed: Array<string | null> = []

      server.removeClientFromUserIndex.mockImplementation((client: ClientNode) => {
        removed.push(client.userId)
      })
      node.authenticated = true
      node.setContext({ user: { _id: 'previous' } })
      node.context = { user: { _id: 'replacement' } }

      node.setUserId()

      expect(removed).toEqual(['previous'])
      expect(node.userId).toBe('replacement')
    })
  })

  describe('setTrackingProperties', () => {
    it('extracts headers, user-agent, and remote address from source', () => {
      const node = new ClientNode(server)

      node.setTrackingProperties({
        headers: {
          'user-agent': 'TestBot/1.0',
          'x-forwarded-for': '10.0.0.1',
          'content-type': 'application/json',
        },
        socket: { remoteAddress: '127.0.0.1' },
      })

      expect(node.userAgent).toBe('TestBot/1.0')
      expect(node.remoteAddress).toBe('127.0.0.1')
      expect(node.headers['content-type']).toBe('application/json')
    })

    it('uses an adapter-provided peer without promoting forwarding headers', () => {
      const node = new ClientNode(server)

      node.setTrackingProperties({
        headers: { 'x-forwarded-for': '203.0.113.1' },
        ip: '192.0.2.1',
      })

      expect(node.remoteAddress).toBe('192.0.2.1')
    })

    it('uses socket.remoteAddress when an adapter IP is absent', () => {
      const node = new ClientNode(server)

      node.setTrackingProperties({
        headers: { 'user-agent': 'Bot' },
        socket: { remoteAddress: '192.168.1.1' },
      })

      expect(node.remoteAddress).toBe('192.168.1.1')
    })

    it('defaults to empty strings when no headers or socket', () => {
      const node = new ClientNode(server)

      node.setTrackingProperties({})

      expect(node.userAgent).toBe('')
      expect(node.remoteAddress).toBe('')
      expect(node.headers).toEqual({})
    })
  })

  describe('setUserId', () => {
    it('sets userId and user from context when authenticated', () => {
      const node = new ClientNode(server)
      node.authenticated = true
      node.context = { user: { _id: 'abc123', name: 'Alice' } }

      node.setUserId()

      expect(node.userId).toBe('abc123')
      expect(node.user).toEqual({ _id: 'abc123', name: 'Alice' })
      expect(server.indexClientByUserId).toHaveBeenCalledWith(node)
    })

    it('does nothing when not authenticated', () => {
      const node = new ClientNode(server)
      node.authenticated = false

      node.setUserId()

      expect(node.userId).toBeNull()
      expect(server.indexClientByUserId).not.toHaveBeenCalled()
    })

    it.each<ClientNodeContext>([{}, { user: {} }])(
      'keeps an authenticated context without a user ID unindexed: %j',
      context => {
        const node = new ClientNode(server)
        node.authenticated = true
        node.context = context

        expect(() => node.setUserId()).not.toThrow()
        expect(node.authenticated).toBe(true)
        expect(node.context).toEqual(context)
        expect(node.userId).toBeNull()
        expect(node.user).toBeNull()
        expect(server.indexClientByUserId).not.toHaveBeenCalled()
      },
    )

    it('converts userId to string', () => {
      const node = new ClientNode(server)
      node.authenticated = true
      node.context = { user: { _id: 42 } }

      node.setUserId()

      expect(node.userId).toBe('42')
    })
  })

  // ── WebSocket Message Emitters ──────────────────────────────────────────

  describe('emitTypeFerryEvent', () => {
    it('sends encoded event when socket is OPEN', () => {
      const socket = createMockSocket(SocketState.OPEN)
      const node = new ClientNode(server, socket as any)

      node.emitTypeFerryEvent('test-event', 'my-channel', { key: 'val' })

      expect(socket.send).toHaveBeenCalledTimes(1)
      const payload = Presentation.decode(socket.send.mock.calls[0]![0])
      expect(payload).toMatchObject({
        t: MessageType.EVENT,
        event: 'test-event',
        channel: 'my-channel',
        params: { key: 'val' },
      })
    })

    it('does not send when socket is not OPEN', () => {
      const socket = createMockSocket(SocketState.CLOSED)
      const node = new ClientNode(server, socket as any)

      node.emitTypeFerryEvent('test-event')

      expect(socket.send).not.toHaveBeenCalled()
    })

    it('does not send when socket is null', () => {
      const node = new ClientNode(server)

      // Should not throw
      node.emitTypeFerryEvent('test-event')
    })

    it('does not send when socket is CONNECTING', () => {
      const socket = createMockSocket(SocketState.CONNECTING)
      const node = new ClientNode(server, socket as any)

      node.emitTypeFerryEvent('event')

      expect(socket.send).not.toHaveBeenCalled()
    })

    it('reports a synchronous socket send failure without throwing', () => {
      const socket = createMockSocket(SocketState.OPEN)
      socket.send.mockImplementation(() => {
        throw new Error('socket queue rejected frame')
      })
      const node = new ClientNode(server, socket as any)

      expect(node.sendTypeFerryEvent('event')).toEqual({
        accepted: false,
        bufferedBytes: 0,
      })
    })

    it('detects native pressure support for Node sockets', () => {
      const nodeSocket = {
        ...createMockSocket(SocketState.OPEN),
        bufferedAmount: 12,
      }
      expect(
        new ClientNode(server, nodeSocket as any).supportsBufferedBytes
      ).toBe(true)
      expect(
        new ClientNode(server, createMockSocket(SocketState.OPEN) as any)
          .supportsBufferedBytes
      ).toBe(false)
    })
  })

  describe('emitError', () => {
    it('sends error payload when socket is OPEN', () => {
      const socket = createMockSocket(SocketState.OPEN)
      const node = new ClientNode(server, socket as any)

      node.emitError({ message: 'something failed', method: 'my-method' })

      expect(socket.send).toHaveBeenCalledTimes(1)
      const payload = Presentation.decode(socket.send.mock.calls[0]![0])
      expect(payload).toMatchObject({
        message: 'something failed',
        method: 'my-method',
      })
    })

    it('does not send when socket is not OPEN', () => {
      const socket = createMockSocket(SocketState.CLOSING)
      const node = new ClientNode(server, socket as any)

      node.emitError({ message: 'fail' })

      expect(socket.send).not.toHaveBeenCalled()
    })

    it('does not send when socket is null', () => {
      const node = new ClientNode(server)
      node.emitError({ message: 'fail' })
      // Should not throw
    })
  })

  describe('emitAuthResult', () => {
    it('sends auth result when socket is OPEN', () => {
      const socket = createMockSocket(SocketState.OPEN)
      const node = new ClientNode(server, socket as any)

      node.emitAuthResult(true)

      expect(socket.send).toHaveBeenCalledTimes(1)
      const payload = Presentation.decode(socket.send.mock.calls[0]![0])
      expect(payload).toMatchObject({
        t: MessageType.AUTH,
        authenticated: true,
      })
    })

    it('sends false auth result', () => {
      const socket = createMockSocket(SocketState.OPEN)
      const node = new ClientNode(server, socket as any)

      node.emitAuthResult(false)

      const payload = Presentation.decode(socket.send.mock.calls[0]![0])
      expect(payload).toMatchObject({
        t: MessageType.AUTH,
        authenticated: false,
      })
    })

    it('does not send when socket is not OPEN', () => {
      const socket = createMockSocket(SocketState.CLOSED)
      const node = new ClientNode(server, socket as any)

      node.emitAuthResult(true)

      expect(socket.send).not.toHaveBeenCalled()
    })

    it('does not send when socket is null', () => {
      const node = new ClientNode(server)
      node.emitAuthResult(true)
      // Should not throw
    })
  })

  describe('close', () => {
    it('closes socket and emits DISCONNECT events', () => {
      const socket = createMockSocket()
      const node = new ClientNode(server, socket as any)
      const emitSpy = vi.spyOn(node, 'emit')

      node.close()

      expect(socket.close).toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith(ServerEvents.DISCONNECT)
      expect(server.emit).toHaveBeenCalledWith(ServerEvents.DISCONNECTION, node)
    })

    it('is idempotent - only closes once', () => {
      const socket = createMockSocket()
      const node = new ClientNode(server, socket as any)

      node.close()
      node.close()

      expect(socket.close).toHaveBeenCalledTimes(1)
    })

    it('emits events even without socket', () => {
      const node = new ClientNode(server)
      const emitSpy = vi.spyOn(node, 'emit')

      node.close()

      expect(emitSpy).toHaveBeenCalledWith(ServerEvents.DISCONNECT)
      expect(server.emit).toHaveBeenCalledWith(ServerEvents.DISCONNECTION, node)
    })
  })
})
