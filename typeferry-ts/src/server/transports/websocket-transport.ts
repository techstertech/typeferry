import type http from 'http'
import type { Duplex } from 'stream'
import type WebSocket from 'ws'
import { WebSocketServer } from 'ws'

import {
  TYPEFERRY_WS_PATH,
  isPongMessage,
  isRpcMessage,
  isRpcVoidMessage,
  Presentation,
  ServerEvents,
} from '../../utils'
import { ClientNode } from '../client-node'
import { RoomRegistry } from '../room-registry'
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

const UPGRADE_NOT_FOUND_RESPONSE =
  'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
const UPGRADE_FORBIDDEN_RESPONSE =
  'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'

export interface WebSocketTransportOptions {
  path?: string
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
  rooms = new RoomRegistry()

  private path: string
  private originAllowed: (origin: string | undefined) => boolean
  private handshakeAuthenticator: WebSocketHandshakeAuthenticator | undefined
  private pingTimers = new Map<TypeFerrySocket, ReturnType<typeof setInterval>>()
  private pongReceived = new Map<TypeFerrySocket, boolean>()

  constructor(
    server: Server,
    origins: string[] | undefined,
    opts?: WebSocketTransportOptions,
  ) {
    this.server = server
    this.path = opts?.path ?? TYPEFERRY_WS_PATH
    this.originAllowed = createOriginChecker(origins, opts?.allowOriginless)
    this.handshakeAuthenticator = opts?.handshakeAuthenticator

    this.wss = new WebSocketServer({ noServer: true })
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
        const url = new URL(req.url ?? '', 'http://localhost')

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
    return this.originAllowed(req.headers.origin)
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? '', 'http://localhost')

    const uuid = validateUuid(url.searchParams.get('uuid'))
    const token = url.searchParams.get('token') ?? undefined
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
      this.handleMessage(node, raw)
    })

    ws.on('close', () => {
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

  private handleMessage(node: ClientNode, raw: Buffer | string): void {
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      const msg = Presentation.decode<{ t: string }>(text)

      if (isRpcMessage(msg)) {
        handleRpc(this.server, node, msg.id, msg.method, msg.params)
      } else if (isRpcVoidMessage(msg)) {
        handleRpcVoid(this.server, node, msg.method, msg.params)
      } else if (isPongMessage(msg) && node.socket) {
        this.pongReceived.set(node.socket, true)
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

      if (ws.readyState === SocketState.OPEN) {
        ws.send(PING_PAYLOAD)
      }
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
