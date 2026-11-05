import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * We mock the entire `ws` module so that importing WebSocketTransport
 * doesn't try to open real sockets.
 */
const mockWssOn = vi.fn()
const mockWssClose = vi.fn((cb?: () => void) => cb?.())
const mockWssHandleUpgrade = vi.fn()

vi.mock('ws', () => {
  return {
    WebSocketServer: class MockWebSocketServer {
      on = mockWssOn
      close = mockWssClose
      handleUpgrade = mockWssHandleUpgrade
      clients = new Set()
      constructor(..._args: any[]) {}
    },
  }
})

// Mock ws-shared helpers so we can verify they're called.
vi.mock('./ws-shared', () => ({
  PING_INTERVAL_MS: 100,
  PING_PAYLOAD: '{"t":"ping"}',
  authenticateNode: vi.fn(),
  handleRpc: vi.fn(),
  handleRpcVoid: vi.fn(),
  parseMeta: vi.fn().mockReturnValue({}),
  validateUuid: vi.fn().mockReturnValue('test-uuid'),
}))

// Mock ClientNode so constructor doesn't pull in real dependencies.
vi.mock('../client-node', () => {
  return {
    ClientNode: class MockClientNode {
      setId = vi.fn()
      meta = {}
      setTrackingProperties = vi.fn()
      socket: any = null
      close = vi.fn()
      constructor(..._args: any[]) {}
    },
  }
})

// Mock RoomRegistry
vi.mock('../room-registry', () => {
  return {
    RoomRegistry: class MockRoomRegistry {
      leaveAll = vi.fn()
    },
  }
})

import { WebSocketTransport } from './websocket-transport'
import { authenticateNode, handleRpc, handleRpcVoid } from './ws-shared'
import { ClientNode } from '../client-node'
import { Presentation, ServerEvents, MessageType } from '../../utils'
import { SocketState } from '../types'

function createMockServer(overrides: Record<string, any> = {}) {
  const httpOn = vi.fn()
  return {
    emit: vi.fn(),
    addClient: vi.fn(),
    deleteClient: vi.fn(),
    rateLimit: false,
    acceptConnections: true,
    httpTransport: {
      http: {
        on: httpOn,
      },
    },
    ...overrides,
  } as any
}

function createMockWs(readyState: number = SocketState.OPEN): any {
  return {
    readyState,
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  }
}

/** Retrieves the 'upgrade' handler from the HTTP server mock. */
function getUpgradeHandler(server: any): Function {
  return server.httpTransport.http.on.mock.calls.find(
    ([event]: [string]) => event === 'upgrade',
  )[1]!
}

/**
 * Triggers a full connection flow: sets up handleUpgrade to call back with
 * the given mock ws, then fires the upgrade handler.
 */
function triggerConnection(server: any, ws: any, req?: any) {
  const upgradeHandler = getUpgradeHandler(server)
  const actualReq = req ?? {
    url: '/typeferry-ws?uuid=test-uuid&token=test-token',
    headers: {},
  }
  const socket = { destroy: vi.fn(), write: vi.fn() }
  const head = Buffer.alloc(0)

  mockWssHandleUpgrade.mockImplementationOnce(
    (_r: any, _s: any, _h: any, cb: Function) => cb(ws),
  )
  upgradeHandler(actualReq, socket, head)
}

describe('WebSocketTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('registers an error handler on the wss', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      expect(mockWssOn).toHaveBeenCalledWith('error', expect.any(Function))
    })

    it('emits WEBSOCKET_SERVER_ERROR when wss errors', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)

      const errorHandler = mockWssOn.mock.calls.find(
        call => call[0] === 'error',
      )![1]
      const error = new Error('wss error')
      errorHandler(error)

      expect(server.emit).toHaveBeenCalledWith('websocket:server:error', error)
    })

    it('attaches an upgrade handler on the HTTP server', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      expect(server.httpTransport.http.on).toHaveBeenCalledWith(
        'upgrade',
        expect.any(Function),
      )
    })

    it('sets origins when a non-empty array is provided', () => {
      const server = createMockServer()
      const transport = new WebSocketTransport(server, ['http://allowed.com'])

      expect(
        (transport as any).validateOrigin({
          headers: { origin: 'http://allowed.com' },
        }),
      ).toBe(true)

      expect(
        (transport as any).validateOrigin({
          headers: { origin: 'http://evil.com' },
        }),
      ).toBe(false)
    })

    it('rejects all named origins when an empty allowlist is provided', () => {
      const server = createMockServer()
      const transport = new WebSocketTransport(server, [])

      expect(
        (transport as any).validateOrigin({
          headers: { origin: 'http://anything.com' },
        }),
      ).toBe(false)
    })
  })

  describe('upgrade handler', () => {
    it('rejects requests to non-matching paths and closes the socket', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const upgradeHandler = getUpgradeHandler(server)

      const socket = {
        destroy: vi.fn(),
        end: vi.fn((_response: string, callback: () => void) => callback()),
        write: vi.fn(),
      }
      upgradeHandler(
        { url: '/other-path', headers: {} },
        socket,
        Buffer.alloc(0),
      )

      expect(mockWssHandleUpgrade).not.toHaveBeenCalled()
      expect(socket.end).toHaveBeenCalledWith(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        expect.any(Function),
      )
      expect(socket.destroy).toHaveBeenCalled()
    })

    it('destroys socket when acceptConnections is false', () => {
      const server = createMockServer({ acceptConnections: false })
      new WebSocketTransport(server, undefined)
      const upgradeHandler = getUpgradeHandler(server)

      const socket = {
        destroy: vi.fn(),
        end: vi.fn((_response: string, callback: () => void) => callback()),
        write: vi.fn(),
      }
      upgradeHandler(
        { url: '/typeferry-ws', headers: {} },
        socket,
        Buffer.alloc(0),
      )

      expect(socket.destroy).toHaveBeenCalled()
      expect(mockWssHandleUpgrade).not.toHaveBeenCalled()
    })

    it('rejects connections with invalid origin (403)', () => {
      const server = createMockServer()
      new WebSocketTransport(server, ['http://allowed.com'])
      const upgradeHandler = getUpgradeHandler(server)

      const socket = {
        destroy: vi.fn(),
        end: vi.fn((_response: string, callback: () => void) => callback()),
        write: vi.fn(),
      }
      upgradeHandler(
        { url: '/typeferry-ws', headers: { origin: 'http://evil.com' } },
        socket,
        Buffer.alloc(0),
      )

      expect(socket.end).toHaveBeenCalledWith(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        expect.any(Function),
      )
      expect(socket.destroy).toHaveBeenCalled()
    })

    it('rejects missing origins when an allowlist is configured', () => {
      const server = createMockServer()
      const transport = new WebSocketTransport(server, ['http://allowed.com'])
      expect((transport as any).validateOrigin({ headers: {} })).toBe(false)
    })

    it('delegates to wss.handleUpgrade on valid request', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const upgradeHandler = getUpgradeHandler(server)

      const req = { url: '/typeferry-ws', headers: {} }
      const socket = { destroy: vi.fn(), write: vi.fn() }
      const head = Buffer.alloc(0)

      // Don't let it actually call handleConnection (which needs a real ws)
      mockWssHandleUpgrade.mockImplementationOnce(() => {})
      upgradeHandler(req, socket, head)

      expect(mockWssHandleUpgrade).toHaveBeenCalledWith(
        req,
        socket,
        head,
        expect.any(Function),
      )
    })
  })

  describe('handleConnection', () => {
    it('creates a ClientNode and adds it to the server', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      expect(server.addClient).toHaveBeenCalled()
      expect(server.emit).toHaveBeenCalledWith(
        ServerEvents.CONNECTION,
        expect.anything(),
      )
    })

    it('sets up message, close, and error handlers on the websocket', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      const registeredEvents = ws.on.mock.calls.map(
        ([event]: [string]) => event,
      )
      expect(registeredEvents).toContain('message')
      expect(registeredEvents).toContain('close')
      expect(registeredEvents).toContain('error')
    })

    it('calls authenticateNode with the node and token', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      expect(authenticateNode).toHaveBeenCalledWith(
        server,
        expect.anything(),
        expect.anything(),
        undefined,
        expect.objectContaining({
          path: '/typeferry-ws',
          query: expect.objectContaining({ token: 'test-token' }),
        }),
      )
    })

    it('cleans up on close: stops ping, leaves rooms, deletes client', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      const closeHandler = ws.on.mock.calls.find(
        ([event]: [string]) => event === 'close',
      )![1]
      closeHandler()

      expect(server.deleteClient).toHaveBeenCalled()
    })

    it('emits SOCKET_ERROR on ws error', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      const errorHandler = ws.on.mock.calls.find(
        ([event]: [string]) => event === 'error',
      )![1]
      const error = new Error('ws error')
      errorHandler(error)

      expect(server.emit).toHaveBeenCalledWith(
        ServerEvents.SOCKET_ERROR,
        ws,
        error,
      )
    })
  })

  describe('handleMessage', () => {
    function setupForMessage(server: any) {
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()
      triggerConnection(server, ws)

      // Get the message handler that was registered on the ws mock
      const messageHandler = ws.on.mock.calls.find(
        ([event]: [string]) => event === 'message',
      )![1]

      return { ws, messageHandler }
    }

    it('delegates RPC messages to handleRpc', () => {
      const server = createMockServer()
      const { messageHandler } = setupForMessage(server)

      const msg = Presentation.encode({
        t: MessageType.RPC,
        id: 'req-1',
        method: 'test.method',
        params: { a: 1 },
      })
      messageHandler(msg)

      expect(handleRpc).toHaveBeenCalledWith(
        server,
        expect.anything(),
        'req-1',
        'test.method',
        { a: 1 },
      )
    })

    it('delegates RPC void messages to handleRpcVoid', () => {
      const server = createMockServer()
      const { messageHandler } = setupForMessage(server)

      const msg = Presentation.encode({
        t: MessageType.RPC_VOID,
        method: 'void.method',
        params: { b: 2 },
      })
      messageHandler(msg)

      expect(handleRpcVoid).toHaveBeenCalledWith(
        server,
        expect.anything(),
        'void.method',
        { b: 2 },
      )
    })

    it('handles pong messages without throwing', () => {
      const server = createMockServer()
      const { messageHandler } = setupForMessage(server)

      const msg = Presentation.encode({ t: MessageType.PONG })
      expect(() => messageHandler(msg)).not.toThrow()
    })

    it('handles Buffer messages', () => {
      const server = createMockServer()
      const { messageHandler } = setupForMessage(server)

      const msg = Buffer.from(
        Presentation.encode({
          t: MessageType.RPC,
          id: 'req-2',
          method: 'buf.method',
        }),
      )
      messageHandler(msg)

      expect(handleRpc).toHaveBeenCalledWith(
        server,
        expect.anything(),
        'req-2',
        'buf.method',
        undefined,
      )
    })

    it('silently ignores malformed messages', () => {
      const server = createMockServer()
      const { messageHandler } = setupForMessage(server)

      expect(() => messageHandler('not valid json {')).not.toThrow()
    })
  })

  describe('ping / pong keep-alive', () => {
    it('sends pings at the configured interval', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      vi.advanceTimersByTime(100)

      expect(ws.send).toHaveBeenCalledWith('{"t":"ping"}')
    })

    it('terminates socket when pong is not received', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      // First tick: sends ping, sets pongReceived to false
      vi.advanceTimersByTime(100)
      // Second tick: pongReceived is still false, should terminate
      vi.advanceTimersByTime(100)

      expect(ws.terminate).toHaveBeenCalled()
    })

    it('does not send ping when socket is not OPEN', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs(SocketState.CLOSING)

      triggerConnection(server, ws)

      vi.advanceTimersByTime(100)

      expect(ws.send).not.toHaveBeenCalled()
    })

    it('sets pongReceived to true when pong event fires', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      // First tick: sends ping
      vi.advanceTimersByTime(100)

      // Simulate pong event from ws
      const pongHandler = ws.on.mock.calls.find(
        ([event]: [string]) => event === 'pong',
      )![1]
      pongHandler()

      // Second tick: should send another ping (not terminate) because pong was received
      vi.advanceTimersByTime(100)

      expect(ws.terminate).not.toHaveBeenCalled()
      expect(ws.send).toHaveBeenCalledTimes(2)
    })
  })

  describe('close', () => {
    it('clears all ping timers and closes open connections', async () => {
      const server = createMockServer()
      const transport = new WebSocketTransport(server, undefined)
      const ws = createMockWs()

      triggerConnection(server, ws)

      await transport.close()

      expect(ws.close).toHaveBeenCalled()
      expect(mockWssClose).toHaveBeenCalled()
    })

    it('does not call ws.close() if socket is not OPEN', async () => {
      const server = createMockServer()
      const transport = new WebSocketTransport(server, undefined)
      const ws = createMockWs(SocketState.CLOSED)

      triggerConnection(server, ws)

      await transport.close()

      expect(ws.close).not.toHaveBeenCalled()
    })

    it('resolves the promise after wss.close completes', async () => {
      const server = createMockServer()
      const transport = new WebSocketTransport(server, undefined)

      const result = await transport.close()
      expect(result).toBeUndefined()
      expect(mockWssClose).toHaveBeenCalled()
    })
  })

  describe('custom path', () => {
    it('uses the custom path from options', () => {
      const server = createMockServer()
      new WebSocketTransport(server, undefined, { path: '/custom-ws' })
      const upgradeHandler = getUpgradeHandler(server)

      const rejectedSocket = {
        destroy: vi.fn(),
        end: vi.fn((_response: string, callback: () => void) => callback()),
        write: vi.fn(),
      }
      const head = Buffer.alloc(0)

      // /typeferry-ws should not match /custom-ws
      mockWssHandleUpgrade.mockImplementationOnce(() => {})
      upgradeHandler({ url: '/typeferry-ws', headers: {} }, rejectedSocket, head)
      expect(mockWssHandleUpgrade).not.toHaveBeenCalled()
      expect(rejectedSocket.end).toHaveBeenCalled()

      // /custom-ws should match
      const ws = createMockWs()
      const acceptedSocket = { destroy: vi.fn(), write: vi.fn() }
      mockWssHandleUpgrade.mockImplementationOnce(
        (_r: any, _s: any, _h: any, cb: Function) => cb(ws),
      )
      upgradeHandler({ url: '/custom-ws', headers: {} }, acceptedSocket, head)
      expect(mockWssHandleUpgrade).toHaveBeenCalled()
    })
  })
})
