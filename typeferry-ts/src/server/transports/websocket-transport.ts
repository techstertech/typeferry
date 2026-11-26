import type http from 'http'
import type { Duplex } from 'stream'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'

import {
  Errors,
  TYPEFERRY_WS_PATH,
  isPongMessage,
  isRpcMessage,
  isRpcVoidMessage,
  Presentation,
  ServerEvents,
} from '../../utils'
import { ClientNode } from '../client-node'
import {
  DEFAULT_MAX_OUTBOUND_BUFFER_BYTES,
  RoomRegistry,
  sendWithinBackpressureLimit,
} from '../room-registry'
import type { Server } from '../server'
import type { TypeFerrySocket } from '../types'
import { SocketState } from '../types'
import type { NodeHonoTransport } from './node-hono-transport'
import { createOriginChecker } from './origin-policy'

import {
  PING_INTERVAL_MS,
  PING_PAYLOAD,
  authenticateNode,
  handleRpc,
  handleRpcVoid,
  parseMeta,
  sendResponse,
  type WebSocketHandshake,
  type WebSocketHandshakeAuthenticator,
  validateUuid,
} from './ws-shared'

export type {
  WebSocketHandshake,
  WebSocketHandshakeAuthenticator,
} from './ws-shared'

export enum WebSocketTransportEvents {
  WEBSOCKET_SERVER_ERROR = 'websocket:server:error',
}

const UPGRADE_BAD_REQUEST_RESPONSE =
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
const UPGRADE_NOT_FOUND_RESPONSE =
  'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
const UPGRADE_FORBIDDEN_RESPONSE =
  'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
const DEFAULT_MAX_WS_PAYLOAD_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENT_RPCS = 64

export interface WebSocketTransportOptions {
  path?: string
  /**
   * Maximum WebSocket message payload size in bytes (defaults to 1 MiB).
   */
  maxPayload?: number
  /**
   * Permits query-string `?token=` authentication (defaults to `true`).
   * Set to `false` when authentication relies on headers or cookies via `handshakeAuthenticator`.
   */
  allowQueryToken?: boolean
  /**
   * Maximum concurrent in-flight RPC/void dispatches per connection (defaults to 64).
   */
  maxConcurrentRpcs?: number
  /**
   * Maximum `bufferedAmount` queued bytes before slow sockets are closed (defaults to 4 MiB).
   */
  maxOutboundBufferBytes?: number
  /**
   * Admits an absent Origin under a configured allowlist.
   * This does not change HTTP RPC admission or permit mismatching origins.
   */
  allowOriginless?: boolean
  /**
   * Application-owned handshake auth; rejection never falls back to token auth.
   */
  handshakeAuthenticator?: WebSocketHandshakeAuthenticator
  cors?: {
    credentials?: boolean
    origin?: string | string[]
  }
}

/**
 * Node.js WebSocket transport using the `ws` package.
 */
export class WebSocketTransport {
  server: Server
  wss: WebSocketServer
  rooms: RoomRegistry

  private path: string
  private originAllowed: (origin: string | undefined) => boolean
  private allowQueryToken: boolean
  private maxConcurrentRpcs: number
  readonly maxOutboundBufferBytes: number
  private handshakeAuthenticator: WebSocketHandshakeAuthenticator | undefined
  private pingTimers = new Map<TypeFerrySocket, ReturnType<typeof setInterval>>()
  private pongReceived = new Map<TypeFerrySocket, boolean>()
  private inFlightRpcs = new Map<TypeFerrySocket, number>()

  constructor(
    server: Server,
    origins: string[] | undefined,
    opts?: WebSocketTransportOptions,
  ) {
    if (origins === undefined && process.env.NODE_ENV === 'production') {
      console.warn(
        '[TypeFerry] WebSocket transport started without an origins allowlist in production',
      )
    }
    const maxConcurrent = opts?.maxConcurrentRpcs ?? DEFAULT_MAX_CONCURRENT_RPCS
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrentRpcs must be a positive integer')
    }
    const maxOutbound =
      opts?.maxOutboundBufferBytes ?? DEFAULT_MAX_OUTBOUND_BUFFER_BYTES
    if (!Number.isFinite(maxOutbound) || maxOutbound <= 0) {
      throw new Error('maxOutboundBufferBytes must be a positive finite number')
    }

    this.server = server
    this.path = opts?.path ?? TYPEFERRY_WS_PATH
    this.allowQueryToken = opts?.allowQueryToken ?? true
    this.maxConcurrentRpcs = maxConcurrent
    this.maxOutboundBufferBytes = maxOutbound
    this.rooms = new RoomRegistry({ maxOutboundBufferBytes: maxOutbound })
    this.originAllowed = createOriginChecker(origins, opts?.allowOriginless)
    this.handshakeAuthenticator = opts?.handshakeAuthenticator

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: opts?.maxPayload ?? DEFAULT_MAX_WS_PAYLOAD_BYTES,
    })
    this.wss.on('error', (error: Error) =>
      server.emit(WebSocketTransportEvents.WEBSOCKET_SERVER_ERROR, error),
    )

    this.attachUpgradeHandler()
  }

  private attachUpgradeHandler(): void {
    const httpTransport = this.server.httpTransport as NodeHonoTransport
    if (!httpTransport.http) {
      throw new Error('HTTP transport must exist before WebSocket attachment')
    }
    httpTransport.http.on(
      'upgrade',
      (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        let url: URL
        try {
          url = new URL(req.url ?? '', 'http://localhost')
        } catch {
          this.rejectUpgrade(socket, UPGRADE_BAD_REQUEST_RESPONSE)
          return
        }

        if (url.pathname !== this.path) {
          this.rejectUpgrade(socket, UPGRADE_NOT_FOUND_RESPONSE)
          return
        }

        if (!this.server.acceptConnections) {
          socket.destroy()
          return
        }

        if (!this.validateOrigin(req)) {
          this.rejectUpgrade(socket, UPGRADE_FORBIDDEN_RESPONSE)
          return
        }

        this.wss.handleUpgrade(req, socket, head, ws => {
          this.handleConnection(ws, req)
        })
      },
    )
  }

  /** Flushes the HTTP rejection and then closes both halves of the raw socket. */
  private rejectUpgrade(socket: Duplex, response: string): void {
    socket.end(response, () => socket.destroy())
  }

  private validateOrigin(req: http.IncomingMessage): boolean {
    if (Array.isArray(req.rawHeaders)) {
      let originCount = 0
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() === 'origin') {
          originCount += 1
          if (originCount > 1) return false
        }
      }
    }
    return this.originAllowed(req.headers.origin)
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    let url: URL
    try {
      url = new URL(req.url ?? '', 'http://localhost')
    } catch {
      ws.close()
      return
    }

    let uuid = validateUuid(url.searchParams.get('uuid'))
    if (this.server.allClients?.has(uuid)) {
      uuid = Presentation.uuid()
    }
    const token = this.allowQueryToken
      ? (url.searchParams.get('token') ?? undefined)
      : undefined
    const meta = parseMeta(url.searchParams.get('meta'))
    const handshake: WebSocketHandshake = {
      path: url.pathname,
      headers: Object.fromEntries(
        Object.entries(req.headers).flatMap(([name, value]) => {
          if (typeof value === 'string') return [[name, value]]
          if (Array.isArray(value)) return [[name, value.join(', ')]]
          return []
        }),
      ),
      query: Object.fromEntries(url.searchParams.entries()),
    }

    const node = new ClientNode(
      this.server,
      ws,
      undefined,
      undefined,
      this.server.rateLimit,
    )

    node.setId(uuid)
    node.meta = meta
    node.setTrackingProperties({
      headers: req.headers,
      ...(req.socket?.remoteAddress === undefined
        ? {}
        : { socket: { remoteAddress: req.socket.remoteAddress } }),
    })

    this.server.addClient(node)
    this.server.emit(ServerEvents.CONNECTION, node)

    ws.on('message', (raw: Buffer | string) => {
      this.handleMessage(node, raw, ws)
    })

    ws.on('close', () => {
      this.inFlightRpcs.delete(ws)
      this.stopPing(ws)
      this.rooms.leaveAll(ws)
      node.close()
      this.server.deleteClient(node)
    })

    ws.on('error', (error: Error) => {
      this.server.emit(ServerEvents.SOCKET_ERROR, ws, error)
    })

    this.startPing(ws)
    authenticateNode(
      this.server,
      node,
      token,
      this.handshakeAuthenticator,
      handshake,
    )
  }

  private handleMessage(
    node: ClientNode,
    raw: Buffer | string,
    ws: WebSocket,
  ): void {
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      const msg = Presentation.decode<{ t: string }>(text)

      if (isRpcMessage(msg)) {
        const current = this.inFlightRpcs.get(ws) ?? 0
        if (current >= this.maxConcurrentRpcs) {
          sendResponse(
            node,
            msg.id,
            undefined,
            Errors.RATE_LIMIT_EXCEEDED,
            undefined,
            this.maxOutboundBufferBytes,
          )
          return
        }
        this.inFlightRpcs.set(ws, current + 1)
        void handleRpc(this.server, node, msg.id, msg.method, msg.params)
          .catch(() => undefined)
          .finally(() => {
            const remaining = (this.inFlightRpcs.get(ws) ?? 1) - 1
            if (remaining <= 0) this.inFlightRpcs.delete(ws)
            else this.inFlightRpcs.set(ws, remaining)
          })
      } else if (isRpcVoidMessage(msg)) {
        const current = this.inFlightRpcs.get(ws) ?? 0
        if (current >= this.maxConcurrentRpcs) {
          console.warn(
            '[TypeFerry] Concurrent RPC limit exceeded for void call:',
            msg.method,
          )
          return
        }
        this.inFlightRpcs.set(ws, current + 1)
        void handleRpcVoid(this.server, node, msg.method, msg.params)
          .catch(() => undefined)
          .finally(() => {
            const remaining = (this.inFlightRpcs.get(ws) ?? 1) - 1
            if (remaining <= 0) this.inFlightRpcs.delete(ws)
            else this.inFlightRpcs.set(ws, remaining)
          })
      } else if (isPongMessage(msg)) {
        this.pongReceived.set(ws, true)
      }
    } catch {
      // Malformed message — ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Ping / Pong keep-alive
  // ---------------------------------------------------------------------------

  private startPing(ws: WebSocket): void {
    this.pongReceived.set(ws, true)

    const timer = setInterval(() => {
      if (!this.pongReceived.get(ws)) {
        ws.terminate()
        return
      }

      this.pongReceived.set(ws, false)

      sendWithinBackpressureLimit(
        ws,
        PING_PAYLOAD,
        this.maxOutboundBufferBytes,
      )
    }, PING_INTERVAL_MS)

    this.pingTimers.set(ws, timer)

    ws.on('pong', () => {
      this.pongReceived.set(ws, true)
    })
  }

  private stopPing(ws: WebSocket): void {
    const timer = this.pingTimers.get(ws)
    if (timer) {
      clearInterval(timer)
      this.pingTimers.delete(ws)
    }
    this.pongReceived.delete(ws)
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      for (const [ws, timer] of this.pingTimers) {
        clearInterval(timer)
        if (ws.readyState === SocketState.OPEN) ws.close()
      }
      this.pingTimers.clear()
      this.pongReceived.clear()

      this.wss.close(error => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' &&
          error.message !== 'The server is not running'
        ) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
}
