import { RateLimiter } from 'limiter'

import { MessageType, NO_CHANNEL, Presentation, ServerEvents } from '../utils'
import EventEmitter2 from '../utils/event-emitter'
import type { TypeFerryRequest, TypeFerryResponse } from './request-types'
import type { RateLimit, Server } from './server'
import type { TypeFerrySendState, TypeFerrySocket } from './types'
import { SocketState } from './types'

export interface ClientNodeUser extends Record<string, unknown> {
  _id?: unknown
  email?: unknown
}

export interface ClientNodeContext extends Record<string, unknown> {
  token?: string
  user?: ClientNodeUser
}

export class ClientNode extends EventEmitter2 {
  uuid = ''
  isAuthenticated = false
  meta: Record<string, unknown> = {}
  context: ClientNodeContext | null = {}
  userId: string | null = null
  user: ClientNodeUser | null = null
  socket: TypeFerrySocket | null | undefined
  /** Framework-agnostic request exposed by the Hono adapter. */
  req: TypeFerryRequest | undefined
  /** Framework-agnostic response exposed by the Hono adapter. */
  res: TypeFerryResponse | undefined
  isServer = false
  limiter: RateLimiter | null | undefined
  server: Server
  headers: Record<string, string> = {}
  remoteAddress: string | string[] = ''
  userAgent = ''

  constructor(
    server: Server,
    socket?: TypeFerrySocket | null,
    req?: TypeFerryRequest,
    res?: TypeFerryResponse,
    limit?: RateLimit
  ) {
    super()

    this.server = server
    this.socket = socket
    this.req = req
    this.res = res

    if (limit) {
      this.limiter = new RateLimiter(
        limit === true
          ? {
              tokensPerInterval: 60,
              interval: 60 * 1000,
            }
          : {
              tokensPerInterval: limit.max,
              interval: limit.interval,
            }
      )
    }
  }

  get authenticated() {
    return this.isAuthenticated
  }

  set authenticated(authenticated: boolean) {
    this.isAuthenticated = authenticated
    if (!authenticated) this.setContext(null)
  }

  get readyState(): number | undefined {
    return this.socket?.readyState
  }

  setId(uuid: string) {
    this.uuid = uuid
  }

  setContext(context: ClientNodeContext | null) {
    this.clearUserIdentity()
    this.context = this.authenticated ? context : {}

    this.setUserId()
  }

  /**
   * Extracts tracking properties (headers, IP, user-agent) from a request.
   * Accepts both Node `IncomingMessage` and the framework-agnostic `TypeFerryRequest`.
   * Uses the transport peer without promoting untrusted forwarding headers.
   */
  setTrackingProperties(source: {
    headers?: Record<string, string | string[] | undefined>
    ip?: string
    socket?: { remoteAddress?: string }
  }): void {
    this.headers = Object.fromEntries(
      Object.entries(source.headers ?? {}).flatMap(([name, value]) =>
        typeof value === 'string' ? [[name, value]] : [],
      ),
    )
    const userAgent = source.headers?.['user-agent']
    this.userAgent = typeof userAgent === 'string' ? userAgent : ''
    this.remoteAddress = source.socket?.remoteAddress ?? source.ip ?? ''
  }

  /**
   * Refreshes the optional identity used for user-scoped delivery.
   * Authenticated contexts without a user ID remain valid and unindexed.
   */
  setUserId() {
    this.clearUserIdentity()
    if (!this.authenticated) return

    const user = this.context?.user
    const userId = user?._id

    if (!userId) return

    this.userId = String(userId)
    this.user = user
    this.server.indexClientByUserId(this)
  }

  private clearUserIdentity(): void {
    if (this.userId !== null) this.server.removeClientFromUserIndex(this)

    this.userId = null
    this.user = null
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WebSocket Message Emitters
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sends a push event to the client.
   * Uses the wire protocol `{ t: "event", ... }` envelope.
   */
  emitTypeFerryEvent(
    event: string,
    channel: string = NO_CHANNEL,
    params?: unknown,
  ): void {
    this.sendTypeFerryEvent(event, channel, params)
  }

  /**
   * Sends a push event and returns the native transport pressure.
   *
   * Live data delivery uses this result to avoid hiding slow consumers behind
   * the WebSocket runtime's own queue.
   */
  sendTypeFerryEvent(
    event: string,
    channel: string = NO_CHANNEL,
    params?: unknown
  ): TypeFerrySendState {
    if (!this.socket || this.socket.readyState !== SocketState.OPEN) {
      return { accepted: false, bufferedBytes: this.bufferedBytes }
    }

    try {
      this.socket.send(
        Presentation.encode({
          t: MessageType.EVENT,
          uuid: Presentation.uuid(),
          event,
          channel,
          params,
        })
      )
    } catch {
      return { accepted: false, bufferedBytes: this.bufferedBytes }
    }

    return { accepted: true, bufferedBytes: this.bufferedBytes }
  }

  /** Whether the transport exposes native queued-byte pressure. */
  get supportsBufferedBytes(): boolean {
    return typeof this.socket?.bufferedAmount === 'number'
  }

  /** Returns native bytes queued by the WebSocket runtime without sending. */
  get bufferedBytes(): number {
    try {
      return this.socket?.bufferedAmount ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Sends an error to the client.
   */
  emitError(payload: {
    uuid?: string
    message: string
    method?: string
    errors?: unknown
  }): void {
    if (!this.socket || this.socket.readyState !== SocketState.OPEN) return

    this.socket.send(Presentation.encode(payload))
  }

  /**
   * Sends authentication result to the client.
   * Uses the wire protocol `{ t: "auth", ... }` envelope.
   */
  emitAuthResult(authenticated: boolean): void {
    if (!this.socket || this.socket.readyState !== SocketState.OPEN) return

    this.socket.send(
      Presentation.encode({ t: MessageType.AUTH, authenticated })
    )
  }

  /** Idempotency guard — prevents duplicate DISCONNECT events. */
  private closed = false

  close(): void {
    if (this.closed) return
    this.closed = true

    if (this.socket) {
      this.socket.close()
    }

    this.emit(ServerEvents.DISCONNECT)
    this.server.emit(ServerEvents.DISCONNECTION, this)
  }
}
