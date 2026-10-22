import * as assert from 'assert'
import type { RequestListener } from 'node:http'

import type { Hono } from 'hono'
import type { RedisClientOptions } from 'redis'
import type { z } from 'zod'

import type { MethodParams as MethodParameters, ServerMethods } from '../utils'
import {
  TypeFerryEvents,
  Methods,
  NO_CHANNEL,
  Presentation,
  ServerEvents,
  waitForAll,
} from '../utils'
import { ClientNode } from './client-node'
import type { ClientNodeContext } from './client-node'
import { createMethodProxy } from './create-method-proxy'
import { DefaultMethods } from './default-methods'
import type { Event } from './event'
import type { MethodFunction, MethodOptions } from './method'
import { Method } from './method'
import { ServerChannel } from './server-channel'
import type { TypeFerrySocket } from './types'
import {
  NodeHonoTransport,
  RedisTransport,
  WebSocketTransport,
} from './transports'

declare global {
  var TypeFerry: Server | undefined
}

export type ChannelChecker = (
  node: ClientNode,
  channel: string,
) => Promise<boolean>

export type AuthFunction = (
  this: ClientNode,
  context: ClientNodeContext,
) =>
  | ClientNodeContext
  | false
  | null
  | undefined
  | Promise<ClientNodeContext | false | null | undefined>

/**
 * Configuration for server authentication.
 */
export type AuthSetup<TParameters = unknown, TResult = unknown> = {
  /** Authentication function called to validate tokens */
  auth: AuthFunction
  /** Login method handler */
  logIn: MethodFunction<TParameters, TResult>
}

export type RateLimit =
  | boolean
  | {
      max: number
      interval: number
    }

/** Default request-body ceiling retained across the runtime migration. */
export const DEFAULT_MAX_REQUEST_BODY_SIZE_BYTES = 128 * 1024 * 1024

/**
 * A segment-scoped HTTP body ceiling selected before any body buffering.
 * Matching rules only lower the global ceiling; overlapping rules use the minimum.
 */
export interface RequestBodySizeLimit {
  readonly pathPrefix: string
  readonly maxSize: number
  /**
   * Buffered (the default) rejects chunked overflow before application handlers.
   * Streaming passes bounded chunks to handlers, allowing early authentication;
   * handlers must consume and validate EOF before committing upload side effects.
   * Every matching rule must opt in; any buffered rule retains buffering.
   */
  readonly bodyMode?: 'buffered' | 'streaming'
}

export type ServerOptions = {
  host?: string
  port?: number
  auth?: AuthFunction
  origins?: string[]
  debug?: boolean
  ws?: Record<string, unknown>
  redis?: RedisClientOptions | boolean
  /**
   * Observes Node request metadata and synchronous `data` events without owning
   * transport backpressure. Pausing or reading the observer does not pause Hono.
   */
  requestListener?: RequestListener
  globalInstance?: boolean
  allowedContextKeys?: string[]
  rateLimit?: RateLimit
  /** Maximum request body accepted by the HTTP listener. */
  maxRequestBodySize?: number
  /**
   * Additional route ceilings evaluated by the first HTTP middleware, including
   * requests without Content-Length. Prefixes match complete path segments.
   */
  requestBodySizeLimits?: readonly RequestBodySizeLimit[]
  shouldAllowChannelSubscribe?: ChannelChecker
}

export type ProxyMethodCreation = {
  [key: string]: ProxyMethodCreation
} & any

export class Server<
  Methods extends ServerMethods = ServerMethods,
> extends ServerChannel {
  uuid: string
  httpTransport: NodeHonoTransport
  webSocketTransport: WebSocketTransport
  redisTransport: RedisTransport | null
  host = 'localhost'
  port: number
  requestListener: RequestListener | undefined
  allowedContextKeys: string[]
  isAuthEnabled = false
  auth: AuthFunction | undefined
  debug = false
  rateLimit: RateLimit
  maxRequestBodySize: number

  methods: Map<string, Method<z.ZodType, unknown>> = new Map()
  allClients: Map<string, ClientNode> = new Map()
  private clientsBySocket = new WeakMap<TypeFerrySocket, ClientNode>()
  /** Reverse index: userId → connected client nodes for efficient user-level operations */
  private clientsByUserId: Map<string, Set<ClientNode>> = new Map()
  channels: Map<string, ServerChannel> = new Map()
  events: Map<string, Event> = new Map()

  m: ProxyMethodCreation

  acceptConnections = true

  ready = false

  shouldAllowChannelSubscribe: ChannelChecker = async () => true

  static ERROR_EVENT = 'error'

  public handlers: Methods = {} as Methods

  private closePromise?: Promise<boolean>

  private initializeGlobalInstance(globalInstance: boolean) {
    if (globalInstance) {
      if (global.TypeFerry) {
        throw new Error('There can only be one instance of TypeFerry.')
      }
      global.TypeFerry = this
    }
  }

  private setupHttpListening(): void {
    this.httpTransport.http?.on('error', (error) => {
      this.emit(Server.ERROR_EVENT, error)
    })

    this.httpTransport.listen(() => {
      setTimeout(() => this.emit(ServerEvents.HTTP_LISTENING), 0)
    })
  }

  constructor({
    host = 'localhost',
    port = 80,
    debug = false,
    origins,
    ws,
    redis,
    requestListener,
    globalInstance = true,
    allowedContextKeys = [],
    rateLimit = false,
    maxRequestBodySize = DEFAULT_MAX_REQUEST_BODY_SIZE_BYTES,
    requestBodySizeLimits = [],
  }: ServerOptions = {}) {
    super(NO_CHANNEL)

    this.m = createMethodProxy(this)
    this.setServer(this)
    this.createDefaultMethods()

    this.initializeGlobalInstance(globalInstance)

    assert.ok(host, 'Invalid Host')
    assert.ok(port !== undefined && port !== null, 'Invalid Port')

    this.host = host
    this.port = Number(port)
    this.requestListener = requestListener
    this.debug = debug
    this.uuid = Presentation.uuid()
    this.rateLimit = rateLimit
    this.maxRequestBodySize = maxRequestBodySize
    this.allowedContextKeys = allowedContextKeys

    this.httpTransport = new NodeHonoTransport(
      this,
      origins,
      this.rateLimit,
      this.maxRequestBodySize,
      requestBodySizeLimits,
    )
    this.webSocketTransport = new WebSocketTransport(this, origins, ws)
    this.redisTransport = redis ? new RedisTransport(this, redis) : null
    this.setupHttpListening()

    this.addEvent(TypeFerryEvents.METHOD_REFRESH)
    this.channels.set(NO_CHANNEL, this)

    const readinessEvents = [ServerEvents.HTTP_LISTENING]
    if (this.redisTransport) readinessEvents.push(ServerEvents.REDIS_CONNECT)

    waitForAll(this, readinessEvents)
      .then(() => {
        this.ready = true
        this.emit(ServerEvents.READY, true)
      })
      .catch((error: Error) => {
        console.error('[TypeFerry] Server readiness timeout:', error.message)
      })
  }

  /**
   * Resolves when startup transports have emitted their readiness signals.
   *
   * Already-ready servers must not retain `READY` listeners because callers
   * commonly use this as a low-cost guard before request handling.
   */
  isReady(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.ready) {
        resolve(true)
        return
      }

      this.once(ServerEvents.READY, resolve)
    })
  }

  /**
   * Returns the authoritative Hono application for route registration.
   */
  get app(): Hono {
    return this.httpTransport.app
  }

  setAuth<TParameters, TResult>({
    auth,
    logIn,
  }: AuthSetup<TParameters, TResult>) {
    this.isAuthEnabled = true
    this.auth = auth
    this.addMethod(Methods.RPC_LOGIN, logIn)
  }

  setChannelAuthorization(checker: ChannelChecker) {
    this.shouldAllowChannelSubscribe = checker
  }

  close(): Promise<boolean> {
    this.closePromise ??= this.closeTransports()
    return this.closePromise
  }

  private async closeTransports(): Promise<boolean> {
    this.allClients.forEach((node) => node.close())
    this.allClients.clear()
    this.clientsByUserId.clear()
    this.methods.clear()
    this.channels.clear()

    await this.redisTransport?.close()
    await this.webSocketTransport?.close()
    await this.httpTransport?.close()

    Reflect.deleteProperty(global, 'TypeFerry')

    this.emit(ServerEvents.CLOSED)

    return true
  }

  static(path: string, catchAll: boolean) {
    return this.httpTransport.static(path, catchAll)
  }

  debugger(...args: any[]) {
    if (this.debug) console.debug(...args)
  }

  async call<T = Record<string, unknown>>(
    method: string,
    parameters?: MethodParameters<T>,
  ): Promise<unknown> {
    this.debugger(`[server] Calling ${method}`, parameters)

    const methodInstance = this.methods.get(method)

    if (!methodInstance) {
      throw new Error(`Method not found: ${method}`)
    }

    const node = new ClientNode(this)

    node.isServer = true

    return await methodInstance.exec(parameters, node)
  }

  createDefaultMethods() {
    Object.entries(DefaultMethods).forEach(([key, value]) =>
      this.methods.set(key, value(this, key)),
    )
  }

  getMethod(method: string) {
    return this.methods.get(method)
  }

  addClient(node: ClientNode) {
    this.allClients.set(node.uuid, node)

    if (node.socket) this.clientsBySocket.set(node.socket, node)
  }

  /**
   * Resolves the live client owning a transport socket without scanning peers.
   */
  getClientBySocket(socket: TypeFerrySocket): ClientNode | undefined {
    return this.clientsBySocket.get(socket)
  }

  deleteClient(node: ClientNode) {
    this.allClients.delete(node.uuid)
    this.removeClientFromUserIndex(node)

    if (node.socket) {
      this.clientsBySocket.delete(node.socket)
      this.webSocketTransport?.rooms?.leaveAll(node.socket)
    }
  }

  /** Registers a client node in the userId reverse index */
  indexClientByUserId(node: ClientNode): void {
    if (!node.userId) return

    const userId = String(node.userId)
    let nodes = this.clientsByUserId.get(userId)

    if (!nodes) {
      nodes = new Set()
      this.clientsByUserId.set(userId, nodes)
    }

    nodes.add(node)
  }

  /** Removes a client node from the userId reverse index */
  removeClientFromUserIndex(node: ClientNode): void {
    if (!node.userId) return

    const userId = String(node.userId)
    const nodes = this.clientsByUserId.get(userId)

    if (!nodes) return

    nodes.delete(node)

    if (nodes.size === 0) {
      this.clientsByUserId.delete(userId)
    }
  }

  /** Returns all connected client nodes for a given userId */
  getClientsByUserId(userId: string): ReadonlySet<ClientNode> {
    return this.clientsByUserId.get(userId) ?? new Set<ClientNode>()
  }

  /**
   * Disconnects all WebSocket clients for a userId.
   * Used during session revocation to enforce immediate logout.
   * @returns Number of clients disconnected
   */
  disconnectUser(userId: string, exceptNodeUuid?: string): number {
    const nodes = this.clientsByUserId.get(userId)
    if (!nodes) return 0

    /** Snapshot to avoid mutating the Set during iteration (close → deleteClient) */
    const snapshot = [...nodes]
    let count = 0

    for (const node of snapshot) {
      if (node.uuid === exceptNodeUuid) continue
      node.close()
      count++
    }

    this.emit(ServerEvents.USER_DISCONNECTED, { userId, count })
    return count
  }

  addMethod<T = any, R = any, Schema extends z.ZodType = z.ZodType>(
    method: string,
    fn: MethodFunction<T, R>,
    opts: MethodOptions<Schema> = {},
  ) {
    this.methods.set(method, new Method(this, method, fn, opts))
  }

  channel(name: string | object = NO_CHANNEL): ServerChannel {
    if (
      name != null &&
      typeof name === 'object' &&
      name.constructor.name === 'ObjectId' &&
      typeof name.toString === 'function'
    ) {
      name = name.toString()
    }

    if (!name || typeof name !== 'string') return this
    if (name === NO_CHANNEL) return this

    const channelName = name as string

    const existingChannel = this.channels.get(channelName)
    if (existingChannel) return existingChannel

    const channel = new ServerChannel(channelName)
    channel.setServer(this)
    this.channels.set(channelName, channel)
    return channel
  }
}

export type InferServerMethods<T extends Server<any>> = T['handlers']

export function createServer(options?: ServerOptions) {
  return new Server(options)
}
